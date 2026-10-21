import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { readDashboardConfig, readManufacturingConfig } from "../../../lib/server/mfg-config";
import { fetchLineInformation, fetchWorkOrderDetail, MesApiError } from "../../../lib/server/mfg-client";
import { progressStream } from "../../../lib/server/progress-stream";
import type { ApiProgress, DashboardPayload, LineResult } from "../../../lib/api";
import type { ManufacturingConfig } from "../../../lib/server/mfg-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

type RefreshEntry = {
  key: string;
  promise: Promise<DashboardPayload> | null;
  data: DashboardPayload | null;
  expiresAt: number;
  listeners: Set<(event: ApiProgress) => void>;
  latest?: ApiProgress;
};
const refreshCache = new Map<string, RefreshEntry>();

async function loadLines(request: NextRequest, report?: (event: ApiProgress) => void): Promise<DashboardPayload> {
    const [settings, mfg] = await Promise.all([readDashboardConfig(), readManufacturingConfig()]);
    const name = request.nextUrl.searchParams.get("factory") || "";
    const factory = settings.factories.find(item => item.name === name && item.enabled);
    if (!factory) throw new MesApiError(400, "Factory is not configured or enabled.");
    const selected = factory.lines.filter(line => line.enabled).map(line =>
      ({ factory: factory.name, mesFactory: factory.mesFactory, line: line.name }));
    const key = createHash("sha256").update(JSON.stringify([factory, mfg, settings.autoRefresh])).digest("hex");
    const existing = refreshCache.get(name);
    if (existing?.key === key) {
      if (existing.promise) {
        if (report) { existing.listeners.add(report); if (existing.latest) report(existing.latest); }
        return existing.promise;
      }
      if (request.nextUrl.searchParams.get("force") !== "1" && existing.data && existing.expiresAt > Date.now())
        return existing.data;
    }
    const entry: RefreshEntry = { key, promise: null, data: null, expiresAt: 0,
      listeners: new Set(report ? [report] : []) };
    refreshCache.set(name, entry);
    const publish = (event: ApiProgress) => {
      entry.latest = event;
      for (const listener of entry.listeners) listener(event);
    };
    const promise = fetchLines(selected, mfg, publish);
    entry.promise = promise;
    void promise.then(result => {
      if (refreshCache.get(name) !== entry) return;
      entry.promise = null;
      entry.listeners.clear();
      if (result.lines.some(line => line.lineError || line.detailError)) { refreshCache.delete(name); return; }
      const calls = Math.max(1, selected.length + result.lines.filter(line => line.information?.CURRENT_MO?.trim()).length);
      const batchesPerMinute = Math.max(1, Math.floor(mfg.request.maxRequestsPerMinute / calls));
      const effectiveSeconds = Math.max(settings.autoRefresh?.intervalSeconds ?? 30, Math.ceil(60 / batchesPerMinute));
      entry.data = result;
      entry.expiresAt = Date.now() + effectiveSeconds * 1000;
    }, () => { if (refreshCache.get(name) === entry) refreshCache.delete(name); });
    return promise;
}

async function fetchLines(selected: { factory: string; mesFactory: string; line: string }[],
  mfg: ManufacturingConfig, report?: (event: ApiProgress) => void): Promise<DashboardPayload> {
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
