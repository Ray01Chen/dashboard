/** Offline checks; never print Client ID or Client Secret. */
import fs from 'node:fs';
import path from 'node:path';

function fail(message) { throw new Error(message); }
function parseJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function inRange(v, min, max) { return Number.isInteger(v) && v >= min && v <= max; }

const dir = process.env.MES_CONFIG_DIR || path.join(process.cwd(), 'config');
const live = parseJson(path.join(dir, 'mfg-api.json'));
const example = parseJson(path.join(dir, 'mfg-api.example.json'));
const dashboard = parseJson(path.join(dir, 'dashboard.json'));
for (const [name, c] of [['mfg-api.json', live], ['mfg-api.example.json', example]]) {
  if (!c.oauth || !c.apis?.workOrderDetail || !c.apis?.workOrderList || !c.request) fail(`${name}: 缺少 OAuth、API 或 request 設定`);
  if (typeof c.oauth.url !== 'string' || typeof c.oauth.clientId !== 'string' || typeof c.oauth.clientSecret !== 'string') fail(`${name}: OAuth 格式錯誤`);
  if (typeof c.apis.workOrderList.url !== 'string' || typeof c.apis.workOrderDetail.url !== 'string') fail(`${name}: API 網址欄位必須統一使用 url`);
  if (!c.apis.workOrderDetail.url.includes('{mo}')) fail(`${name}: detail URL 缺少 {mo}`);
  if (!c.oauth.url.startsWith('https://') || !c.apis.workOrderDetail.url.startsWith('https://') ||
      (c.apis.workOrderList.url && !c.apis.workOrderList.url.startsWith('https://'))) fail(`${name}: 必須使用 HTTPS`);
  if (!inRange(c.request.timeoutMs, 1000, 120000) ||
      !inRange(c.request.tokenExpirySafetySeconds, 0, 600) ||
      !inRange(c.request.fallbackTokenExpiresSeconds, 60, 86400) ||
      !inRange(c.request.maxWorkOrdersPerSearch, 1, 500) ||
      !inRange(c.request.concurrentDetailRequests, 1, 20)) fail(`${name}: request 設定超出範圍`);
  if ('defaultMo' in c || 'allowOtherMo' in c || 'useMockData' in c) fail(`${name}: 不應限制查詢工單`);
}
if (!['sample', 'live'].includes(dashboard.dataSource) || !/^\d{6,20}$/.test(dashboard.initialMo)) fail('dashboard.json: 模式或 initialMo 錯誤');
if (!dashboard.autoRefresh || typeof dashboard.autoRefresh.enabled !== 'boolean' ||
    !inRange(dashboard.autoRefresh.intervalSeconds, 5, 3600)) fail('dashboard.json: autoRefresh 錯誤');
if (!dashboard.sampleDataFile || path.isAbsolute(dashboard.sampleDataFile)) fail('dashboard.json: sampleDataFile 必須是相對路徑');
const sampleFile = path.resolve(process.cwd(), dashboard.sampleDataFile);
const relative = path.relative(process.cwd(), sampleFile);
if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('.json')) fail('dashboard.json: sampleDataFile 不可指向專案外');
const sample = parseJson(sampleFile);
if (sample.RESULT !== 'OK' || !Array.isArray(sample.MESSAGE) || !sample.MESSAGE.every(row => row && typeof row.MO_NUMBER === 'string')) fail('sample JSON: 資料格式錯誤');
if (!sample.MESSAGE.some(row => row.M_WONO === dashboard.initialMo || row.MO_NUMBER === dashboard.initialMo)) console.warn('提醒：初始工單不在 sample JSON 中；sample 模式會顯示找不到工單。');
console.log(`PASS: JSON 設定及 ${sample.MESSAGE.length} 筆範例工單；API URL 統一為 url；檔案路徑與可調整參數符合規範。`);
