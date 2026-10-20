/** Server-only runtime settings. The configuration bootstrap directory is
 *  <project>/config or MES_CONFIG_DIR (optional deployment override).
 *  Do not import this module into Client Components.
 */
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type ManufacturingConfig = {
  oauth: { url: string; clientId: string; clientSecret: string };
  apis: { workOrderList: { url: string }; workOrderDetail: { url: string } };
  request: {
    timeoutMs: number;
    tokenExpirySafetySeconds: number;
    fallbackTokenExpiresSeconds: number;
    maxWorkOrdersPerSearch: number;
    concurrentDetailRequests: number;
  };
};

export type DashboardConfig = {
  dataSource: "sample" | "live";
  initialMo: string;
  sampleDataFile: string;
  autoRefresh: { enabled: boolean; intervalSeconds: number };
};

function configDirectory(): string {
  return path.resolve(process.env.MES_CONFIG_DIR || path.join(process.cwd(), "config"));
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function loadJson(filename: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path.join(configDirectory(), filename), "utf8");
  } catch {
    throw new Error(`找不到設定檔 ${filename}（預設位於 config/）。`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`設定檔 ${filename} 不是有效 JSON。`); }
  if (!plainObject(parsed)) throw new Error(`設定檔 ${filename} 必須是 JSON 物件。`);
  return parsed;
}

function validHttpsUrl(url: string, allowPlaceholder: boolean): boolean {
  if (!url.startsWith("https://")) return false;
  try {
    const value = new URL(allowPlaceholder ? url.replaceAll("{mo}", "123456") : url);
    return value.protocol === "https:" && !!value.hostname && !value.username && !value.password;
  } catch { return false; }
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** API endpoints + OAuth credentials + upstream request tuning; no fixed MO restrictions. */
export async function readManufacturingConfig(): Promise<ManufacturingConfig> {
  const obj = await loadJson("mfg-api.json");
  if (!plainObject(obj.oauth) || !plainObject(obj.apis) || !plainObject(obj.request)) {
    throw new Error("config/mfg-api.json 缺少 oauth、apis 或 request。");
  }
  const { oauth, apis, request } = obj;
  if (!plainObject(apis.workOrderList) || !plainObject(apis.workOrderDetail)) {
    throw new Error("config/mfg-api.json 缺少工單 API 設定。");
  }
  const list = apis.workOrderList;
  const detail = apis.workOrderDetail;
  if (typeof oauth.url !== "string" || typeof oauth.clientId !== "string" ||
      typeof oauth.clientSecret !== "string" || typeof list.url !== "string" || typeof detail.url !== "string") {
    throw new Error("config/mfg-api.json OAuth 與 API 的 url 欄位必須是字串。");
  }
  if (!validHttpsUrl(oauth.url, false) || !validHttpsUrl(detail.url, true) ||
      (list.url !== "" && !validHttpsUrl(list.url, false))) {
    throw new Error("config/mfg-api.json 的 URL 必須是有效 HTTPS 網址。");
  }
  if (!detail.url.includes("{mo}")) {
    throw new Error("apis.workOrderDetail.url 必須包含 {mo} 工單參數。");
  }
  if (!integerInRange(request.timeoutMs, 1000, 120000) ||
      !integerInRange(request.tokenExpirySafetySeconds, 0, 600) ||
      !integerInRange(request.fallbackTokenExpiresSeconds, 60, 86400) ||
      !integerInRange(request.maxWorkOrdersPerSearch, 1, 500) ||
      !integerInRange(request.concurrentDetailRequests, 1, 20)) {
    throw new Error("config/mfg-api.json 的 request 數值超出允許範圍。");
  }
  return {
    oauth: { url: oauth.url, clientId: oauth.clientId, clientSecret: oauth.clientSecret },
    apis: { workOrderList: { url: list.url }, workOrderDetail: { url: detail.url } },
    request: {
      timeoutMs: request.timeoutMs,
      tokenExpirySafetySeconds: request.tokenExpirySafetySeconds,
      fallbackTokenExpiresSeconds: request.fallbackTokenExpiresSeconds,
      maxWorkOrdersPerSearch: request.maxWorkOrdersPerSearch,
      concurrentDetailRequests: request.concurrentDetailRequests,
    },
  };
}

/** Display options and offline sample file location; never includes OAuth secrets. */
export async function readDashboardConfig(): Promise<DashboardConfig> {
  const obj = await loadJson("dashboard.json");
  if ((obj.dataSource !== "sample" && obj.dataSource !== "live") ||
      typeof obj.initialMo !== "string" || !/^\d{6,20}$/.test(obj.initialMo) ||
      typeof obj.sampleDataFile !== "string" || !obj.sampleDataFile.trim() ||
      !plainObject(obj.autoRefresh) || typeof obj.autoRefresh.enabled !== "boolean" ||
      !integerInRange(obj.autoRefresh.intervalSeconds, 5, 3600)) {
    throw new Error("config/dashboard.json 的 dataSource、initialMo、sampleDataFile 或 autoRefresh 設定錯誤。");
  }
  return {
    dataSource: obj.dataSource,
    initialMo: obj.initialMo,
    sampleDataFile: obj.sampleDataFile,
    autoRefresh: {
      enabled: obj.autoRefresh.enabled,
      intervalSeconds: obj.autoRefresh.intervalSeconds,
    },
  };
}
