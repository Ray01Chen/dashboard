import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = process.cwd();
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const lineFixture = json("data/production-lines.sample.json");
const orderFixture = json("data/work-orders.sample.json");

function loadTs(file, fetchImpl = fetch, modules = {}) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  const localRequire = name => name === "server-only" ? {} : name in modules ? modules[name] : require(name);
  new Function("require", "module", "exports", "fetch", "AbortSignal", "Buffer", "setTimeout", code)(
    localRequire, module, module.exports, fetchImpl, AbortSignal, Buffer, setTimeout);
  return module.exports;
}

const parser = loadTs("lib/server/mes-response.ts");
const stream = loadTs("lib/server/progress-stream.ts");
const apiConfig = {
  oauth: { url: "https://test.invalid/oauth2/token", clientId: "test-client", clientSecret: "test-secret" },
  apis: {
    lineInformation: { url: "https://test.invalid/api/{mesFactory}/line/information/{line}" },
    workOrderDetail: { url: "https://test.invalid/api/{mesFactory}/MO/information/{mo}" },
  },
  request: { timeoutMs: 2000, tokenExpirySafetySeconds: 60, fallbackTokenExpiresSeconds: 300, concurrentRequests: 4 },
};
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const factory = (name, lines, enabled = true, mesFactory = "DET_HP") => ({
  name, mesFactory, enabled, lines: lines.map(([line, lineEnabled = true]) => ({ name: line, enabled: lineEnabled })),
});

test("automatic refresh pauses after any exhausted API request and resumes only after manual success", () => {
  const { nextAutoRefreshPaused, shouldAutoRefresh } = loadTs("lib/refresh-policy.ts");
  const healthy = { lines: [{ information: lineFixture, orders: orderFixture.MESSAGE }] };
  const failedLine = { lines: [{ lineError: "HTTP 503", orders: [] }] };
  const failedOrder = { lines: [{ information: lineFixture, detailError: "HTTP 429", orders: [] }] };
  assert.equal(nextAutoRefreshPaused(false, false, healthy), false);
  assert.equal(nextAutoRefreshPaused(false, false, failedLine), true);
  assert.equal(nextAutoRefreshPaused(false, false, failedOrder), true);
  assert.equal(nextAutoRefreshPaused(false, false, null), true);
  assert.equal(nextAutoRefreshPaused(true, false, healthy), true);
  assert.equal(nextAutoRefreshPaused(true, true, failedOrder), true);
  assert.equal(nextAutoRefreshPaused(true, true, healthy), false);
  // Continuous mode still records failures, but schedules the next request and clears the flag on recovery.
  assert.equal(nextAutoRefreshPaused(false, false, failedOrder, true), true);
  assert.equal(nextAutoRefreshPaused(true, false, healthy, true), false);
  assert.equal(shouldAutoRefresh({ enabled: true, retryOnError: false }, true), false);
  assert.equal(shouldAutoRefresh({ enabled: true, retryOnError: false }, false), true);
  assert.equal(shouldAutoRefresh({ enabled: true, retryOnError: true }, true), true);
  assert.equal(shouldAutoRefresh({ enabled: false, retryOnError: true }, true), false);
});

test("duplicate MO numbers retain distinct stable work order row keys", () => {
  const { workOrderRowKeys } = loadTs("lib/api.ts");
  const order = { ...orderFixture.MESSAGE[0], MO_NUMBER: "3582600330" };
  const another = { ...order, M_WONO: "another-parent" };
  const keys = workOrderRowKeys([order, another, { ...order }]);
  assert.equal(new Set(keys).size, 3);
  assert.equal(workOrderRowKeys([another, order])[1], keys[0]);
});

test("factory timestamps convert from UTC+7 to the chosen display zone", () => {
  const time = loadTs("lib/time.ts");
  assert.equal(time.parseMesDate("12-OCT-2026 22:00:33").toISOString(), "2026-10-12T15:00:33.000Z");
  assert.match(time.formatMesField("12-OCT-2026 22:00:33", "en", "Asia/Bangkok"), /22:00:33/);
  assert.match(time.formatMesField("12-OCT-2026 22:00:33", "en", "Asia/Taipei"), /23:00:33/);
  assert.match(time.formatMesField("24-AUG-2026", "en", "Asia/Taipei"), /24 Aug 2026/);
  assert.match(time.formatMesSlot("T2200_2300", "2026-10-12T12:00:00Z", "en", "Asia/Taipei"), /23:00.*00:00/);
});

test("settings accept IANA zones and validate all editable MES request values", () => {
  const config = loadTs("lib/server/mfg-config.ts");
  const settings = { timeZone: "Asia/Taipei", autoRefresh: { enabled: true, intervalSeconds: 30 },
    factories: [factory("BP9P1", [["SNT23"], ["SNT24", false]])] };
  assert.equal(config.validateSettings(settings).factories[0].lines.length, 2);
  assert.equal(config.validateSettings(settings).autoRefresh.retryOnError, false);
  assert.equal(config.validateSettings({ ...settings, autoRefresh: { ...settings.autoRefresh,
    retryOnError: true } }).autoRefresh.retryOnError, true);
  assert.throws(() => config.validateSettings({ ...settings, autoRefresh: { ...settings.autoRefresh,
    retryOnError: "yes" } }), /Invalid dashboard/);
  assert.equal(config.validateSettings(settings).factories[0].lines[1].enabled, false);
  assert.deepEqual(config.validateSettings({ ...settings, factories: [] }).factories, []);
  assert.deepEqual(config.validateSettings({ ...settings, factories: [
    { name: "BP9P1", mesFactory: "DET_HP", lines: ["SNT23"] },
  ] }).factories[0].lines, [{ name: "SNT23", enabled: true }]);
  assert.throws(() => config.validateSettings({ ...settings, factories: [factory("BP9P1", [["SNT23"], ["SNT23"]])] }),
    /unique/);
  assert.deepEqual(config.validateApiRequest(apiConfig.request), apiConfig.request);
  assert.throws(() => config.validateSettings({ ...settings, timeZone: "Invalid/Zone" }), /Invalid dashboard/);
  assert.throws(() => config.validateApiRequest({ ...apiConfig.request, concurrentRequests: 0 }), /Invalid MES request/);
});

test("line then work order flow uses both templates and retries transient MES failures", async () => {
  const calls = [];
  let lineAttempts = 0;
  const progressEvents = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, method: options?.method || "GET" });
    if (String(url).endsWith("/oauth2/token")) return response({ access_token: "test-token", expires_in: 300 });
    if (String(url).includes("/line/information/")) {
      lineAttempts++;
      if (lineAttempts === 1) return response({ error: "temporary" }, 503);
      if (lineAttempts === 2) throw new Error("network interruption");
      return response(lineFixture);
    }
    if (String(url).includes("/MO/information/")) return response(orderFixture);
    throw new Error("Unexpected URL");
  };
  const client = loadTs("lib/server/mfg-client.ts", mockFetch, { "./mes-response": parser });
  const line = await client.fetchLineInformation(apiConfig, "DET_HP", "SNT23", event => progressEvents.push(event));
  const detail = await client.fetchWorkOrderDetail(apiConfig, line.CURRENT_MO, "DET_HP");
  assert.equal(line.CURRENT_MO, "3572611722");
  assert.equal(lineAttempts, 3);
  assert.deepEqual(progressEvents.filter(event => event.stage === "line").map(event => event.attempt), [1, 2, 3]);
  assert.ok(progressEvents.some(event => event.stage === "oauth" && event.attempt === 1));
  assert.equal(detail.MESSAGE.length, 5);
  assert.ok(detail.MESSAGE.some(order => order.MO_NUMBER === line.CURRENT_MO));
  assert.ok(detail.MESSAGE.some(order => order.PARENT_MO === line.CURRENT_MO && order.MO_NUMBER !== line.CURRENT_MO));
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
  assert.ok(calls.some(call => call.url === "https://test.invalid/api/DET_HP/line/information/SNT23"));
  assert.ok(calls.some(call => call.url === "https://test.invalid/api/DET_HP/MO/information/3572611722"));
});

test("MES failures remain visible after the retry limit", async () => {
  let count = 0;
  const mockFetch = async url => {
    if (String(url).endsWith("/oauth2/token")) return response({ access_token: "test-token", expires_in: 300 });
    count++;
    return response({ error: "temporary" }, 503);
  };
  const client = loadTs("lib/server/mfg-client.ts", mockFetch, { "./mes-response": parser });
  await assert.rejects(client.fetchLineInformation(apiConfig, "DET_HP", "SNT23"), /HTTP 503/);
  assert.equal(count, 3);
});

test("selected factory calls API 1 and current-order API 2 only for enabled active lines", async () => {
  const lineCalls = [];
  const orderCalls = [];
  const selected = { factories: [
    factory("BP9P1", [["SNT23"], ["SNT24", false], ["SNT26"]]),
    factory("BP9P2", [["SNT25"]], true, "MES_OTHER"),
    factory("BP3", [["SNT27"]], false),
  ] };
  const route = loadTs("app/api/production-lines/route.ts", fetch, {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200 }) } },
    "../../../lib/server/progress-stream": stream,
    "../../../lib/server/mfg-config": {
      readDashboardConfig: async () => selected,
      readManufacturingConfig: async () => apiConfig,
    },
    "../../../lib/server/mfg-client": {
      MesApiError: class MesApiError extends Error { constructor(status, message) { super(message); this.status = status; } },
      fetchLineInformation: async (_config, factory, line) => {
        lineCalls.push(`${factory}/${line}`);
        if (line === "SNT26") throw new Error("MES request failed (HTTP 404).");
        if (line === "SNT25") return parser.parseLineInformation({ ...lineFixture, CURRENT_MO: null, STD_ARCHIVE_WIP: null });
        return parser.parseLineInformation(lineFixture);
      },
      fetchWorkOrderDetail: async (_config, mo, factory) => {
        orderCalls.push(`${factory}/${mo}`);
        return parser.parseWorkOrderResponse(orderFixture);
      },
    },
  });
  const result = await route.GET({ nextUrl: new URL("http://localhost/api/production-lines?factory=BP9P1") });
  assert.equal(result.status, 200);
  assert.deepEqual(lineCalls, ["DET_HP/SNT23", "DET_HP/SNT26"]);
  assert.deepEqual(orderCalls, ["DET_HP/3572611722"]);
  assert.deepEqual(result.body.lines.map(line => [line.factory, line.line]),
    [["BP9P1", "SNT23"], ["BP9P1", "SNT26"]]);
  assert.match(result.body.lines[1].lineError, /HTTP 404/);
  assert.equal(result.body.lines[0].information.CURRENT_MO, lineFixture.CURRENT_MO);
  assert.equal(result.body.lines[0].orders.length, 5);
  assert.ok(result.body.lines[0].orders.some(order => order.PARENT_MO === lineFixture.CURRENT_MO));
  assert.equal(result.body.lines[0].orders[0].TARGET_QTY, 10000);
  assert.equal(result.body.lines[0].orders[0].OUTPUT_QTY, 6780);
  const second = await route.GET({ nextUrl: new URL("http://localhost/api/production-lines?factory=BP9P2") });
  assert.deepEqual(second.body.lines.map(line => line.line), ["SNT25"]);
  assert.deepEqual(lineCalls, ["DET_HP/SNT23", "DET_HP/SNT26", "MES_OTHER/SNT25"]);
  assert.deepEqual(orderCalls, ["DET_HP/3572611722"]);
  assert.deepEqual(second.body.lines[0].orders, []);
  assert.deepEqual(second.body.lines[0].information.STD_ARCHIVE_WIP, []);
  const disabled = await route.GET({ nextUrl: new URL("http://localhost/api/production-lines?factory=BP3") });
  assert.equal(disabled.status, 400);
  assert.equal(lineCalls.length, 3);
});

test("overview keeps line status and reports work order API failure without quantities", async () => {
  const route = loadTs("app/api/production-lines/route.ts", fetch, {
    "next/server": { NextResponse: { json: body => ({ body, status: 200 }) } },
    "../../../lib/server/progress-stream": stream,
    "../../../lib/server/mfg-config": {
      readDashboardConfig: async () => ({ factories: [factory("BP9P1", [["SNT23"]])] }),
      readManufacturingConfig: async () => apiConfig,
    },
    "../../../lib/server/mfg-client": {
      fetchLineInformation: async () => parser.parseLineInformation(lineFixture),
      fetchWorkOrderDetail: async () => { throw new Error("MES request failed (HTTP 503)."); },
    },
  });
  const result = await route.GET({ nextUrl: new URL("http://localhost/api/production-lines?factory=BP9P1") });
  assert.equal(result.body.lines[0].information.CURRENT_MO, lineFixture.CURRENT_MO);
  assert.deepEqual(result.body.lines[0].orders, []);
  assert.match(result.body.lines[0].detailError, /HTTP 503/);
  assert.equal(result.body.lines[0].lineError, undefined);
});

test("opening a selected line calls API 1 then API 2 with its current MO", async () => {
  const calls = [];
  const route = loadTs("app/api/work-orders/route.ts", fetch, {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200 }) } },
    "../../../lib/server/progress-stream": stream,
    "../../../lib/server/mfg-config": {
      readDashboardConfig: async () => ({ factories: [factory("BP9P1", [["SNT23"], ["SNT24", false]])] }),
      readManufacturingConfig: async () => apiConfig,
    },
    "../../../lib/server/mfg-client": {
      MesApiError: class MesApiError extends Error { constructor(status, message) { super(message); this.status = status; } },
      fetchLineInformation: async (_config, factory, line) => {
        calls.push(`line:${factory}/${line}`); return parser.parseLineInformation(lineFixture);
      },
      fetchWorkOrderDetail: async (_config, mo, factory) => {
        calls.push(`order:${factory}/${mo}`); return parser.parseWorkOrderResponse(orderFixture);
      },
    },
  });
  const result = await route.GET({ nextUrl: new URL("http://localhost/api/work-orders?factory=BP9P1&line=SNT23") });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, ["line:DET_HP/SNT23", "order:DET_HP/3572611722"]);
  assert.equal(result.body.orders.length, 5);
  const denied = await route.GET({ nextUrl: new URL("http://localhost/api/work-orders?factory=BP9P1&line=OTHER") });
  assert.equal(denied.status, 400);
  const disabled = await route.GET({ nextUrl: new URL("http://localhost/api/work-orders?factory=BP9P1&line=SNT24") });
  assert.equal(disabled.status, 400);
  assert.equal(calls.length, 2);
});

test("concurrentRequests limits simultaneous line and order API calls", async () => {
  let active = 0;
  let peak = 0;
  let orderCalls = 0;
  const observed = async value => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
    return value;
  };
  const route = loadTs("app/api/production-lines/route.ts", fetch, {
    "next/server": { NextResponse: { json: body => ({ body, status: 200 }) } },
    "../../../lib/server/progress-stream": stream,
    "../../../lib/server/mfg-config": {
      readDashboardConfig: async () => ({ factories: [
        factory("BP9P1", [["SNT23"], ["SNT24"], ["SNT25"], ["SNT26"]]),
      ] }),
      readManufacturingConfig: async () => ({ ...apiConfig, request: { ...apiConfig.request, concurrentRequests: 2 } }),
    },
    "../../../lib/server/mfg-client": {
      fetchLineInformation: async () => observed(parser.parseLineInformation(lineFixture)),
      fetchWorkOrderDetail: async () => { orderCalls++; return observed(parser.parseWorkOrderResponse(orderFixture)); },
    },
  });
  const result = await route.GET({ nextUrl: new URL("http://localhost/api/production-lines?factory=BP9P1") });
  assert.equal(result.body.lines.length, 4);
  assert.equal(peak, 2);
  assert.equal(orderCalls, 4);
});

test("streamed progress reaches the browser even when a JSON line is split across chunks", async () => {
  const events = [
    { type: "progress", stage: "line", attempt: 1, maxAttempts: 3, factory: "BP9P1", line: "SNT23" },
    { type: "progress", stage: "line", attempt: 2, maxAttempts: 3, factory: "BP9P1", line: "SNT23" },
    { type: "result", data: { source: "live", lines: [], fetchedAt: "2026-10-20T00:00:00Z" } },
  ];
  const chunks = (events.map(event => JSON.stringify(event)).join("\n") + "\n");
  let requestedUrl = "";
  const mockFetch = async url => {
    requestedUrl = url;
    return new Response(new ReadableStream({
    start(controller) {
      const encoded = new TextEncoder().encode(chunks);
      controller.enqueue(encoded.slice(0, 11));
      controller.enqueue(encoded.slice(11, 73));
      controller.enqueue(encoded.slice(73));
      controller.close();
    },
  }));
  };
  const api = loadTs("lib/api.ts", mockFetch);
  const seen = [];
  const result = await api.getDashboard("BP9P1", undefined, event => seen.push(event.attempt));
  assert.deepEqual(seen, [1, 2]);
  assert.equal(requestedUrl, "/api/production-lines?factory=BP9P1&stream=1");
  assert.equal(result.source, "live");
});

test("overview streaming route sends actual retry progress and the final line result", async () => {
  const route = loadTs("app/api/production-lines/route.ts", fetch, {
    "next/server": { NextResponse: { json: body => ({ body, status: 200 }) } },
    "../../../lib/server/progress-stream": stream,
    "../../../lib/server/mfg-config": {
      readDashboardConfig: async () => ({ factories: [
        factory("BP9P1", [["SNT23"]]),
      ] }),
      readManufacturingConfig: async () => apiConfig,
    },
    "../../../lib/server/mfg-client": {
      fetchLineInformation: async (_config, _factory, _line, report) => {
        report({ stage: "line", attempt: 1, maxAttempts: 3 });
        report({ stage: "line", attempt: 2, maxAttempts: 3 });
        return parser.parseLineInformation(lineFixture);
      },
      fetchWorkOrderDetail: async (_config, _mo, _factory, report) => {
        report({ stage: "order", attempt: 1, maxAttempts: 3 });
        return parser.parseWorkOrderResponse(orderFixture);
      },
    },
  });
  const response = await route.GET({ nextUrl: new URL("http://localhost/api/production-lines?factory=BP9P1&stream=1") });
  assert.match(response.headers.get("Content-Type"), /application\/x-ndjson/);
  const events = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.filter(event => event.type === "progress" && event.attempt)
    .map(event => [event.stage, event.attempt]), [["line", 1], ["line", 2], ["order", 1]]);
  assert.equal(events.at(-1).data.lines[0].information.CURRENT_MO, lineFixture.CURRENT_MO);
  assert.equal(events.at(-1).data.lines[0].orders[0].TARGET_QTY, 10000);
  assert.equal(events.at(-1).data.lines[0].orders.length, 5);
});

test("server settings are read again after saving without a process restart", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mes-settings-test-"));
  const previous = process.env.MES_CONFIG_DIR;
  const dashboard = { factories: [factory("BP9P1", [["SNT23"]])],
    timeZone: "Asia/Bangkok", autoRefresh: { enabled: true, intervalSeconds: 30 } };
  try {
    fs.writeFileSync(path.join(temp, "mfg-api.json"), JSON.stringify(apiConfig));
    fs.writeFileSync(path.join(temp, "dashboard.json"), JSON.stringify(dashboard));
    process.env.MES_CONFIG_DIR = temp;
    const config = loadTs("lib/server/mfg-config.ts");
    assert.equal((await config.readManufacturingConfig()).request.concurrentRequests, 4);
    assert.equal((await config.readDashboardConfig()).autoRefresh.retryOnError, false);
    await config.writeApiRequest({ ...apiConfig.request, concurrentRequests: 2, timeoutMs: 4000 });
    await config.writeDashboardConfig({ ...dashboard, timeZone: "Asia/Taipei",
      autoRefresh: { ...dashboard.autoRefresh, retryOnError: true },
      factories: [factory("BP9P1", [["SNT23"], ["SNT24", false]])] });
    assert.equal((await config.readManufacturingConfig()).request.concurrentRequests, 2);
    assert.equal((await config.readManufacturingConfig()).request.timeoutMs, 4000);
    assert.deepEqual((await config.readDashboardConfig()).factories[0].lines,
      [{ name: "SNT23", enabled: true }, { name: "SNT24", enabled: false }]);
    assert.equal((await config.readDashboardConfig()).timeZone, "Asia/Taipei");
    assert.equal((await config.readDashboardConfig()).autoRefresh.retryOnError, true);
  } finally {
    if (previous === undefined) delete process.env.MES_CONFIG_DIR;
    else process.env.MES_CONFIG_DIR = previous;
    fs.unlinkSync(path.join(temp, "mfg-api.json"));
    fs.unlinkSync(path.join(temp, "dashboard.json"));
    fs.rmdirSync(temp);
  }
});
