import { NextRequest, NextResponse } from "next/server";
import { readSampleResponse } from "../../../lib/server/sample-data";
import { readDashboardConfig, readManufacturingConfig } from "../../../lib/server/mfg-config";
import { fetchWorkOrderDetail, MesApiError } from "../../../lib/server/mfg-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  try {
    const app = await readDashboardConfig();
    const mo = request.nextUrl.searchParams.get("mo")?.trim() || app.initialMo;
    if (!/^\d{6,20}$/.test(mo)) return errorResponse("工單號碼應為 6–20 位數字。", 400);

    if (app.dataSource === "sample") {
      const sampleResponse = await readSampleResponse(app.sampleDataFile);
      if (!sampleResponse.MESSAGE.some(row => row.M_WONO === mo || row.MO_NUMBER === mo)) {
        return errorResponse(`範例資料檔沒有工單 ${mo}；正式 API 可查詢其他工單。`, 404);
      }
      return NextResponse.json({ ...sampleResponse, source: "sample", queriedMo: mo, fetchedAt: new Date().toISOString() },
        { headers: { "Cache-Control": "no-store" } });
    }

    const mfg = await readManufacturingConfig();
    const result = await fetchWorkOrderDetail(mfg, mo);
    return NextResponse.json({ ...result, source: "live", queriedMo: mo, fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MesApiError) return errorResponse(error.message, error.status);
    console.error("MES configuration or internal failure", error instanceof Error ? error.name : "unknown");
    return errorResponse(error instanceof Error && error.message.startsWith("config/") ? error.message : "工單 API 發生內部錯誤。", 500);
  }
}
