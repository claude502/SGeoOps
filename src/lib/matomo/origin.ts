export const MAX_MATOMO_ENDPOINT_LENGTH = 2_048;

export function parseMatomoOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MATOMO_ENDPOINT_LENGTH) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  return parsed.origin;
}
