import "server-only";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiRequestSettings, DashboardSettings } from "../api";

export type ManufacturingConfig = {
  oauth: { url: string; clientId: string; clientSecret: string };
  apis: { lineInformation: { url: string }; workOrderDetail: { url: string } };
  request: ApiRequestSettings;
};

const configDirectory = () => path.resolve(process.env.MES_CONFIG_DIR || path.join(process.cwd(), "config"));
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

async function readJson(file: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path.join(configDirectory(), file), "utf8")); }
  catch { throw new Error(`Cannot read valid config/${file}.`); }
  if (!record(value)) throw new Error(`config/${file} must contain a JSON object.`);
  return value;
}

function textId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value);
}

function timeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}

export function validateSettings(value: unknown): DashboardSettings {
  if (!record(value) || !timeZone(value.timeZone) || !record(value.autoRefresh) ||
    typeof value.autoRefresh.enabled !== "boolean" || !integer(value.autoRefresh.intervalSeconds, 5, 3600) ||
    (value.autoRefresh.retryOnError !== undefined && typeof value.autoRefresh.retryOnError !== "boolean") ||
    !Array.isArray(value.factories) || value.factories.length > 20) {
    throw new Error("Invalid dashboard settings.");
  }
  const factories = value.factories.map(item => {
    if (!record(item) || !textId(item.name) || !textId(item.mesFactory) ||
      (item.enabled !== undefined && typeof item.enabled !== "boolean") ||
      !Array.isArray(item.lines) || item.lines.length > 100) {
      throw new Error("Each factory needs a name, MES factory, and valid lines.");
    }
    // Accept older string-only line settings and normalize them when saved.
    const lines = item.lines.map(line => typeof line === "string"
      ? { name: line, enabled: true } : line);
    if (!lines.every(line => record(line) && textId(line.name) && typeof line.enabled === "boolean")) {
      throw new Error("Each line needs a valid name and enabled setting.");
    }
    return { name: item.name, mesFactory: item.mesFactory, enabled: item.enabled ?? true,
      lines: lines as { name: string; enabled: boolean }[] };
  });
  const names = factories.map(item => item.name);
  if (new Set(names).size !== names.length ||
    factories.some(item => new Set(item.lines.map(line => line.name)).size !== item.lines.length)) {
    throw new Error("Factory and line names must be unique.");
  }
  return {
    factories,
    timeZone: value.timeZone,
    // Existing dashboard.json files predate retryOnError; false keeps their pause-on-error behavior.
    autoRefresh: { enabled: value.autoRefresh.enabled, intervalSeconds: value.autoRefresh.intervalSeconds,
      retryOnError: value.autoRefresh.retryOnError ?? false },
  };
}

export async function readDashboardConfig(): Promise<DashboardSettings> {
  return validateSettings(await readJson("dashboard.json"));
}

export async function writeDashboardConfig(value: unknown): Promise<DashboardSettings> {
  const settings = validateSettings(value);
  const target = path.join(configDirectory(), "dashboard.json");
  const temporary = path.join(configDirectory(), `.dashboard-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
  return settings;
}

export function validateApiRequest(value: unknown): ApiRequestSettings {
  if (!record(value) || !integer(value.timeoutMs, 1000, 120000) ||
    !integer(value.tokenExpirySafetySeconds, 0, 600) ||
    !integer(value.fallbackTokenExpiresSeconds, 60, 86400) ||
    !integer(value.concurrentRequests, 1, 20) ||
    (value.maxRequestsPerMinute !== undefined && !integer(value.maxRequestsPerMinute, 1, 600)) ||
    (value.retryCount !== undefined && !integer(value.retryCount, 0, 10))) {
    throw new Error("Invalid MES request settings.");
  }
  return {
    timeoutMs: value.timeoutMs, tokenExpirySafetySeconds: value.tokenExpirySafetySeconds,
    fallbackTokenExpiresSeconds: value.fallbackTokenExpiresSeconds, concurrentRequests: value.concurrentRequests,
    maxRequestsPerMinute: value.maxRequestsPerMinute ?? 18,
    retryCount: value.retryCount ?? 2,
  };
}

export async function writeApiRequest(value: unknown): Promise<ApiRequestSettings> {
  const request = validateApiRequest(value);
  const obj = await readJson("mfg-api.json");
  const target = path.join(configDirectory(), "mfg-api.json");
  const temporary = path.join(configDirectory(), `.mfg-api-${randomUUID()}.tmp`);
  obj.request = request;
  await writeFile(temporary, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, target);
  return request;
}

function httpsTemplate(value: unknown, placeholders: string[]): value is string {
  if (typeof value !== "string" || !placeholders.every(name => value.includes(`{${name}}`))) return false;
  try {
    const parsed = new URL(value.replace(/\{[a-zA-Z]+\}/g, "test"));
    return parsed.protocol === "https:" && !!parsed.hostname && !parsed.username && !parsed.password &&
      !value.slice(8).includes("https://");
  } catch { return false; }
}

export async function readManufacturingConfig(): Promise<ManufacturingConfig> {
  const obj = await readJson("mfg-api.json");
  const oauth = obj.oauth;
  const apis = obj.apis;
  const request = obj.request;
  if (!record(oauth) || !record(apis) || !record(request)) {
    throw new Error("Invalid manufacturing API configuration.");
  }
  const line = apis.lineInformation;
  const detail = apis.workOrderDetail;
  const oauthUrl = oauth.url;
  const lineUrl = record(line) ? line.url : undefined;
  const detailUrl = record(detail) ? detail.url : undefined;
  const clientId = oauth.clientId;
  const clientSecret = oauth.clientSecret;
  if (!httpsTemplate(oauthUrl, []) || !httpsTemplate(lineUrl, ["mesFactory", "line"]) ||
    !httpsTemplate(detailUrl, ["mesFactory", "mo"]) || typeof clientId !== "string" || !clientId ||
    typeof clientSecret !== "string" || !clientSecret) {
    throw new Error("Invalid manufacturing API endpoint or request settings.");
  }
  return {
    oauth: { url: oauthUrl, clientId, clientSecret },
    apis: { lineInformation: { url: lineUrl }, workOrderDetail: { url: detailUrl } },
    request: validateApiRequest(request),
  };
}
