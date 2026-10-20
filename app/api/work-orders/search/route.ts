import { NextRequest, NextResponse } from "next/server";
import { readManufacturingConfig } from "../../../../lib/server/mfg-config";
import { fetchManyWorkOrderDetails, fetchWorkOrderList, MesApiError } from "../../../../lib/server/mfg-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Stable application-facing endpoint reserved for the future 2nd API. */
export async function GET(request: NextRequest) {
  try {
    const config = await readManufacturingConfig();
    if (!config.apis.workOrderList.url) {
      return NextResponse.json({ error: "工單清單 API 尚未提供 URL，跨工單搜尋目前未啟用。" }, { status: 501 });
    }
    const criteria = {
      factory: request.nextUrl.searchParams.get("factory") ?? undefined,
      line: request.nextUrl.searchParams.get("line") ?? undefined,
      startTime: request.nextUrl.searchParams.get("startTime") ?? undefined,
      endTime: request.nextUrl.searchParams.get("endTime") ?? undefined,
    };
    // Do not call unknown upstream API without a confirmed request/response contract.
    const mos = await fetchWorkOrderList(config, criteria);
    const details = await fetchManyWorkOrderDetails(config, mos);
    return NextResponse.json({ RESULT: "OK", MESSAGE: details.records, moNumbers: mos, failures: details.failures, source: "live", fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MesApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "查詢設定或資料讀取失敗。" }, { status: 500 });
  }
}
