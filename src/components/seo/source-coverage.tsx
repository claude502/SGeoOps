import type { PublicSeoCoverage } from "@/lib/seo/report-presenter";
import { formatSeoDate } from "./format";

export function SourceCoverage({ coverage }: { coverage: PublicSeoCoverage[] }) {
  return (
    <section aria-labelledby="seo-coverage-heading" className="seo-section">
      <div className="seo-section-heading">
        <div>
          <p>Collection health</p>
          <h2 id="seo-coverage-heading">Source coverage</h2>
        </div>
      </div>
      {coverage.length === 0 ? (
        <p className="seo-empty-state">No source coverage in this date range.</p>
      ) : <div className="seo-table-shell">
        <table className="seo-table seo-coverage-table">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">Last run</th>
              <th scope="col">Run counts</th>
              <th scope="col">Observed range</th>
            </tr>
          </thead>
          <tbody>
            {coverage.map((item) => (
              <tr key={item.source}>
                <th scope="row">{item.source}</th>
                <td><span className={`seo-status seo-status-${item.status}`}>{item.status}</span></td>
                <td>{formatSeoDate(item.lastRunAt)}</td>
                <td>
                  {item.runCounts.succeeded} succeeded / {item.runCounts.partial} partial / {item.runCounts.failed} failed
                </td>
                <td>
                  {item.observedAt === null
                    ? "No observations"
                    : `${formatSeoDate(item.observedAt.start)} to ${formatSeoDate(item.observedAt.end)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </section>
  );
}
