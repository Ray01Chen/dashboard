import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const configDir = process.env.MES_CONFIG_DIR || path.join(root, "config");
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
const settings = json(path.join(configDir, "dashboard.json"));
const api = json(path.join(configDir, "mfg-api.json"));
const validZone = zone => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } };

assert.ok(validZone(settings.timeZone), "Invalid display time zone");
assert.ok(Array.isArray(settings.factories) && settings.factories.length <= 20, "Invalid factories");
assert.ok(settings.factories.every(factory => typeof factory.name === "string" && factory.name.length > 0 &&
  typeof factory.mesFactory === "string" && factory.mesFactory.length > 0 &&
  (factory.enabled === undefined || typeof factory.enabled === "boolean") && Array.isArray(factory.lines) &&
  factory.lines.every(line => typeof line === "string" ? line.length > 0 :
    line && typeof line.name === "string" && line.name.length > 0 && typeof line.enabled === "boolean")),
"Invalid factory or line");
assert.ok(typeof settings.autoRefresh.enabled === "boolean" &&
  Number.isInteger(settings.autoRefresh.intervalSeconds) &&
  settings.autoRefresh.intervalSeconds >= 5 && settings.autoRefresh.intervalSeconds <= 3600,
  "Invalid refresh interval");
assert.ok(api.oauth.url === "https://mfg-apim-th.deltaww.com/oauth2/token", "Unexpected OAuth URL");
assert.ok(typeof api.oauth.clientId === "string" && api.oauth.clientId &&
  typeof api.oauth.clientSecret === "string" && api.oauth.clientSecret, "Missing OAuth credentials");
assert.ok(api.apis.lineInformation.url.includes("/{mesFactory}/line/information/{line}"), "Line URL needs MES factory and line");
assert.ok(api.apis.workOrderDetail.url.includes("/{mesFactory}/MO/information/{mo}"), "Work order URL needs MES factory and order");
for (const [key, min, max] of [
  ["timeoutMs", 1000, 120000], ["tokenExpirySafetySeconds", 0, 600],
  ["fallbackTokenExpiresSeconds", 60, 86400], ["concurrentRequests", 1, 20],
]) assert.ok(Number.isInteger(api.request[key]) && api.request[key] >= min && api.request[key] <= max, `Invalid ${key}`);

// Fixtures verify the two response shapes; runtime requests only use the MES APIs.
const line = json(path.join(root, "data/production-lines.sample.json"));
const orders = json(path.join(root, "data/work-orders.sample.json"));
assert.ok(typeof line.CURRENT_MO === "string" && typeof line.CURRENT_MODEL === "string", "Line fixture needs current order and model");
assert.ok(Array.isArray(line.UTILIZATION_MACHINE) && Array.isArray(line.STD_ARCHIVE_DATA) &&
  Array.isArray(line.STD_ARCHIVE_WIP), "Line fixture metrics are incomplete");
assert.equal(orders.RESULT, "OK");
assert.ok(Array.isArray(orders.MESSAGE) && orders.MESSAGE.some(order => order.MO_NUMBER === line.CURRENT_MO),
  "Order fixture must include current main order");
assert.ok(orders.MESSAGE.some(order => order.PARENT_MO === line.CURRENT_MO && order.MO_NUMBER !== line.CURRENT_MO),
  "Order fixture must include child orders");
console.log(`PASS: ${settings.factories.reduce((count, factory) => count + factory.lines.length, 0)} configured line(s), two live API templates, response contracts`);
