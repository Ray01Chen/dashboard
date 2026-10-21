import "server-only";
import { createHash } from "node:crypto";
import type { LineInformation, ManufacturingResponse } from "../api";
import { parseLineInformation, parseWorkOrderResponse } from "./mes-response";
import type { ManufacturingConfig } from "./mfg-config";

export type MesAttempt = { stage: "oauth" | "line" | "order"; attempt: number; maxAttempts: number; retryAt?: string };
export type ReportAttempt = (event: MesAttempt) => void;

let tokenCache: { key: string; token: string; expiresAt: number } | null = null;
let tokenRequest: { key: string; promise: Promise<string> } | null = null;
type RateState = { starts: number[]; cooldownUntil: number };
const sharedRuntime = globalThis as typeof globalThis & { __mesRateStates?: Map<string, RateState> };
const rateStates = sharedRuntime.__mesRateStates ??= new Map<string, RateState>();
const minuteMs = 60_000;

export class MesApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "MesApiError";
  }
}

function configKey(config: ManufacturingConfig): string {
  return createHash("sha256").update([config.oauth.url, config.oauth.clientId, config.oauth.clientSecret,
    config.request.tokenExpirySafetySeconds, config.request.fallbackTokenExpiresSeconds].join("\0")).digest("hex");
}

function rateState(config: ManufacturingConfig): RateState {
  // Quota belongs to the MES application, so editing timeout or token lifetime must not reset its budget.
  const key = createHash("sha256").update([config.oauth.url, config.oauth.clientId,
    config.oauth.clientSecret].join("\0")).digest("hex");
  let state = rateStates.get(key);
  if (!state) { state = { starts: [], cooldownUntil: 0 }; rateStates.set(key, state); }
  return state;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function nextAccessTime(value: string): number {
  // The MES gateway uses "2026-Oct-21 08:01:00+0000 UTC", which is not an ISO date.
  const match = /^(\d{4})-([A-Za-z]{3})-(\d{1,2}) (\d{2}:\d{2}:\d{2})([+-]\d{2})(\d{2}) UTC$/.exec(value);
  if (!match) return Date.parse(value);
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    .indexOf(match[2].toLowerCase()) + 1;
  if (!month) return NaN;
  return Date.parse(`${match[1]}-${String(month).padStart(2, "0")}-${match[3].padStart(2, "0")}` +
    `T${match[4]}${match[5]}:${match[6]}`);
}

// One budget is shared by every browser request handled by this server process.
async function waitForMesSlot(config: ManufacturingConfig, onWait?: (retryAt: string) => void): Promise<void> {
  const state = rateState(config);
  while (true) {
    const now = Date.now();
    while (state.starts.length && state.starts[0] <= now - minuteMs) state.starts.shift();
    const budget = config.request.maxRequestsPerMinute;
    const budgetReady = state.starts.length >= budget ? state.starts[state.starts.length - budget] + minuteMs : now;
    const ready = Math.max(state.cooldownUntil, budgetReady);
    if (ready <= now) { state.starts.push(now); return; }
    onWait?.(new Date(ready).toISOString());
    await pause(ready - now);
  }
}

async function noteThrottle(config: ManufacturingConfig, response: Response): Promise<number> {
  const now = Date.now();
  const hinted: number[] = [];
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(parsed) && parsed > now) hinted.push(parsed);
  }
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "nextAccessTime" in body &&
    typeof body.nextAccessTime === "string") {
    const parsed = nextAccessTime(body.nextAccessTime);
    if (Number.isFinite(parsed) && parsed > now) hinted.push(parsed);
  }
  const until = Math.max(now + 1000, hinted.length ? Math.max(...hinted) : now + 30_000);
  const state = rateState(config);
  state.cooldownUntil = Math.max(state.cooldownUntil, until);
  return state.cooldownUntil;
}

async function waitForCooldown(config: ManufacturingConfig, onWait?: (retryAt: string) => void): Promise<void> {
  const state = rateState(config);
  while (state.cooldownUntil > Date.now()) {
    onWait?.(new Date(state.cooldownUntil).toISOString());
    await pause(state.cooldownUntil - Date.now());
  }
}

async function requestToken(config: ManufacturingConfig, report?: ReportAttempt): Promise<string> {
  const { url, clientId, clientSecret } = config.oauth;
  if (!clientId || !clientSecret) throw new MesApiError(503, "OAuth credentials are missing in server configuration.");
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    await waitForCooldown(config, retryAt => report?.({ stage: "oauth", attempt: attempt + 1, maxAttempts: 3, retryAt }));
    report?.({ stage: "oauth", attempt: attempt + 1, maxAttempts: 3 });
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json",
        },
        body: "grant_type=client_credentials", cache: "no-store", signal: AbortSignal.timeout(config.request.timeoutMs),
      });
    } catch {
      if (attempt < 2) { await retryPause(attempt); continue; }
      throw new MesApiError(502, "OAuth request failed after 3 attempts. Check network or VPN access.");
    }
    if (response.status === 429) {
      const until = await noteThrottle(config, response);
      if (attempt < 2) continue;
      throw new MesApiError(429, `OAuth rate limit reached. Next access: ${new Date(until).toISOString()}.`);
    }
    if ([500, 502, 503, 504].includes(response.status) && attempt < 2) {
      await retryPause(attempt);
      continue;
    }
    break;
  }
  if (!response.ok) throw new MesApiError(502, `OAuth request failed (HTTP ${response.status}).`);
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new MesApiError(502, "OAuth returned invalid JSON."); }
  if (!body || typeof body !== "object" || !("access_token" in body) || typeof body.access_token !== "string") {
    throw new MesApiError(502, "OAuth response has no access_token.");
  }
  const expires = "expires_in" in body && typeof body.expires_in === "number"
    ? body.expires_in : config.request.fallbackTokenExpiresSeconds;
  tokenCache = {
    key: configKey(config), token: body.access_token,
    expiresAt: Date.now() + Math.max(0, expires - config.request.tokenExpirySafetySeconds) * 1000,
  };
  return body.access_token;
}

async function accessToken(config: ManufacturingConfig, report?: ReportAttempt): Promise<string> {
  const key = configKey(config);
  if (tokenCache?.key === key && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  if (tokenRequest?.key === key) return tokenRequest.promise;
  const promise = requestToken(config, report).finally(() => {
    if (tokenRequest?.promise === promise) tokenRequest = null;
  });
  tokenRequest = { key, promise };
  return promise;
}

const retryPause = (attempt: number) => new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));

async function authenticatedGet(config: ManufacturingConfig, url: string,
  stage: "line" | "order", report?: ReportAttempt): Promise<unknown> {
  let authRetries = 0;
  let gatewayRetries = 0;
  while (true) {
    const token = await accessToken(config, report);
    let response: Response;
    await waitForMesSlot(config, retryAt => report?.({ stage, attempt: gatewayRetries + 1, maxAttempts: 3, retryAt }));
    report?.({ stage, attempt: gatewayRetries + 1, maxAttempts: 3 });
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store", signal: AbortSignal.timeout(config.request.timeoutMs),
      });
    } catch {
      if (gatewayRetries < 2) { await retryPause(gatewayRetries++); continue; }
      throw new MesApiError(504, "MES request timed out or could not connect after 3 attempts.");
    }
    if (response.status === 401 && authRetries < 1) {
      authRetries++;
      tokenCache = null;
      continue;
    }
    if (response.status === 429) {
      const until = await noteThrottle(config, response);
      if (gatewayRetries < 2) { gatewayRetries++; continue; }
      throw new MesApiError(429, `MES rate limit reached. Next access: ${new Date(until).toISOString()}.`);
    }
    if ([404, 500, 502, 503, 504].includes(response.status) && gatewayRetries < 2) {
      gatewayRetries++;
      await retryPause(gatewayRetries - 1);
      continue;
    }
    if (!response.ok) throw new MesApiError(502, `MES request failed (HTTP ${response.status}).`);
    try { return await response.json(); }
    catch { throw new MesApiError(502, "MES returned invalid JSON."); }
  }
}

export async function fetchLineInformation(config: ManufacturingConfig, mesFactory: string, line: string,
  report?: ReportAttempt): Promise<LineInformation> {
  const url = config.apis.lineInformation.url
    .replaceAll("{mesFactory}", encodeURIComponent(mesFactory))
    .replaceAll("{line}", encodeURIComponent(line));
  try { return parseLineInformation(await authenticatedGet(config, url, "line", report)); }
  catch (error) {
    if (error instanceof MesApiError) throw error;
    throw new MesApiError(502, error instanceof Error ? error.message : "Invalid line response.");
  }
}

export async function fetchWorkOrderDetail(config: ManufacturingConfig, mo: string, mesFactory = "DET_HP",
  report?: ReportAttempt): Promise<ManufacturingResponse> {
  if (!/^\d{6,20}$/.test(mo)) throw new MesApiError(400, "Work order number must contain 6–20 digits.");
  const url = config.apis.workOrderDetail.url
    .replaceAll("{mesFactory}", encodeURIComponent(mesFactory))
    .replaceAll("{mo}", encodeURIComponent(mo));
  try { return parseWorkOrderResponse(await authenticatedGet(config, url, "order", report)); }
  catch (error) {
    if (error instanceof MesApiError) throw error;
    throw new MesApiError(502, error instanceof Error ? error.message : "Invalid work order response.");
  }
}
