import { once } from "node:events";
import { createServer, connect, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startPinnedOriginProxy, type PinnedOriginProxy } from "./pinned-origin-proxy";

const openResources: Array<{ close: () => Promise<void> }> = [];

async function listen(server: Server) {
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind TCP");
  return address.port;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function openSocket(port: number) {
  const socket = connect({ host: "127.0.0.1", port });
  await once(socket, "connect");
  return socket;
}

async function readUntil(socket: Socket, marker: string) {
  return new Promise<string>((resolve, reject) => {
    let received = "";
    const timeout = setTimeout(() => finish(new Error("proxy response timed out")), 2_000);
    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.includes(marker)) finish();
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error(`proxy closed before ${marker}`));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      if (error === undefined) resolve(received);
      else reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

async function echoServer() {
  const server = createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
  });
  return { server, port: await listen(server) };
}

afterEach(async () => {
  while (openResources.length > 0) await openResources.pop()!.close();
});

describe("pinned origin proxy", () => {
  it("rejects a non-literal pinned address before it can trigger DNS", async () => {
    await expect(startPinnedOriginProxy({
      protocol: "https:",
      hostname: "audit.example",
      port: 443,
      address: "resolver.example",
      family: 4,
    })).rejects.toThrow("literal IP address");
  });

  it("forwards an allowed HTTPS CONNECT to the one pinned address", async () => {
    const upstream = await echoServer();
    openResources.push({ close: () => closeServer(upstream.server) });
    const proxy = await startPinnedOriginProxy({
      protocol: "https:",
      hostname: "audit.example",
      port: upstream.port,
      address: "127.0.0.1",
      family: 4,
    });
    openResources.push(proxy);
    const socket = await openSocket(proxy.port);

    socket.write(
      `CONNECT audit.example:${upstream.port} HTTP/1.1\r\nHost: audit.example:${upstream.port}\r\n\r\n`,
    );
    const response = await readUntil(socket, "\r\n\r\n");
    expect(response).toContain("200 Connection Established");
    expect(response).not.toMatch(/\r\nconnection:\s*close/i);
    const tunneled = readUntil(socket, "tls-bytes");
    socket.write("tls-bytes");
    await expect(tunneled).resolves.toContain("tls-bytes");
    socket.destroy();
  });

  it("rejects foreign CONNECT authorities and ports without opening an upstream tunnel", async () => {
    const upstream = await echoServer();
    let upstreamConnections = 0;
    upstream.server.on("connection", () => {
      upstreamConnections += 1;
    });
    openResources.push({ close: () => closeServer(upstream.server) });
    const proxy = await startPinnedOriginProxy({
      protocol: "https:",
      hostname: "audit.example",
      port: upstream.port,
      address: "127.0.0.1",
      family: 4,
    });
    openResources.push(proxy);

    for (const authority of ["foreign.example", "audit.example"]) {
      const socket = await openSocket(proxy.port);
      const port = authority === "foreign.example" ? upstream.port : upstream.port + 1;
      socket.write(`CONNECT ${authority}:${port} HTTP/1.1\r\nHost: ${authority}:${port}\r\n\r\n`);
      await expect(readUntil(socket, "\r\n\r\n")).resolves.toContain("403 Forbidden");
      socket.destroy();
    }

    expect(upstreamConnections).toBe(0);
  });

  it("forwards only same-origin HTTP requests and preserves their Host header", async () => {
    let received = "";
    const upstream = createServer((socket) => {
      socket.once("data", (chunk) => {
        received = chunk.toString("utf8");
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
      });
    });
    const port = await listen(upstream);
    openResources.push({ close: () => closeServer(upstream) });
    const proxy: PinnedOriginProxy = await startPinnedOriginProxy({
      protocol: "http:",
      hostname: "audit.example",
      port,
      address: "127.0.0.1",
      family: 4,
    });
    openResources.push(proxy);
    const socket = await openSocket(proxy.port);

    socket.write(`GET http://audit.example:${port}/audit?q=1 HTTP/1.1\r\nHost: audit.example:${port}\r\n\r\n`);
    await expect(readUntil(socket, "ok")).resolves.toContain("200 OK");
    expect(received).toContain("GET /audit?q=1 HTTP/1.1");
    expect(received).toContain(`Host: audit.example:${port}`);
    socket.destroy();
  });
});
