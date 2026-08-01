import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { GeoDashboard } from "@/components/geo-dashboard";
import { AuthorizationError, requireAccessScope } from "@/lib/authorization";
import { getRuntimeDashboardSnapshot } from "@/lib/dashboard-snapshot";

const TXPURO_CLIENT_ID = "client_wing_heng";

export const dynamic = "force-dynamic";

export default async function TxpuroDashboardPage() {
  const scope = await requireAccessScope(
    new Request("http://geo-ops.local/dashboard", { headers: await headers() }),
  ).catch((error: unknown) => {
    if (error instanceof AuthorizationError) {
      notFound();
    }
    throw error;
  });
  if (!scope.clientIds.includes(TXPURO_CLIENT_ID)) {
    notFound();
  }

  return (
    <GeoDashboard
      initialSnapshot={await getRuntimeDashboardSnapshot({
        ...scope,
        clientIds: [TXPURO_CLIENT_ID],
      })}
    />
  );
}
