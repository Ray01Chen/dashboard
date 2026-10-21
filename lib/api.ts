export type FactorySelection = {
  name: string;
  mesFactory: string;
  enabled: boolean;
  lines: { name: string; enabled: boolean }[];
};

export type DashboardSettings = {
  factories: FactorySelection[];
  timeZone: string;
  autoRefresh: { enabled: boolean; intervalSeconds: number; retryOnError: boolean };
};

export type ApiRequestSettings = {
  timeoutMs: number;
  tokenExpirySafetySeconds: number;
  fallbackTokenExpiresSeconds: number;
  concurrentRequests: number;
  maxRequestsPerMinute: number;
};

export type SettingsPayload = DashboardSettings & { apiRequest: ApiRequestSettings };

export type MachineUtilization = { EQUIPMENT_CODE: string; MACHINE_NAME: string; UTILIZATION: number };
export type MachineTbs = { EQUIPMENT_CODE: string; MACHINE_NAME: string; TBS: number };
export type LineBalance = { MACHINE_NAME: string; CYCLE_TIME: number };
export type Attainment = { PROCESS_NAME: string; STD_ACH: number };
export type ArchiveRow = { PROCESS_NAME: string; QTY_TYPE: string; SAFE_RATE: number; ALERT_RATE: number; [slot: string]: string | number };
export type WipRow = {
  MO_NUMBER: string; GROUP_NAME: string; FIRST_PASS_QTY: number; FIRST_FAIL_QTY: number;
  FIRST_PASS_RATE: string; TOTAL_PASS_QTY: number; TOTAL_FAIL_QTY: number; TOTAL_PASS_RATE: string;
};

export type LineInformation = {
  CURRENT_MO: string | null;
  CURRENT_MODEL: string | null;
  UTILIZATION_RATE_TODAY: number | null;
  UTILIZATION_RATE_YESTERDAY: number | null;
  UTILIZATION_MACHINE: MachineUtilization[];
  AVERAGE_TBS: number | null;
  AVERAGE_TBS_MACHINE: MachineTbs[];
  AUTOMATION_DEGREE: string | number | null;
  DL_COUNT: number | null;
  EQUIPMENT_COUNT: number | null;
  CALCULATE_DAY: number | null;
  FPYR: number | null;
  UPH: string | number | null;
  OI_RATE: string | number | null;
  LINE_BALANCE: LineBalance[];
  STD_ARCHIVE_PERCENTAGE_DATA: Attainment[];
  STD_ARCHIVE_DATA: ArchiveRow[];
  STD_ARCHIVE_WIP: WipRow[];
  [field: string]: unknown;
};

export type WorkOrder = {
  M_WONO: string; PARENT_MO: string | null; MO_NUMBER: string;
  MODEL_NAME: string; MODEL_DESC: string;
  TARGET_QTY: number; SAP_QTY: number; INPUT_QTY: number; OUTPUT_QTY: number;
  WIP: number; OUTPUT_GROUP: string; PACKING_QTY: number; FAIL_QTY: number;
  TOTAL_SCRAP_QTY: number; MO_CREATE_DATE: string | null; MO_START_DATE: string | null;
  ROUTE_NAME: string; ROUTE_CODE: number; CUST_CODE: string; FACTORY: string;
  BGBU: string; PROD_PLANT: string; DEFAULT_LINE: string; LINE_RATE: number;
  [field: string]: unknown;
};

export type ManufacturingResponse = { RESULT: string; MESSAGE: WorkOrder[] };
export type LineResult = {
  factory: string;
  mesFactory: string;
  line: string;
  information: LineInformation | null;
  orders: WorkOrder[];
  lineError?: string;
  lineFetchedAt?: string;
  lineStale?: boolean;
  detailError?: string;
  detailFetchedAt?: string;
  detailStale?: boolean;
};
export type DashboardPayload = { lines: LineResult[]; source: "live"; fetchedAt: string };
export type WorkOrderPayload = { orders: WorkOrder[]; currentMo: string; fetchedAt: string };
export type ApiProgress = {
  stage: "oauth" | "line" | "order";
  attempt: number;
  maxAttempts: number;
  retryAt?: string;
  factory?: string;
  line?: string;
  completed?: number;
  total?: number;
};

// MES can return multiple rows with the same MO_NUMBER. The occurrence suffix
// keeps both React keys and row selection distinct without dropping API data.
export function workOrderRowKeys(orders: WorkOrder[]): string[] {
  const occurrences = new Map<string, number>();
  return orders.map(order => {
    const identity = JSON.stringify([
      order.MO_NUMBER, order.M_WONO, order.PARENT_MO, order.MODEL_NAME, order.DEFAULT_LINE, order.OUTPUT_GROUP,
    ]);
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    return `${identity}#${occurrence}`;
  });
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

async function streamedJson<T>(url: string, signal?: AbortSignal,
  onProgress?: (event: ApiProgress) => void): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error("The server did not return a data stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: T | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as { type: string; data?: T; error?: string } & ApiProgress;
    if (event.type === "progress") onProgress?.(event);
    if (event.type === "error") throw new Error(event.error || "MES data unavailable.");
    if (event.type === "result") result = event.data;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally {
    reader.releaseLock();
  }
  if (result === undefined) throw new Error("The server ended the data stream without a result.");
  return result;
}

export async function getDashboard(factory: string, signal?: AbortSignal,
  onProgress?: (event: ApiProgress) => void, force = false): Promise<DashboardPayload> {
  const payload = await streamedJson<DashboardPayload>(
    `/api/production-lines?factory=${encodeURIComponent(factory)}&stream=1${force ? "&force=1" : ""}`, signal, onProgress);
  if (!payload || !Array.isArray(payload.lines)) throw new Error("Invalid production line response.");
  return payload;
}

export async function saveSettings(settings: SettingsPayload): Promise<SettingsPayload> {
  return apiJson<SettingsPayload>("/api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings),
  });
}

export async function getWorkOrders(factory: string, line: string, signal?: AbortSignal,
  onProgress?: (event: ApiProgress) => void): Promise<WorkOrderPayload> {
  const payload = await streamedJson<WorkOrderPayload>(
    `/api/work-orders?factory=${encodeURIComponent(factory)}&line=${encodeURIComponent(line)}&stream=1`, signal, onProgress);
  if (!payload || !Array.isArray(payload.orders)) throw new Error("Invalid work order response.");
  return payload;
}

export function progress(order: WorkOrder | undefined): number | null {
  return order && order.TARGET_QTY > 0 ? order.OUTPUT_QTY / order.TARGET_QTY * 100 : null;
}

export function displayValue(value: unknown, language: "en" | "zh" | "th" = "en"): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return new Intl.NumberFormat({ en: "en-US", zh: "zh-TW", th: "th-TH" }[language], { maximumFractionDigits: 2 }).format(value);
  return String(value);
}
