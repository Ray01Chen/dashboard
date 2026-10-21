import "server-only";
import { createHash } from "node:crypto";
import type { LineInformation, ManufacturingResponse } from "../api";
import { parseLineInformation, parseWorkOrderResponse } from "./mes-response";
import type { ManufacturingConfig } from "./mfg-config";

export type MesAttempt = { stage: "oauth" | "line" | "order"; attempt: number; maxAttempts: number };
export type ReportAttempt = (event: MesAttempt) => void;

let tokenCache: { key: string; token: string; expiresAt: number } | null = null;
let tokenRequest: { key: string; promise: Promise<string> } | null = null;

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

async function requestToken(config: ManufacturingConfig, report?: ReportAttempt): Promise<string> {
  const { url, clientId, clientSecret } = config.oauth;
  if (!clientId || !clientSecret) throw new MesApiError(503, "OAuth credentials are missing in server configuration.");
  let response: Response;
  for (let attempt = 0; ; attempt++) {
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
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
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
    if ([404, 429, 500, 502, 503, 504].includes(response.status) && gatewayRetries < 2) {
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
