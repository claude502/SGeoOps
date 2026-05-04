import { GeoDashboard } from "@/components/geo-dashboard";
import { getRuntimeDashboardSnapshot } from "@/lib/dashboard-snapshot";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <GeoDashboard initialSnapshot={await getRuntimeDashboardSnapshot()} />;
}
