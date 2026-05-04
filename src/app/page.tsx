import { GeoDashboard } from "@/components/geo-dashboard";
import { getDashboardSnapshot } from "@/lib/geo-store";

export const dynamic = "force-dynamic";

export default function Home() {
  return <GeoDashboard initialSnapshot={getDashboardSnapshot()} />;
}
