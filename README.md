# MES 工單生產監控 Dashboard (V3)

Next.js 15 + React 19 + TypeScript，**不需要 Python**。Dashboard 顯示主工單與子工單、24 個 MES 欄位、生產數量、CSV 匯出。

## 安裝與啟動

需求：Node.js 20+。

```bash
npm install
npm run check:config
npm run dev
```

開啟 http://localhost:3000。目前預設 **sample 模式**，本機 JSON 中有使用者提供的 5 筆工單資料。畫面會顯示 `SAMPLE DATA`，不會假裝是實際 MES 數據。

## 專案結構

```text
production-efficiency-frontend/
├── app/
│   ├── api/
│   │   └── work-orders/
│   │       ├── route.ts             # GET /api/work-orders?mo=xxx
│   │       └── search/route.ts      # 多工單搜尋入口；第二支 API 待提供，回 501
│   ├── page.tsx                     # 讀取 Dashboard 設定，傳遞給 React
│   ├── layout.tsx
│   └── globals.css
├── components/
│   └── Dashboard.tsx                # UI、KPI、資料表與本次工單內篩選
├── config/
│   ├── mfg-api.json                 # OAuth、雙 API URL、連線參數（有機密）
│   ├── mfg-api.example.json         # 不含 Secret 的範本
│   └── dashboard.json               # 模式、初始工單、範例讀取路徑、自動刷新
├── data/
│   └── work-orders.sample.json      # 範例 MES JSON（不是設定）
├── lib/
│   ├── api.ts                       # 回傳型別、欄位定義與前端查詢
│   └── server/
│       ├── mfg-config.ts            # 伺服器端讀 config/*.json
│       ├── mfg-client.ts            # OAuth、MES 查詢、併行查詢
│       └── sample-data.ts           # 按 dashboard.json 的路徑讀取範例 JSON
├── scripts/check-config.mjs        # 本地 JSON / 路徑檢查
├── package.json                    # Node/npm 的標準根目錄檔案
└── tsconfig.json                   # TypeScript 的標準根目錄檔案
```

## 外部設定：`config/mfg-api.json`

```json
{
  "oauth": {
    "url": "https://mfg-apim-th.deltaww.com/oauth2/token",
    "clientId": "",
    "clientSecret": ""
  },
  "apis": {
    "workOrderList": { "url": "" },
    "workOrderDetail": { "url": "https://mfg-apim-gateway-th.deltaww.com/DETMFGAPI/BP3_AE/v1/api/DET_HP/MO/information/{mo}" }
  },
  "request": {
    "timeoutMs": 20000,
    "tokenExpirySafetySeconds": 60,
    "fallbackTokenExpiresSeconds": 300,
    "maxWorkOrdersPerSearch": 100,
    "concurrentDetailRequests": 4
  }
}
```

所有遠端 API 網址都統一使用 **`url`**；`{mo}` 由後端呼叫時替換，不是固定工單。`workOrderList.url` 尚未取得規格，故先留空。

`request` 可調整 API Timeout、OAuth Token 提前刷新緩衝、Token 有效期缺失時的預設值、未來批次最多查幾張工單，以及同時查詢數量。這些設定具有驗證及安全上限。

## 外部設定：`config/dashboard.json`

```json
{
  "dataSource": "sample",
  "initialMo": "3572611722",
  "sampleDataFile": "data/work-orders.sample.json",
  "autoRefresh": {
    "enabled": true,
    "intervalSeconds": 30
  }
}
```

- `dataSource`: `sample` / `live`。正式連接 MES 時，填妥 OAuth 資訊後改成 `live`。
- `initialMo`: **只是畫面輸入框的初始工單**，不限制正式模式查詢其他工單。
- `sampleDataFile`: **從專案根目錄算起的相對路徑**，可以換到其他專案內 `.json` 檔案。不是公司 API URL，也不是供瀏覽器讀取的 `public/` 資料。
- `autoRefresh.enabled`: 預設是否勾選自動更新。
- `autoRefresh.intervalSeconds`: 自動更新間隔（5–3600 秒）。

## 哪些路徑能改，哪些不能任意改？

1. **遠端 OAuth / MES API URL**：設定於 `config/mfg-api.json`。
2. **本地 sample JSON 的讀取路徑**：設定於 `config/dashboard.json` 的 `sampleDataFile`。
3. **設定資料夾的起始路徑**：預設為專案根目錄的 `config/`。必要時，可透過部署環境變數 `MES_CONFIG_DIR` 指定另一個完整資料夾路徑（此為「先找到設定檔」的啟動參數，不能放到尚未讀取的 JSON 裡）。
4. **Next.js 路由 / 檔案 import 路徑**：由框架與 TypeScript 的程式結構決定。改寫成 JSON 卻沒有同步建立新 route，會使系統失效，因此不設計成使用者可任意變更的參數。
5. `package.json`、`tsconfig.json`：Node.js / TypeScript 的根目錄標準設定，保留原位。

## API 資料流

```text
瀏覽器 Dashboard
    → GET /api/work-orders?mo=3572611722
    → Next.js 伺服器端 API Route
      → config/dashboard.json: sample / live
      → sample: 讀取 sampleDataFile 指定的 JSON
      → live: 從 config/mfg-api.json 取得 OAuth Token + API URL
              → GET /MO/information/{mo}
    → Dashboard 呈現主工單、子工單、24 個欄位
```

未來工單清單 API：

```text
工廠 + 線體 + 時間
    → /api/work-orders/search
    → workOrderList.url（目前規格尚未提供，回 501）
    → 工單號陣列
    → 針對每張工單呼叫 workOrderDetail.url
    → 多工單 Dashboard（後續開發）
```

**目前工廠／線體／日期只是所查工單回傳結果的前端篩選，不是跨工單搜尋。** API 清單的 method、傳參方式、回傳格式未提供前，不猜測實作。

## 安全提醒

- `mfg-api.json` 含機密，已加入 `.gitignore`。請在部署環境安全存放；實際 Client Secret 不得放 `public/`、`NEXT_PUBLIC_*` 或公開 Git。
- `mfg-api.example.json` 不含機密，適合版控。要注意：含有真實 Secret 的 ZIP 也不能公開傳送。
- OAuth Token 和 Client Secret 只在 Node.js 伺服器端使用。正式內部部署應額外保護 API Route 的使用者授權與流量。
- `sampleDataFile` 限制在專案內，避免讀取任意伺服器檔案。
- 若舊憑證曾被分享或放在 Git，應進行輪替。

## 驗證

`npm run check:config` 可離線檢查設定格式、數值範圍與範例 JSON。`npm run build` 用於完整 Next.js 編譯；正式 MES 網路連線必須在公司網路／VPN 驗證。
