import { NextRequest, NextResponse } from "next/server";
import { readDashboardConfig, readManufacturingConfig, validateApiRequest, validateSettings,
  writeApiRequest, writeDashboardConfig } from "../../../lib/server/mfg-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const [dashboard, manufacturing] = await Promise.all([readDashboardConfig(), readManufacturingConfig()]);
    return NextResponse.json({ ...dashboard, apiRequest: manufacturing.request }, { headers });
  }
  catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Settings unavailable." }, { status: 500, headers });
  }
}

export async function PUT(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400, headers }); }
  try {
    if (!body || typeof body !== "object" || !("apiRequest" in body))
      return NextResponse.json({ error: "Missing MES request settings." }, { status: 400, headers });
    const dashboard = validateSettings(body);
    const apiRequest = validateApiRequest(body.apiRequest);
    // Validate the existing API configuration before writing either file.
    await readManufacturingConfig();
    await writeApiRequest(apiRequest);
    const saved = await writeDashboardConfig(dashboard);
    return NextResponse.json({ ...saved, apiRequest }, { headers });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "Could not save settings.";
    return NextResponse.json({ error: message }, { status: message.startsWith("Invalid") || message.includes("must") || message.startsWith("Each") ? 400 : 500, headers });
  }
}
