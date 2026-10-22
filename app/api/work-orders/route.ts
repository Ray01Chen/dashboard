import { NextRequest, NextResponse } from "next/server";
import { readDashboardConfig, readManufacturingConfig } from "../../../lib/server/mfg-config";
import { fetchLineInformation, fetchWorkOrderDetail, MesApiError } from "../../../lib/server/mfg-client";
import { progressStream } from "../../../lib/server/progress-stream";
import type { ApiProgress, WorkOrderPayload } from "../../../lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

async function loadOrders(request: NextRequest, report?: (event: ApiProgress) => void): Promise<WorkOrderPayload> {
  const factoryName = request.nextUrl.searchParams.get("factory") || "";
  const line = request.nextUrl.searchParams.get("line") || "";
    const settings = await readDashboardConfig();
    const factory = settings.factories.find(item => item.name === factoryName && item.enabled &&
      item.lines.some(itemLine => itemLine.name === line && itemLine.enabled));
    if (!factory) throw new MesApiError(400, "Factory or line is not monitored.");
    const mfg = await readManufacturingConfig();
    const maxAttempts = mfg.request.retryCount + 1;
    const context = { factory: factoryName, line, total: 2, completed: 0 };
    report?.({ ...context, stage: "line", attempt: 0, maxAttempts });
    const information = await fetchLineInformation(mfg, factory.mesFactory, line,
      attempt => report?.({ ...context, ...attempt }));
    const currentMo = information.CURRENT_MO?.trim();
    if (!currentMo) return { orders: [], currentMo: "", fetchedAt: new Date().toISOString() };
    context.completed = 1;
    report?.({ ...context, stage: "order", attempt: 0, maxAttempts });
    const detail = await fetchWorkOrderDetail(mfg, currentMo, factory.mesFactory,
      attempt => report?.({ ...context, ...attempt }));
    if (!detail.MESSAGE.some(order => order.MO_NUMBER === currentMo))
      throw new MesApiError(502, "Work order API returned no main order for the current line.");
    return { orders: detail.MESSAGE, currentMo, fetchedAt: new Date().toISOString() };
}

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get("stream") === "1") return progressStream(report => loadOrders(request, report));
  try {
    return NextResponse.json(await loadOrders(request), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Work order unavailable." },
      { status: error instanceof MesApiError ? error.status : 500, headers });
  }
}
