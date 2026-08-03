import type { PublicSeoMetric } from "@/lib/seo/report-presenter";

export function formatSeoDate(value: string | null) {
  if (value === null) return "Never";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

function isPercentageMetric(name: string) {
  return name.endsWith("_rate") || name.endsWith(".ctr");
}

function isMillisecondMetric(name: string) {
  return name.endsWith("_ms");
}

export function formatSeoMetricValue(
  metric: Pick<PublicSeoMetric, "name">,
  value: number | null,
) {
  if (value === null) return "Unavailable";
  if (isPercentageMetric(metric.name)) return `${(value * 100).toFixed(2)}%`;
  if (isMillisecondMetric(metric.name)) return `${value.toFixed(0)} ms`;
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);
}

export function formatSeoMetricDelta(
  metric: Pick<PublicSeoMetric, "name">,
  value: number | null,
) {
  if (value === null) return "No comparable baseline";
  const prefix = value > 0 ? "+" : "";
  if (isPercentageMetric(metric.name)) return `${prefix}${(value * 100).toFixed(2)}%`;
  if (isMillisecondMetric(metric.name)) return `${prefix}${value.toFixed(0)} ms`;
  return `${prefix}${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value)}`;
}
