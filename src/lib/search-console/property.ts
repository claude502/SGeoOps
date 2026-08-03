export const maximumSearchConsolePropertyLength = 2_048;

export function parseSearchConsoleProperty(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumSearchConsolePropertyLength ||
    /[\u0000-\u001f\u007f\s]/.test(value)
  ) {
    return null;
  }
  if (value.startsWith("sc-domain:")) {
    const domain = value.slice("sc-domain:".length);
    return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)
      ? value
      : null;
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname === "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return parsed.toString() === value ? value : null;
  } catch {
    return null;
  }
}
