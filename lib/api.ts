/** MES 回傳原始欄位；不要將產出達成率誤標為 OEE / 良率。 */
export type WorkOrder = {
  M_WONO: string;
  PARENT_MO: string | null;
  MO_NUMBER: string;
  MODEL_NAME: string;
  MODEL_DESC: string;
  TARGET_QTY: number;
  SAP_QTY: number;
  INPUT_QTY: number;
  OUTPUT_QTY: number;
  WIP: number;
  OUTPUT_GROUP: string;
  PACKING_QTY: number;
  FAIL_QTY: number;
  TOTAL_SCRAP_QTY: number;
  MO_CREATE_DATE: string | null;
  MO_START_DATE: string | null;
  ROUTE_NAME: string;
  ROUTE_CODE: number;
  CUST_CODE: string;
  FACTORY: string;
  BGBU: string;
  PROD_PLANT: string;
  DEFAULT_LINE: string;
  LINE_RATE: number;
  [field: string]: string | number | null;
};

export type ManufacturingResponse = {
  RESULT: string;
  MESSAGE: WorkOrder[];
};

export type WorkOrderPayload = ManufacturingResponse & {
  source: "live" | "sample";
  fetchedAt: string;
  queriedMo: string;
};

export const ORDER_FIELDS: { key: keyof WorkOrder; label: string; group: "identity" | "production" | "routing" }[] = [
  { key: "M_WONO", label: "主工單", group: "identity" },
  { key: "PARENT_MO", label: "上階工單", group: "identity" },
  { key: "MO_NUMBER", label: "製令 / 工單號", group: "identity" },
  { key: "MODEL_NAME", label: "機種料號", group: "identity" },
  { key: "MODEL_DESC", label: "機種說明", group: "identity" },
  { key: "TARGET_QTY", label: "目標數量", group: "production" },
  { key: "SAP_QTY", label: "SAP 數量", group: "production" },
  { key: "INPUT_QTY", label: "投入數量", group: "production" },
  { key: "OUTPUT_QTY", label: "產出數量", group: "production" },
  { key: "WIP", label: "在製數量", group: "production" },
  { key: "OUTPUT_GROUP", label: "產出站別群組", group: "routing" },
  { key: "PACKING_QTY", label: "包裝數量", group: "production" },
  { key: "FAIL_QTY", label: "Fail 數量", group: "production" },
  { key: "TOTAL_SCRAP_QTY", label: "報廢數量", group: "production" },
  { key: "MO_CREATE_DATE", label: "建立日期", group: "identity" },
  { key: "MO_START_DATE", label: "開工時間", group: "identity" },
  { key: "ROUTE_NAME", label: "流程名稱", group: "routing" },
  { key: "ROUTE_CODE", label: "流程代碼", group: "routing" },
  { key: "CUST_CODE", label: "客戶", group: "identity" },
  { key: "FACTORY", label: "工廠", group: "routing" },
  { key: "BGBU", label: "事業群", group: "routing" },
  { key: "PROD_PLANT", label: "生產廠區", group: "routing" },
  { key: "DEFAULT_LINE", label: "預設線體", group: "routing" },
  { key: "LINE_RATE", label: "線體速率 (API 原值)", group: "production" },
];

export async function getWorkOrders(mo: string, signal?: AbortSignal): Promise<WorkOrderPayload> {
  const response = await fetch(`/api/work-orders?mo=${encodeURIComponent(mo)}`, {
    cache: "no-store",
    signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `工單 API HTTP ${response.status}`;
    throw new Error(message);
  }
  if (!body || typeof body !== "object" || !("MESSAGE" in body) || !Array.isArray(body.MESSAGE)) {
    throw new Error("API 資料格式不符合預期：缺少 MESSAGE 陣列");
  }
  return body as WorkOrderPayload;
}

export function toDisplay(value: WorkOrder[keyof WorkOrder]): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  return value;
}

export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

export function parseMesDate(value: string | null): Date | null {
  if (!value) return null;
  const match = value.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/i);
  if (!match) return null;
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const month = months.indexOf(match[2].toUpperCase());
  if (month < 0) return null;
  const date = new Date(Number(match[3]), month, Number(match[1]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0));
  return Number.isNaN(date.getTime()) || date.getMonth() !== month || date.getDate() !== Number(match[1]) ? null : date;
}

export function localDateKey(date: Date): string {
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
