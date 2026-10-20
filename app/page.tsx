import Dashboard from "../components/Dashboard";
import { readDashboardConfig } from "../lib/server/mfg-config";

export const dynamic = "force-dynamic";

export default async function Home() {
  // initialMo only populates the search box; live queries are not restricted.
  const config = await readDashboardConfig();
  return <Dashboard defaultMo={config.initialMo} autoRefreshEnabled={config.autoRefresh.enabled} refreshIntervalSeconds={config.autoRefresh.intervalSeconds} />;
}
