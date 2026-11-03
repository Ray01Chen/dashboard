# Production Pulse

MES dashboard for selected factories and production lines. Select an enabled factory in the header to load its enabled lines from the line information API and each line's current work orders from the work order API. The overview shows output, target, input, WIP, remaining quantity, and progress for each line. Opening a line shows the related main and sub work orders and detailed line metrics from the same update.

## Run

Requires Git and Node.js **20.9 or later**; Node.js **24 LTS** is recommended and selected by `.nvmrc` when using nvm. Check `node --version` and `npm --version` first. If either command is missing, install Node.js and reopen your terminal.

### 新主機第一次安裝 / First setup

```bash
git clone https://github.com/Ray01Chen/dashboard.git
cd dashboard
npm ci
npm run setup
```

已有專案的主機先執行 `git pull --ff-only`，再執行 `npm ci` 和 `npm run setup`。

**啟動前必須設定 MES 憑證。** `npm run setup` 會從 Git 內的 `config/mfg-api.example.json` 建立本機的 `config/mfg-api.json`。請將原主機可用的 `config/mfg-api.json` 安全複製到新主機的相同位置，取代空白範本；也可以手動填入 `oauth.clientId`、`oauth.clientSecret`，並確認 API 網址。搬移時若也要保留原主機的工廠、產線與更新設定，請一併複製 `config/dashboard.json`。新主機還必須能透過公司網路或 VPN 連線到 MES。

Before starting, copy `config/mfg-api.json` from the working server or fill in its OAuth credentials. This file is intentionally ignored by Git because it contains secrets; a clone includes the template, not the credentials. Setup preserves existing configuration and also initializes both files in `MES_CONFIG_DIR` when that variable points to a separate configuration directory. Use the same variable for setup, checks, and the server.

設定完成後 / After configuring credentials:

```bash
npm run check:config
npm run dev
```

Open http://localhost:3000. For a production server:

```bash
npm run build
npm start
```

`npm start` requires a successful build on that host. Install all dependencies with `npm ci` before building. `node_modules/`, `.next/`, and `.next-dev/` are generated locally rather than downloaded from Git; `package-lock.json` is tracked so `npm ci` installs the recorded versions for the host's operating system.

If the page reports **Missing server mfg-api.json**, run setup and configure the credentials as above. **Missing OAuth credentials** means the generated file still has blank credentials. A valid config check confirms the file format, not network connectivity or whether MES accepts the credentials.

Runtime requests never read sample or example files. The files in `data/` are fixtures for contract tests only.
Development output is written to `.next-dev`, while `npm run build` writes to `.next`. A build can run while the development server is open without replacing its page files.

## Live API configuration

`config/mfg-api.json` is the only source for OAuth credentials, both endpoint templates, and MES request settings. Its structure is:

```json
{
  "oauth": {
    "url": "https://mfg-apim-th.deltaww.com/oauth2/token",
    "clientId": "<server-side client ID>",
    "clientSecret": "<server-side client secret>"
  },
  "apis": {
    "lineInformation": {
      "url": "https://mfg-apim-gateway-th.deltaww.com/DETMFGAPI/BP3_AE/v1/api/{mesFactory}/line/information/{line}"
    },
    "workOrderDetail": {
      "url": "https://mfg-apim-gateway-th.deltaww.com/DETMFGAPI/BP3_AE/v1/api/{mesFactory}/MO/information/{mo}"
    }
  },
  "request": {
    "timeoutMs": 20000,
    "tokenExpirySafetySeconds": 60,
    "fallbackTokenExpiresSeconds": 300,
    "concurrentRequests": 4,
    "maxRequestsPerMinute": 18,
    "retryCount": 2
  }
}
```

For each enabled line in the selected factory, the server substitutes that factory's MES code and the line name in API 1. If API 1 returns a current `CURRENT_MO`, the overview substitutes it into API 2, displays the main order quantities, and retains the related orders for the line detail view. Opening the line uses that response without repeating the same request; a failed detail lookup can be retried from the line view. The request settings can be edited in the Settings screen; credentials and URLs are never returned to the browser. `MES_CONFIG_DIR` can point to a separate server configuration directory.

`retryCount` sets the number of automatic retries after the first failed request (0–10, default 2 for older configurations). It applies to OAuth connection errors and 5xx responses, and to API 1 and API 2 connection errors, HTTP 404, 429, 5xx, and one token refresh after HTTP 401. All retries for one request share this limit, so 0 makes only the first attempt. For HTTP 429, the server records `Retry-After` or the gateway's `nextAccessTime` and waits until the quota resets only when a retry remains; it does not send rapid retries. A failed line or order lookup shows its own error; other lines remain visible. After an intermittent failure, the last successful line and main order values remain visible for up to five minutes with a stale label when the current order is unchanged. A failed full detail request shows an error in the line view, with the last successful detail shown for up to five minutes when the current order is unchanged.
The browser shows the actual OAuth, line API, and work order API attempt number, or the next retry time while waiting for quota. `concurrentRequests` caps simultaneous line workers; each worker calls API 1 then, when there is a current order, API 2. `maxRequestsPerMinute` is a shared rolling-minute budget for line and work-order requests in one server process; older configurations default to 18. Set it below the application's actual gateway quota, allowing room for other clients that use the same credentials. Successful same-factory refreshes are shared across viewers and cached for at least the configured interval. When a full refresh would exceed the minute budget, the cache interval grows automatically; for seven active lines and the default budget of 18, that is 60 seconds. Manual Refresh bypasses the completed snapshot but still obeys the shared request budget. Scheduled refresh never starts a second browser request while one is in flight. With **Keep retrying after API errors** off, an exhausted request pauses that factory until someone presses Refresh and every selected line succeeds; the pause survives browser reloads. With it on, the same factory is retried at every interval despite failures, and a later fully successful response clears the failure flag. Other factories keep their own failure state. The compact overview keeps production quantities visible and shows utilization, yield, throughput, and last process on hover or keyboard focus; the same information is available in line details on touch screens.
In a line view, the selected work order's full fields are the main panel. A compact, independently scrolling list of main and sub orders sits beside it on desktop and moves above it on narrow screens so an operator can change orders without scrolling through every field. The list shows model and output progress; the selected panel contains all returned work order fields. Rows with the same MO number remain distinct by model and output group.

## Settings and time zones

`config/dashboard.json` stores the factory name, one MES factory code per factory, and its line names. Factories and individual lines can be enabled or disabled. The selected factory and these switches directly control which API 1 and API 2 URLs are called; disabled lines cannot be opened through API 2. The dashboard initially selects the first enabled factory. Settings also stores whether scheduled refresh is enabled, its interval, the continuous retry switch, and an IANA display time zone; the default is `Asia/Bangkok`. Older settings files without the retry switch retain pause-on-error behavior.
Saving Settings takes effect immediately: the server reads the updated files on the next request, and auto refresh uses the new interval and retry mode. The per-request `retryCount` is separate from **Keep retrying after API errors**, which controls whether future scheduled refreshes continue after a failure. A factory already paused in pause-on-error mode still waits for a successful manual Refresh. No service restart or manual browser reload is needed.

The API's date and time values without an explicit offset are interpreted as factory time (UTC+7), then displayed in the chosen time zone. Date-only work order fields remain calendar dates. The clock, last updated timestamps, cached detail timestamp, work order date and time fields, other reported timestamp fields, hourly time slots, and exported CSV date/time fields use the selected display time zone. Raw API values stay intact; the display and export convert them. English and day theme are the initial browser defaults; the theme button names the current theme (Day in light mode, Night in dark mode). English, Traditional Chinese, and Thai are available.

## Checks

```bash
npm run check:config
npm test
npx tsc --noEmit
npm run build
```

The config check validates the server config and response fixtures. Tests cover time zone conversion, API retries and progress, settings reload, API response behavior, and the line request concurrency limit. Build and type checks validate server routes and the interface.
