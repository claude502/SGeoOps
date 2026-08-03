import type { SeoReportRunDto } from "@/lib/seo/report-queries";
import { formatSeoDate } from "./format";

export function RunHistory({ runs }: { runs: SeoReportRunDto[] }) {
  return (
    <section aria-labelledby="seo-run-history-heading" className="seo-section">
      <div className="seo-section-heading">
        <div>
          <p>Bounded history</p>
          <h2 id="seo-run-history-heading">Source runs</h2>
        </div>
        <span className="seo-count">Latest {runs.length} runs</span>
      </div>
      {runs.length === 0 ? (
        <p className="seo-empty-state">No source runs in this date range.</p>
      ) : (
        <div className="seo-table-shell">
          <table className="seo-table">
            <thead>
              <tr>
                <th scope="col">Run ID</th>
                <th scope="col">Source</th>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
                <th scope="col">Captured</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <th scope="row"><code title={run.id}>{run.id}</code></th>
                  <td>{run.source}</td>
                  <td>{run.kind}</td>
                  <td><span className={`seo-status seo-status-${run.status}`}>{run.status}</span></td>
                  <td>{formatSeoDate(run.capturedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
