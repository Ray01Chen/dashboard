import Dashboard from "../components/Dashboard";
import { readDashboardConfig, readManufacturingConfig } from "../lib/server/mfg-config";

export const dynamic = "force-dynamic";

export default async function Home() {
  try {
    const [dashboard, manufacturing] = await Promise.all([readDashboardConfig(), readManufacturingConfig()]);
    return <Dashboard initialSettings={{ ...dashboard, apiRequest: manufacturing.request }} />;
  } catch (error) {
    return <main className="dashboard"><div className="panel empty" role="alert">
      <h1>Dashboard configuration unavailable</h1>
      <p>{error instanceof Error ? error.message : "Could not load server configuration."}</p>
    </div></main>;
  }
}
