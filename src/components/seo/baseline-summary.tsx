import type { PublicSeoReport } from "@/lib/seo/report-presenter";
import { formatSeoDate, formatSeoMetricDelta, formatSeoMetricValue } from "./format";

export function BaselineSummary({ report }: { report: PublicSeoReport }) {
  return (
    <section aria-labelledby="seo-summary-heading" className="seo-summary">
      <div className="seo-section-heading">
        <div>
          <p>Comparison window</p>
          <h2 id="seo-summary-heading">Baseline and latest signals</h2>
        </div>
        <dl className="seo-anchor-list">
          <div>
            <dt>Baseline</dt>
            <dd title={report.baseline?.runId}>
              {report.baseline?.runId ?? "Not established"}
              <span>{formatSeoDate(report.baseline?.capturedAt ?? null)}</span>
            </dd>
          </div>
          <div>
            <dt>Latest</dt>
            <dd title={report.latest?.runId}>
              {report.latest?.runId ?? "No completed run"}
              <span>{formatSeoDate(report.latest?.capturedAt ?? null)}</span>
            </dd>
          </div>
        </dl>
      </div>

      {report.metrics.length > 0 ? (
        <div className="seo-metric-grid">
          {report.metrics.slice(0, 6).map((metric) => (
            <article className="seo-metric-item" key={`${metric.name}:${metric.aggregation}`}>
              <p title={metric.name}>{metric.name}</p>
              <strong>{formatSeoMetricValue(metric, metric.value)}</strong>
              <span className={`seo-delta seo-delta-${metric.comparisonStatus}`}>
                {formatSeoMetricDelta(metric, metric.delta)}
              </span>
            </article>
          ))}
        </div>
      ) : (
        <p className="seo-inline-empty">No metrics in this date range.</p>
      )}
    </section>
  );
}
