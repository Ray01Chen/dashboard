/** Shared MES client. All upstream HTTP requests and OAuth credentials stay server-side. */
import "server-only";
import { createHash } from "node:crypto";
import type { ManufacturingResponse, WorkOrder } from "../api";
import type { ManufacturingConfig } from "./mfg-config";

const MO_PATTERN = /^\d{6,20}$/;
let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

export class MesApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "MesApiError";
  }
}

function configKey(config: ManufacturingConfig): string {
  return createHash("sha256")
    .update([config.oauth.url, config.oauth.clientId, config.oauth.clientSecret].join("\u0000"))
    .digest("hex");
}

async function accessToken(config: ManufacturingConfig, refresh = false): Promise<string> {
  const { url, clientId, clientSecret } = config.oauth;
  if (!clientId || !clientSecret) {
    throw new MesApiError(503, "請先在 config/mfg-api.json 設定 oauth.clientId 和 oauth.clientSecret。");
  }
  const key = configKey(config);
  if (!refresh && tokenCache?.key === key && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(config.request.timeoutMs),
    });
  } catch {
    throw new MesApiError(502, "OAuth 伺服器連線失敗，請確認公司網路 / VPN。");
  }
  if (!response.ok) throw new MesApiError(502, `OAuth 取得 Token 失敗（HTTP ${response.status}）。`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new MesApiError(502, "OAuth 回傳不是 JSON。"); }
  if (!body || typeof body !== "object" || !("access_token" in body) || typeof body.access_token !== "string") {
    throw new MesApiError(502, "OAuth 回傳缺少 access_token。");
  }
  const expires = "expires_in" in body && typeof body.expires_in === "number" ? body.expires_in : config.request.fallbackTokenExpiresSeconds;
  tokenCache = {
    key,
    token: body.access_token,
    expiresAt: Date.now() + Math.max(0, expires - config.request.tokenExpirySafetySeconds) * 1000,
  };
  return body.access_token;
}

async function authenticatedGet(config: ManufacturingConfig, url: string): Promise<unknown> {
  for (let retry = 0; retry < 2; retry++) {
    const token = await accessToken(config, retry > 0);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(config.request.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new MesApiError(504, "製造 API 連線逾時。");
      }
      throw new MesApiError(502, "無法連接製造 API，請檢查公司網路 / VPN。");
    }
    if (response.status === 401 && retry === 0) { tokenCache = null; continue; }
    if (!response.ok) throw new MesApiError(502, `製造 API 查詢失敗（HTTP ${response.status}）。`);
    try { return await response.json(); } catch { throw new MesApiError(502, "製造 API 回傳不是 JSON。"); }
  }
  throw new MesApiError(502, "製造 API 驗證失敗（HTTP 401）。");
}

function isWorkOrder(value: unknown): value is WorkOrder {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    "MO_NUMBER" in value && typeof value.MO_NUMBER === "string" &&
    "M_WONO" in value && typeof value.M_WONO === "string" &&
    "OUTPUT_QTY" in value && typeof value.OUTPUT_QTY === "number";
}

export async function fetchWorkOrderDetail(config: ManufacturingConfig, mo: string): Promise<ManufacturingResponse> {
  if (!MO_PATTERN.test(mo)) throw new MesApiError(400, "工單號碼應為 6–20 位數字。");
  const url = config.apis.workOrderDetail.url.replaceAll("{mo}", encodeURIComponent(mo));
  const body = await authenticatedGet(config, url);
  if (!body || typeof body !== "object" || !("RESULT" in body) || !("MESSAGE" in body) ||
      body.RESULT !== "OK" || !Array.isArray(body.MESSAGE) || !body.MESSAGE.every(isWorkOrder)) {
    throw new MesApiError(502, "製造 API 的 RESULT / MESSAGE 或工單欄位格式錯誤。");
  }
  return body as ManufacturingResponse;
}

/**
 * Work-order-list API is not documented yet.
 * We intentionally do not invent request parameters, response field names or data types.
 * When it arrives, implement the adapter here, then feed its MO numbers into
 * fetchWorkOrderDetail() to retrieve each master order and its children.
 */
export type WorkOrderSearchCriteria = {
  factory?: string;
  line?: string;
  startTime?: string;
  endTime?: string;
};

export async function fetchWorkOrderList(
  _config: ManufacturingConfig,
  _criteria: WorkOrderSearchCriteria,
): Promise<string[]> {
  throw new MesApiError(501, "工單清單 API 規格尚未提供，跨工單搜尋尚未開放。");
}

/** Reusable bounded-concurrency step for future multi-order search. */
export async function fetchManyWorkOrderDetails(config: ManufacturingConfig, moNumbers: string[]): Promise<{
  records: WorkOrder[];
  failures: { mo: string; message: string }[];
}> {
  const uniqueMos = [...new Set(moNumbers)];
  if (uniqueMos.length > config.request.maxWorkOrdersPerSearch) throw new MesApiError(400, `一次最多處理 ${config.request.maxWorkOrdersPerSearch} 張工單，請縮小查詢範圍。`);
  const records: WorkOrder[] = [];
  const failures: { mo: string; message: string }[] = [];
  let position = 0;
  async function worker() {
    while (position < uniqueMos.length) {
      const mo = uniqueMos[position++];
      try {
        const payload = await fetchWorkOrderDetail(config, mo);
        records.push(...payload.MESSAGE);
      } catch (error) {
        failures.push({ mo, message: error instanceof MesApiError ? error.message : "查詢失敗" });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.request.concurrentDetailRequests, uniqueMos.length) }, worker));
  // De-duplicate in case the list contains both a main and a child order.
  return { records: [...new Map(records.map((r) => [r.MO_NUMBER, r])).values()], failures };
}
