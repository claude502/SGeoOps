import type { PublicSeoOpportunity } from "@/lib/seo/report-presenter";
import { formatSeoDate } from "@/components/seo/format";

export function OpportunityQueue({
  opportunities,
}: {
  opportunities: PublicSeoOpportunity[];
}) {
  return (
    <section aria-labelledby="seo-opportunity-heading" className="seo-section">
      <div className="seo-section-heading">
        <div>
          <p>Operator queue</p>
          <h2 id="seo-opportunity-heading">Opportunities</h2>
        </div>
        <span className="seo-count">{opportunities.length} recommendations</span>
      </div>
      {opportunities.length === 0 ? (
        <p className="seo-empty-state">No open or historical opportunities in this date range.</p>
      ) : (
        <div className="seo-table-shell">
          <table className="seo-table seo-opportunity-table">
            <thead>
              <tr>
                <th scope="col">Recommendation</th>
                <th scope="col">Priority</th>
                <th scope="col">State</th>
                <th scope="col">Owner / due</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((item) => (
                <tr key={item.id}>
                  <th scope="row">
                    <span className="seo-cell-title" title={item.title}>{item.title}</span>
                    <small>{item.detail}</small>
                    {item.groups.map((group) => (
                      <small key={group.id} title={group.id}>
                        Group: {group.title} ({group.state})
                      </small>
                    ))}
                    <code title={item.runId}>{item.runId}</code>
                  </th>
                  <td>{item.priority}</td>
                  <td><span className={`seo-status seo-status-${item.state}`}>{item.state}</span></td>
                  <td>
                    <span>{item.ownerId ?? "Unassigned"}</span>
                    <small>{item.dueAt === null ? "No due date" : formatSeoDate(item.dueAt)}</small>
                  </td>
                  <td>
                    <details>
                      <summary>{item.evidenceCount} evidence IDs</summary>
                      <div className="seo-evidence-list">
                        {item.evidenceObservationIds.map((id) => <code key={id}>{id}</code>)}
                      </div>
                    </details>
                    <small>{item.opportunityIds.length} grouped opportunities</small>
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
