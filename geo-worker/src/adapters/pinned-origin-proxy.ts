import { createServer, connect, isIP, type Server, type Socket } from "node:net";

const MAX_CLIENT_CONNECTIONS = 8;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_TLS_CLIENT_HELLO_BYTES = 64 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_IDLE_TIMEOUT_MS = 75_000;

export type PinnedOrigin = {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  address: string;
  family: 4 | 6;
};

export type PinnedOriginProxy = {
  port: number;
  close(): Promise<void>;
};

type ParsedProxyRequest = {
  method: string;
  target: string;
  version: string;
  headers: Array<{ name: string; lowerName: string; value: string }>;
};

function effectivePort(url: URL) {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function matchesOrigin(url: URL, origin: PinnedOrigin) {
  return (
    url.protocol === origin.protocol &&
    url.username === "" &&
    url.password === "" &&
    url.hostname.toLowerCase() === origin.hostname &&
    effectivePort(url) === origin.port
  );
}

function authorityMatchesOrigin(value: string, origin: PinnedOrigin) {
  try {
    const url = new URL(`${origin.protocol}//${value}`);
    return (
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      matchesOrigin(url, origin)
    );
  } catch {
    return false;
  }
}

function parseRequest(header: string): ParsedProxyRequest | null {
  const lines = header.split("\r\n");
  const [requestLine, ...headerLines] = lines;
  if (requestLine === undefined) return null;
  const [method, target, version, extra] = requestLine.split(" ");
  if (
    method === undefined ||
    target === undefined ||
    version !== "HTTP/1.1" ||
    extra !== undefined
  ) {
    return null;
  }

  const headers: ParsedProxyRequest["headers"] = [];
  const seen = new Set<string>();
  for (const line of headerLines) {
    if (line === "") break;
    const separator = line.indexOf(":");
    if (separator <= 0) return null;
    const name = line.slice(0, separator);
    const lowerName = name.toLowerCase();
    if (seen.has(lowerName)) return null;
    seen.add(lowerName);
    headers.push({ name, lowerName, value: line.slice(separator + 1).trim() });
  }
  return { method, target, version, headers };
}

function sendError(socket: Socket, status: number, reason: string) {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function setIdleTimeout(socket: Socket) {
  socket.setTimeout(REQUEST_IDLE_TIMEOUT_MS);
  socket.once("timeout", () => socket.destroy());
}

async function connectPinned(
  origin: PinnedOrigin,
  upstreamSockets: Set<Socket>,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const upstream = connect({
      host: origin.address,
      port: origin.port,
      family: origin.family,
    });
    upstreamSockets.add(upstream);
    upstream.on("close", () => upstreamSockets.delete(upstream));

    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      upstream.destroy();
      reject(error);
    };
    upstream.once("error", fail);
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error("pinned origin connection timed out")));
    upstream.once("connect", () => {
      if (settled) return;
      settled = true;
      upstream.setTimeout(REQUEST_IDLE_TIMEOUT_MS, () => upstream.destroy());
      resolve(upstream);
    });
  });
}

function hostHeaderMatches(request: ParsedProxyRequest, origin: PinnedOrigin) {
  const host = request.headers.find((header) => header.lowerName === "host");
  return host !== undefined && authorityMatchesOrigin(host.value, origin);
}

type TlsClientHelloResult =
  | { kind: "incomplete" }
  | { kind: "invalid" }
  | { kind: "valid"; serverName: string };

type ReceivedTlsClientHello = TlsClientHelloResult & { raw: Buffer };

function readUint16(buffer: Buffer, offset: number) {
  return buffer.readUInt16BE(offset);
}

function readUint24(buffer: Buffer, offset: number) {
  return (buffer[offset]! << 16) | (buffer[offset + 1]! << 8) | buffer[offset + 2]!;
}

function parseClientHelloBody(body: Buffer): TlsClientHelloResult {
  if (body.byteLength < 35) return { kind: "invalid" };
  let offset = 34;
  const sessionLength = body[offset]!;
  offset += 1 + sessionLength;
  if (offset + 2 > body.byteLength) return { kind: "invalid" };
  const cipherSuitesLength = readUint16(body, offset);
  offset += 2 + cipherSuitesLength;
  if (cipherSuitesLength === 0 || cipherSuitesLength % 2 !== 0 || offset + 1 > body.byteLength) {
    return { kind: "invalid" };
  }
  const compressionLength = body[offset]!;
  offset += 1 + compressionLength;
  if (compressionLength === 0 || offset + 2 > body.byteLength) return { kind: "invalid" };
  const extensionsLength = readUint16(body, offset);
  offset += 2;
  const extensionsEnd = offset + extensionsLength;
  if (extensionsEnd !== body.byteLength) return { kind: "invalid" };

  let serverName: string | null = null;
  while (offset < extensionsEnd) {
    if (offset + 4 > extensionsEnd) return { kind: "invalid" };
    const extensionType = readUint16(body, offset);
    const extensionLength = readUint16(body, offset + 2);
    offset += 4;
    const extensionEnd = offset + extensionLength;
    if (extensionEnd > extensionsEnd) return { kind: "invalid" };
    if (extensionType === 0) {
      if (serverName !== null || extensionLength < 5) return { kind: "invalid" };
      const namesLength = readUint16(body, offset);
      let nameOffset = offset + 2;
      const namesEnd = nameOffset + namesLength;
      if (namesEnd !== extensionEnd) return { kind: "invalid" };
      while (nameOffset < namesEnd) {
        if (nameOffset + 3 > namesEnd || body[nameOffset] !== 0) return { kind: "invalid" };
        const nameLength = readUint16(body, nameOffset + 1);
        nameOffset += 3;
        if (nameLength === 0 || nameOffset + nameLength > namesEnd || serverName !== null) {
          return { kind: "invalid" };
        }
        const encodedName = body.subarray(nameOffset, nameOffset + nameLength);
        if (encodedName.some((byte) => byte < 0x21 || byte > 0x7e)) return { kind: "invalid" };
        serverName = encodedName.toString("ascii").toLowerCase();
        nameOffset += nameLength;
      }
    }
    offset = extensionEnd;
  }
  return serverName === null ? { kind: "invalid" } : { kind: "valid", serverName };
}

function parseClientHello(buffer: Buffer): TlsClientHelloResult {
  let recordOffset = 0;
  let handshake = Buffer.alloc(0);
  while (recordOffset < buffer.byteLength) {
    if (buffer.byteLength - recordOffset < 5) return { kind: "incomplete" };
    if (buffer[recordOffset] !== 0x16) return { kind: "invalid" };
    const recordLength = readUint16(buffer, recordOffset + 3);
    const recordEnd = recordOffset + 5 + recordLength;
    if (recordEnd > MAX_TLS_CLIENT_HELLO_BYTES) return { kind: "invalid" };
    if (recordEnd > buffer.byteLength) return { kind: "incomplete" };
    handshake = Buffer.concat([handshake, buffer.subarray(recordOffset + 5, recordEnd)]);
    if (handshake.byteLength > MAX_TLS_CLIENT_HELLO_BYTES) return { kind: "invalid" };
    if (handshake.byteLength >= 4) {
      if (handshake[0] !== 1) return { kind: "invalid" };
      const bodyLength = readUint24(handshake, 1);
      if (bodyLength > MAX_TLS_CLIENT_HELLO_BYTES - 4) return { kind: "invalid" };
      if (handshake.byteLength >= bodyLength + 4) {
        return parseClientHelloBody(handshake.subarray(4, bodyLength + 4));
      }
    }
    recordOffset = recordEnd;
  }
  return { kind: "incomplete" };
}

async function waitForClientHello(client: Socket, remainder: Buffer): Promise<ReceivedTlsClientHello> {
  return new Promise((resolve) => {
    let received = Buffer.from(remainder);
    let settled = false;
    const timer = setTimeout(() => finish({ kind: "invalid" }), CONNECT_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk], received.byteLength + chunk.byteLength);
      inspect();
    };
    const onClosed = () => finish({ kind: "invalid" });
    const finish = (result: TlsClientHelloResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off("data", onData);
      client.off("error", onClosed);
      client.off("end", onClosed);
      client.off("close", onClosed);
      resolve({ ...result, raw: received });
    };
    const inspect = () => {
      if (received.byteLength > MAX_TLS_CLIENT_HELLO_BYTES) {
        finish({ kind: "invalid" });
        return;
      }
      const result = parseClientHello(received);
      if (result.kind !== "incomplete") finish(result);
    };

    client.on("data", onData);
    client.once("error", onClosed);
    client.once("end", onClosed);
    client.once("close", onClosed);
    inspect();
    if (!settled) client.resume();
  });
}

async function forwardConnect(
  client: Socket,
  request: ParsedProxyRequest,
  remainder: Buffer,
  origin: PinnedOrigin,
  upstreamSockets: Set<Socket>,
) {
  if (
    origin.protocol !== "https:" ||
    !authorityMatchesOrigin(request.target, origin) ||
    !hostHeaderMatches(request, origin)
  ) {
    sendError(client, 403, "Forbidden");
    return;
  }

  // The proxy acknowledgement is required before a standards-compliant TLS client
  // sends its ClientHello. Keep the target unopened until its SNI is validated.
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  const clientHello = await waitForClientHello(client, remainder);
  if (
    client.destroyed ||
    clientHello.kind !== "valid" ||
    clientHello.serverName !== origin.hostname
  ) {
    client.end();
    return;
  }

  let upstream: Socket;
  try {
    upstream = await connectPinned(origin, upstreamSockets);
  } catch {
    sendError(client, 502, "Bad Gateway");
    return;
  }
  upstream.once("error", () => client.destroy());
  client.once("error", () => upstream.destroy());
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.end());
  // This leaves the client in control of TLS to the original hostname, including SNI.
  upstream.write(clientHello.raw);
  client.pipe(upstream);
  upstream.pipe(client);
  setIdleTimeout(client);
  client.resume();
}

async function forwardHttp(
  client: Socket,
  request: ParsedProxyRequest,
  remainder: Buffer,
  origin: PinnedOrigin,
  upstreamSockets: Set<Socket>,
) {
  if ((request.method !== "GET" && request.method !== "HEAD") || remainder.byteLength > 0) {
    sendError(client, 405, "Method Not Allowed");
    return;
  }
  let target: URL;
  try {
    target = new URL(request.target);
  } catch {
    sendError(client, 403, "Forbidden");
    return;
  }
  if (!matchesOrigin(target, origin) || !hostHeaderMatches(request, origin)) {
    sendError(client, 403, "Forbidden");
    return;
  }

  let upstream: Socket;
  try {
    upstream = await connectPinned(origin, upstreamSockets);
  } catch {
    sendError(client, 502, "Bad Gateway");
    return;
  }
  const forwardedHeaders = request.headers
    .filter((header) => !["connection", "keep-alive", "proxy-authorization", "proxy-connection"].includes(header.lowerName))
    .map((header) => `${header.name}: ${header.value}`)
    .join("\r\n");
  const path = `${target.pathname}${target.search}`;
  const forwardedRequest = `${request.method} ${path} ${request.version}\r\n${forwardedHeaders}\r\nConnection: close\r\n\r\n`;

  upstream.once("error", () => client.destroy());
  client.once("error", () => upstream.destroy());
  client.once("close", () => upstream.destroy());
  upstream.pipe(client);
  upstream.end(forwardedRequest);
  setIdleTimeout(client);
  client.resume();
}

function handleClient(
  client: Socket,
  origin: PinnedOrigin,
  clientSockets: Set<Socket>,
  upstreamSockets: Set<Socket>,
) {
  if (clientSockets.size >= MAX_CLIENT_CONNECTIONS) {
    sendError(client, 503, "Service Unavailable");
    return;
  }
  clientSockets.add(client);
  client.once("close", () => clientSockets.delete(client));
  const onInitialTimeout = () => sendError(client, 408, "Request Timeout");
  client.setTimeout(CONNECT_TIMEOUT_MS);
  client.once("timeout", onInitialTimeout);

  let received = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    received = Buffer.concat([received, chunk], received.byteLength + chunk.byteLength);
    if (received.byteLength > MAX_HEADER_BYTES) {
      client.off("data", onData);
      sendError(client, 431, "Request Header Fields Too Large");
      return;
    }
    const boundary = received.indexOf("\r\n\r\n");
    if (boundary === -1) return;
    client.off("data", onData);
    client.pause();
    client.off("timeout", onInitialTimeout);
    client.setTimeout(0);
    const request = parseRequest(received.subarray(0, boundary + 4).toString("latin1"));
    if (request === null) {
      sendError(client, 400, "Bad Request");
      return;
    }
    const remainder = received.subarray(boundary + 4);
    if (request.method === "CONNECT") {
      void forwardConnect(client, request, remainder, origin, upstreamSockets);
    } else {
      void forwardHttp(client, request, remainder, origin, upstreamSockets);
    }
  };
  client.on("data", onData);
  client.once("error", () => client.destroy());
}

export async function startPinnedOriginProxy(origin: PinnedOrigin): Promise<PinnedOriginProxy> {
  if (isIP(origin.address) !== origin.family) {
    throw new Error("pinned origin address must be a matching literal IP address");
  }
  const clientSockets = new Set<Socket>();
  const upstreamSockets = new Set<Socket>();
  const server = createServer((client) => handleClient(client, origin, clientSockets, upstreamSockets));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("pinned origin proxy did not bind a TCP port");
  }

  return {
    port: address.port,
    async close() {
      for (const socket of clientSockets) socket.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
