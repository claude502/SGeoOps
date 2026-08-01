import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { AuthorizationError, requireAccessScope } from "@/lib/authorization";
import {
  ScopedOrganizationError,
  organizationRepository,
} from "@/lib/organization/repository";

type PageProps = {
  params: Promise<{ siteId: string }>;
};

export const dynamic = "force-dynamic";

export default async function SiteOverviewPage({ params }: PageProps) {
  const { siteId } = await params;

  try {
    const scope = await requireAccessScope(
      new Request("http://geo-ops.local/sites", { headers: await headers() }),
    );
    const site = await organizationRepository.getSite(scope, siteId);

    return (
      <main className="clients-page">
        <header className="clients-header">
          <div>
            <p className="clients-eyebrow">Site overview</p>
            <h1>{site.name}</h1>
          </div>
          <Link className="button button-secondary" href="/clients">
            Clients
          </Link>
        </header>

        <section className="clients-table-shell" aria-label="Site details">
          <div className="clients-table-row site-overview-row">
            <div>
              <strong>Canonical host</strong>
              <span>{site.canonicalHost}</span>
            </div>
            <div>
              <strong>Hosting mode</strong>
              <span>{site.hostingMode}</span>
            </div>
            <div>
              <strong>Publishing paths</strong>
              <span>{site.allowedPublishPaths.join(", ") || "None"}</span>
            </div>
          </div>
        </section>

        {site.id === "site_txpuro_com" ? (
          <Link className="button button-primary" href="/dashboard">
            Open Txpuro dashboard
          </Link>
        ) : null}
      </main>
    );
  } catch (error) {
    if (
      error instanceof AuthorizationError ||
      error instanceof ScopedOrganizationError
    ) {
      notFound();
    }
    throw error;
  }
}
