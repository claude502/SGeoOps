import type { PublicSeoMetric } from "@/lib/seo/report-presenter";
import { formatSeoDate, formatSeoMetricDelta, formatSeoMetricValue } from "./format";

export function ComparisonTable({ metrics }: { metrics: PublicSeoMetric[] }) {
  return (
    <section aria-labelledby="seo-comparison-heading" className="seo-section">
      <div className="seo-section-heading">
        <div>
          <p>Metric identity</p>
          <h2 id="seo-comparison-heading">Baseline comparison</h2>
        </div>
        <span className="seo-count">{metrics.length} metrics</span>
      </div>
      {metrics.length === 0 ? (
        <p className="seo-empty-state">No metrics in this date range.</p>
      ) : (
        <div className="seo-table-shell">
          <table className="seo-table">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Latest</th>
                <th scope="col">Baseline</th>
                <th scope="col">Delta</th>
                <th scope="col">Definition and source</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={`${metric.name}:${metric.aggregation}`}>
                  <th scope="row">
                    <span className="seo-cell-title" title={metric.name}>{metric.name}</span>
                    <small>{metric.family}</small>
                  </th>
                  <td>
                    <strong>{formatSeoMetricValue(metric, metric.value)}</strong>
                    <small>{formatSeoDate(metric.capturedAt)}</small>
                  </td>
                  <td>{formatSeoMetricValue(metric, metric.baselineValue)}</td>
                  <td>{formatSeoMetricDelta(metric, metric.delta)}</td>
                  <td className="seo-definition-cell">
                    <span>{metric.definition}</span>
                    <code>{metric.aggregation}</code>
                    <small>{metric.sourceRunIds.length} source runs</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
