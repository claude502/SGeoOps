import { lookup as defaultLookup } from "node:dns/promises";
import { isIP } from "node:net";

export class PublicOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicOriginError";
  }
}

export type PublicOriginLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export type PublicOrigin = {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  includeRegex: string;
};

export type ResolvedPublicAddress = { address: string; family: 4 | 6 };

function unbracket(address: string) {
  return address.startsWith("[") && address.endsWith("]")
    ? address.slice(1, -1)
    : address;
}

function isGloballyRoutableIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second, third] = octets;
  if (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  ) {
    return false;
  }
  return true;
}

type Ipv6Cidr = { network: Uint8Array; prefixLength: number };

function parseIpv6Bytes(address: string): Uint8Array | null {
  if (isIP(address) !== 6) return null;
  const compression = address.indexOf("::");
  if (compression !== -1 && address.indexOf("::", compression + 1) !== -1) return null;

  const parseSection = (section: string): number[] | null => {
    if (section === "") return [];
    const parts = section.split(":");
    const hextets: number[] = [];
    for (const [index, part] of parts.entries()) {
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const octets = part.split(".").map(Number);
        if (
          octets.length !== 4 ||
          octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
        ) {
          return null;
        }
        hextets.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      hextets.push(Number.parseInt(part, 16));
    }
    return hextets;
  };

  const left = compression === -1 ? address : address.slice(0, compression);
  const right = compression === -1 ? "" : address.slice(compression + 2);
  const leading = parseSection(left);
  const trailing = parseSection(right);
  if (leading === null || trailing === null) return null;
  const omitted = 8 - leading.length - trailing.length;
  if ((compression === -1 && omitted !== 0) || (compression !== -1 && omitted < 1)) return null;
  const hextets = [...leading, ...Array<number>(Math.max(0, omitted)).fill(0), ...trailing];
  if (hextets.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (const [index, hextet] of hextets.entries()) {
    bytes[index * 2] = hextet >>> 8;
    bytes[index * 2 + 1] = hextet & 0xff;
  }
  return bytes;
}

function ipv6Cidr(network: string, prefixLength: number): Ipv6Cidr {
  const parsed = parseIpv6Bytes(network);
  if (parsed === null || prefixLength < 0 || prefixLength > 128) {
    throw new Error("invalid static IPv6 CIDR");
  }
  return { network: parsed, prefixLength };
}

function matchesIpv6Cidr(address: Uint8Array, cidr: Ipv6Cidr) {
  const wholeBytes = Math.floor(cidr.prefixLength / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (address[index] !== cidr.network[index]) return false;
  }
  const remainingBits = cidr.prefixLength % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (address[wholeBytes]! & mask) === (cidr.network[wholeBytes]! & mask);
}

const NON_GLOBAL_IPV6_CIDRS = [
  ipv6Cidr("::", 128),
  ipv6Cidr("::1", 128),
  ipv6Cidr("::ffff:0:0", 96),
  ipv6Cidr("64:ff9b::", 96),
  ipv6Cidr("64:ff9b:1::", 48),
  ipv6Cidr("100::", 64),
  ipv6Cidr("2001::", 23),
  ipv6Cidr("2001:db8::", 32),
  ipv6Cidr("2002::", 16),
  ipv6Cidr("3fff::", 20),
  ipv6Cidr("fc00::", 7),
  ipv6Cidr("fe80::", 10),
  ipv6Cidr("ff00::", 8),
] as const;

function isGloballyRoutableIpv6(address: string) {
  const bytes = parseIpv6Bytes(address);
  if (bytes === null || bytes[0]! < 0x20 || bytes[0]! > 0x3f) return false;
  return !NON_GLOBAL_IPV6_CIDRS.some((cidr) => matchesIpv6Cidr(bytes, cidr));
}

function isGloballyRoutableAddress(address: string, family: number) {
  const ipFamily = isIP(address);
  if (ipFamily === 0 || ipFamily !== family) return false;
  return ipFamily === 4
    ? isGloballyRoutableIpv4(address)
    : isGloballyRoutableIpv6(address);
}

function escapePcreLiteral(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

function originRegex(parsed: URL, hostname: string, port: number) {
  const defaultPort = (parsed.protocol === "http:" && port === 80) ||
    (parsed.protocol === "https:" && port === 443);
  const portPattern = defaultPort ? `(?::${port})?` : `:${port}`;
  return `^${escapePcreLiteral(parsed.protocol)}\\/\\/${escapePcreLiteral(hostname)}${portPattern}(?:[\\/?#]|$)`;
}

export function validatePublicOrigin(value: string): PublicOrigin {
  if (value.length === 0 || value.length > 2_083 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PublicOriginError("url must be a bounded HTTP(S) URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PublicOriginError("url must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PublicOriginError("url must use http or https.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new PublicOriginError("url must not include credentials.");
  }
  const hostname = unbracket(parsed.hostname.toLowerCase());
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isIP(hostname) !== 0
  ) {
    throw new PublicOriginError("url hostname must be a public DNS name.");
  }
  const port = parsed.port === ""
    ? parsed.protocol === "https:" ? 443 : 80
    : Number(parsed.port);
  return {
    protocol: parsed.protocol,
    hostname,
    port,
    includeRegex: originRegex(parsed, hostname, port),
  };
}

export async function resolvePublicOrigin(
  origin: PublicOrigin,
  lookup: PublicOriginLookup = defaultLookup,
): Promise<ResolvedPublicAddress[]> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(origin.hostname, { all: true, verbatim: true });
  } catch {
    throw new PublicOriginError("url host could not be resolved.");
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => !isGloballyRoutableAddress(address, family))
  ) {
    throw new PublicOriginError("url host must resolve only to globally routable addresses.");
  }
  return addresses.reduce<ResolvedPublicAddress[]>((unique, { address, family }) => {
    if (!unique.some((entry) => entry.address === address)) {
      unique.push({ address, family: family as 4 | 6 });
    }
    return unique;
  }, []);
}
