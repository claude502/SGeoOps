const defaultTxpuroHosts = ["txpuro.com", "www.txpuro.com"];
const defaultOpsHosts = ["wingheng.technology", "www.wingheng.technology"];

function normalizeHost(value: string | null | undefined) {
  return (value || "").split(":")[0].trim().toLowerCase();
}

function envHosts(value: string | undefined, fallback: string[]) {
  const hosts = (value ?? "")
    .split(",")
    .map((item) => normalizeHost(item))
    .filter(Boolean);
  return hosts.length ? hosts : fallback;
}

export function getTxpuroHosts() {
  return envHosts(
    [process.env.TXPURO_PUBLIC_HOST, process.env.TXPURO_PUBLIC_HOST_WWW].filter(Boolean).join(","),
    defaultTxpuroHosts,
  );
}

export function getOpsHosts() {
  return envHosts(
    [process.env.NEXT_PUBLIC_APP_URL]
      .filter(Boolean)
      .map((value) => {
        try {
          return new URL(value!).host;
        } catch {
          return value!;
        }
      })
      .join(","),
    defaultOpsHosts,
  );
}

export function isTxpuroHost(host: string | null | undefined) {
  const normalized = normalizeHost(host);
  return getTxpuroHosts().includes(normalized);
}

export function isOpsHost(host: string | null | undefined) {
  const normalized = normalizeHost(host);
  return getOpsHosts().includes(normalized);
}

export function preferredTxpuroHost() {
  return getTxpuroHosts()[0] || "txpuro.com";
}

export function txpuroBaseUrl() {
  return `https://${preferredTxpuroHost()}`;
}

export function normalizeLocaleFromSlug(slug: string[] | undefined) {
  if (slug?.[0] === "en") {
    return { locale: "en" as const, pathSegments: slug.slice(1) };
  }
  return { locale: "zh-CN" as const, pathSegments: slug ?? [] };
}
