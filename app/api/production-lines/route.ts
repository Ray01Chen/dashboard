import { NextRequest, NextResponse } from "next/server";
import { readDashboardConfig, readManufacturingConfig } from "../../../lib/server/mfg-config";
import { fetchLineInformation, fetchWorkOrderDetail, MesApiError } from "../../../lib/server/mfg-client";
import { progressStream } from "../../../lib/server/progress-stream";
import type { ApiProgress, DashboardPayload, LineResult } from "../../../lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

async function loadLines(request: NextRequest, report?: (event: ApiProgress) => void): Promise<DashboardPayload> {
    const [settings, mfg] = await Promise.all([readDashboardConfig(), readManufacturingConfig()]);
    const name = request.nextUrl.searchParams.get("factory") || "";
    const factory = settings.factories.find(item => item.name === name && item.enabled);
    if (!factory) throw new MesApiError(400, "Factory is not configured or enabled.");
    const selected = factory.lines.filter(line => line.enabled).map(line =>
      ({ factory: factory.name, mesFactory: factory.mesFactory, line: line.name }));
    const results: LineResult[] = selected.map(item => ({ ...item, information: null, orders: [] }));
    let position = 0;
    let completed = 0;
    // A worker owns one line at a time: API 1 completes before API 2 for that line.
    // The configured worker count therefore caps both kinds of concurrent MES requests.
    async function worker() {
      while (position < selected.length) {
        const index = position++;
        const item = selected[index];
        const context = { factory: item.factory, line: item.line, total: selected.length };
        report?.({ ...context, stage: "line", attempt: 0, maxAttempts: 3, completed });
        try {
          results[index].information = await fetchLineInformation(mfg, item.mesFactory, item.line,
            attempt => report?.({ ...context, ...attempt, completed }));
          results[index].lineFetchedAt = new Date().toISOString();
          const currentMo = results[index].information?.CURRENT_MO?.trim();
          if (currentMo) {
            report?.({ ...context, stage: "order", attempt: 0, maxAttempts: 3, completed });
            try {
              const detail = await fetchWorkOrderDetail(mfg, currentMo, item.mesFactory,
                attempt => report?.({ ...context, ...attempt, completed }));
              const mainOrder = detail.MESSAGE.find(order => order.MO_NUMBER === currentMo);
              if (!mainOrder) throw new MesApiError(502, "Work order API returned no main order for the current line.");
              results[index].orders = detail.MESSAGE;
              results[index].detailFetchedAt = new Date().toISOString();
            } catch (error) {
              // Keep the API 1 line status visible even when its work order lookup fails.
              results[index].detailError = error instanceof Error ? error.message : "Work order information unavailable.";
            }
          }
        }
        catch (error) {
          results[index].lineError = error instanceof Error ? error.message : "Line information unavailable.";
        }
        completed++;
        report?.({ ...context, stage: "line", attempt: 0, maxAttempts: 3, completed });
      }
    }
    await Promise.all(Array.from({ length: Math.min(selected.length, mfg.request.concurrentRequests) }, worker));
    return { lines: results, source: "live", fetchedAt: new Date().toISOString() };
}

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get("stream") === "1") return progressStream(report => loadLines(request, report));
  try {
    return NextResponse.json(await loadLines(request), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Production data unavailable." },
      { status: error instanceof MesApiError ? error.status : 500, headers });
  }
}
