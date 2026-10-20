"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getWorkOrders, localDateKey, ORDER_FIELDS, parseMesDate, ratio, toDisplay,
  type WorkOrder, type WorkOrderPayload,
} from "../lib/api";

const nfmt = new Intl.NumberFormat("en-US");
const pfmt = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}%`;
const orderState = (order: WorkOrder) => order.OUTPUT_QTY > 0 ? "有產出" : order.INPUT_QTY > 0 ? "已投入" : "尚無投入";

const FIELD_GROUPS = [
  { id: "identity", label: "工單與機種資訊" },
  { id: "production", label: "生產數量" },
  { id: "routing", label: "工廠、線體與流程" },
] as const;

function saveCsv(rows: WorkOrder[]) {
  if (!rows.length) return;
  const known = ORDER_FIELDS.map((field) => String(field.key));
  const extra = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => !known.includes(key));
  const keys = [...known, ...extra];
  const labelMap = Object.fromEntries(ORDER_FIELDS.map((field) => [field.key, field.label]));
  const safeCell = (value: unknown) => {
    let text = value === null || value === undefined ? "" : String(value);
    if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = keys.map((key) => safeCell(`${labelMap[key] ?? key} (${key})`)).join(",");
  const lines = rows.map((row) => keys.map((key) => safeCell(row[key])).join(","));
  const blob = new Blob(["\uFEFF", header, "\r\n", ...lines.map((line) => line + "\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `MES_WorkOrders_${rows[0].M_WONO}_${localDateKey(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Dashboard({ defaultMo, autoRefreshEnabled, refreshIntervalSeconds }: { defaultMo: string; autoRefreshEnabled: boolean; refreshIntervalSeconds: number }) {
  const [queryInput, setQueryInput] = useState(defaultMo);
  const [requestedMo, setRequestedMo] = useState(defaultMo);
  const [data, setData] = useState<WorkOrderPayload | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(autoRefreshEnabled);
  const [now, setNow] = useState<Date | null>(null);
  const [factory, setFactory] = useState("");
  const [line, setLine] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selectedMo, setSelectedMo] = useState("");
  const [showAllFields, setShowAllFields] = useState(true);
  const latestRequest = useRef(0);

  const refresh = useCallback(async (mo: string, signal?: AbortSignal) => {
    const id = ++latestRequest.current;
    setPending(true);
    try {
      const result = await getWorkOrders(mo, signal);
      if (id === latestRequest.current && !signal?.aborted) {
        setData(result);
        setError("");
        setNow(new Date());
      }
    } catch (caught) {
      if (id === latestRequest.current && !signal?.aborted) {
        setError(caught instanceof Error ? caught.message : "資料載入失敗");
      }
    } finally {
      if (id === latestRequest.current && !signal?.aborted) setPending(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setSelectedMo("");
    setFactory("");
    setLine("");
    setStartDate("");
    setEndDate("");
    setError("");
    void refresh(requestedMo, controller.signal);
    return () => { controller.abort(); latestRequest.current++; };
  }, [requestedMo, refresh]);

  useEffect(() => {
    if (!autoRefresh || refreshIntervalSeconds <= 0) return;
    const timer = window.setInterval(() => { void refresh(requestedMo); }, refreshIntervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refresh, requestedMo, refreshIntervalSeconds]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const records = useMemo(() => data?.MESSAGE ?? [], [data]);
  const root = useMemo(() => records.find((row) => row.MO_NUMBER === row.M_WONO && row.PARENT_MO === null)
    ?? records.find((row) => row.MO_NUMBER === requestedMo) ?? null, [records, requestedMo]);
  const factories = useMemo(() => [...new Set(records.map((row) => row.FACTORY))].sort(), [records]);
  const lines = useMemo(() => [...new Set(records.filter((row) => !factory || row.FACTORY === factory).map((row) => row.DEFAULT_LINE))].sort(), [records, factory]);

  const filtered = useMemo(() => records.filter((row) => {
    if (factory && row.FACTORY !== factory) return false;
    if (line && row.DEFAULT_LINE !== line) return false;
    if (startDate || endDate) {
      const d = parseMesDate(row.MO_START_DATE);
      if (!d) return false;
      const key = localDateKey(d);
      if (startDate && key < startDate) return false;
      if (endDate && key > endDate) return false;
    }
    return true;
  }), [records, factory, line, startDate, endDate]);

  const active = filtered.find((row) => row.MO_NUMBER === selectedMo) ?? filtered[0] ?? null;
  const subOrders = records.filter((row) => row.PARENT_MO !== null).length;
  const completion = root ? ratio(root.OUTPUT_QTY, root.TARGET_QTY) : null;
  const outputToInput = root ? ratio(root.OUTPUT_QTY, root.INPUT_QTY) : null;
  const extraFields = active ? Object.keys(active).filter((key) => !ORDER_FIELDS.some((f) => f.key === key)) : [];
  const allFields = [...ORDER_FIELDS.map((field) => ({ key: String(field.key), label: field.label })), ...extraFields.map((key) => ({ key, label: key }))];

  return (
    <main className="dashboard">
      <header className="site-header">
        <div className="brand-row">
          <span className="brand-mark">M</span>
          <div>
            <div className="eyebrow light">MANUFACTURING INTELLIGENCE / MES</div>
            <h1>工單生產監控中心 <span>Production Overview</span></h1>
          </div>
        </div>
        <div className="header-actions">
          <div className="time-display"><span>LOCAL TIME</span><strong>{now ? now.toLocaleTimeString("en-GB", { hour12: false }) : "--:--:--"}</strong></div>
          <label className="auto-control"><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /> 自動更新 {refreshIntervalSeconds}s</label>
          <button className="button button-ghost" onClick={() => void refresh(requestedMo)} disabled={pending}>{pending ? "更新中…" : "↻ 更新資料"}</button>
        </div>
      </header>

      <section className="toolbar panel">
        <div className="toolbar-main">
          <form className="search-form" onSubmit={(event) => {
            event.preventDefault();
            const next = queryInput.trim();
            if (!/^\d{6,20}$/.test(next)) return setError("請輸入 6–20 位數字工單號");
            if (next === requestedMo) void refresh(next);
            else setRequestedMo(next);
          }}>
            <label htmlFor="mo-input">工單號碼 <small>MO NUMBER</small></label>
            <div className="search-input-row"><input id="mo-input" inputMode="numeric" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="輸入工單號" /><button className="button button-primary" type="submit">查詢工單 →</button></div>
          </form>
          <div className="toolbar-divider" />
          <div className="filter-control"><label htmlFor="factory">工廠</label><select id="factory" value={factory} onChange={(event) => { setFactory(event.target.value); setLine(""); }}><option value="">全部工廠</option>{factories.map((item) => <option key={item} value={item}>{item}</option>)}</select></div>
          <div className="filter-control"><label htmlFor="line">線體</label><select id="line" value={line} onChange={(event) => setLine(event.target.value)}><option value="">全部線體</option>{lines.map((item) => <option key={item} value={item}>{item}</option>)}</select></div>
          <div className="filter-control date-control"><label htmlFor="from">開工日期起</label><input id="from" type="date" value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} /></div>
          <div className="filter-control date-control"><label htmlFor="to">開工日期迄</label><input id="to" type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} /></div>
        </div>
        <div className="toolbar-bottom"><span>工廠、線體、日期目前僅篩選所查工單的回傳資料；跨工單搜尋待工單清單 API 提供後啟用。</span><button className="text-button" onClick={() => { setFactory(""); setLine(""); setStartDate(""); setEndDate(""); }}>清除篩選</button></div>
      </section>

      {error && <div className="error-banner" role="alert"><b>資料讀取提醒：</b> {error}{data && <span>（保留上次成功取得的資料）</span>}</div>}
      {data?.source === "sample" && <div className="sample-banner"><strong>範例資料 SAMPLE DATA</strong> 目前顯示你提供的 API JSON 範例，非即時工廠資料。要串接正式資料，請填寫 config/mfg-api.json 憑證，再將 config/dashboard.json 的 dataSource 改為 live。</div>}

      <div className="overview-heading">
        <div><div className="eyebrow">LIVE WORK ORDER SNAPSHOT</div><h2>工單總覽 <span className="muted">/ {data?.queriedMo ?? requestedMo}</span></h2></div>
        <div className="data-status"><span className={data?.source === "live" ? "status-dot" : "status-dot muted-dot"} /> {data?.source === "live" ? "API 已連線" : data?.source === "sample" ? "範例資料" : "等待資料"}<span className="status-sep">|</span> 更新：{data ? new Date(data.fetchedAt).toLocaleString("zh-TW") : "—"}</div>
      </div>

      <section className="kpis">
        <Kpi title="主工單目標" caption="TARGET QTY" value={root ? nfmt.format(root.TARGET_QTY) : "—"} tone="blue" />
        <Kpi title="主工單投入" caption="INPUT QTY" value={root ? nfmt.format(root.INPUT_QTY) : "—"} />
        <Kpi title="主工單產出" caption="OUTPUT QTY" value={root ? nfmt.format(root.OUTPUT_QTY) : "—"} tone="green" />
        <Kpi title="在製數量" caption="WIP" value={root ? nfmt.format(root.WIP) : "—"} tone="amber" />
        <Kpi title="產出達成率" caption="OUTPUT / TARGET" value={pfmt(completion)} tone="green" />
        <Kpi title="相關工單" caption="MO COUNT" value={data ? `${records.length}` : "—"} suffix={data ? `含 ${subOrders} 筆子工單` : undefined} />
      </section>

      <div className="insights-grid">
        <section className="panel featured-panel">
          <div className="panel-top"><div><div className="eyebrow">PRIMARY MANUFACTURING ORDER</div><h3>主工單生產進度</h3></div>{root && <span className="pill pill-blue">MO {root.MO_NUMBER}</span>}</div>
          {root ? <>
            <div className="product-summary"><div><span className="summary-tag">MODEL NAME</span><strong>{root.MODEL_NAME}</strong><p>{root.MODEL_DESC}</p></div><div className="product-meta"><span>工廠 <b>{root.FACTORY}</b></span><span>線體 <b>{root.DEFAULT_LINE}</b></span><span>客戶 <b>{root.CUST_CODE}</b></span></div></div>
            <div className="completion-header"><span>工單完成進度（產出 / 目標）</span><strong>{pfmt(completion)}</strong></div>
            <div className="progress-track"><div style={{ width: `${Math.min(100, Math.max(0, completion ?? 0))}%` }} /></div>
            <div className="progress-axis"><span>0</span><span>{nfmt.format(root.TARGET_QTY)} pcs target</span></div>
            <div className="mini-metrics">
              <MiniMetric label="SAP 數量" value={root.SAP_QTY} />
              <MiniMetric label="包裝數量" value={root.PACKING_QTY} />
              <MiniMetric label="Fail 數量" value={root.FAIL_QTY} warning />
              <MiniMetric label="報廢數量" value={root.TOTAL_SCRAP_QTY} warning />
            </div>
          </> : <Empty message={pending ? "正在取得主工單資料…" : "本次結果沒有可辨識的主工單"} />}
        </section>

        <section className="panel side-summary">
          <div className="panel-top"><div><div className="eyebrow">QUICK FACTS</div><h3>工單關鍵資訊</h3></div></div>
          <div className="fact-list">
            <Fact label="主工單號" value={root?.MO_NUMBER} />
            <Fact label="建立日期" value={root?.MO_CREATE_DATE} />
            <Fact label="開工時間" value={root?.MO_START_DATE} />
            <Fact label="生產廠區" value={root?.PROD_PLANT} />
            <Fact label="產出站別" value={root?.OUTPUT_GROUP} />
            <Fact label="流程代碼" value={root?.ROUTE_CODE} />
            <Fact label="產出 / 投入比例" value={pfmt(outputToInput)} />
          </div>
          <p className="panel-note">產出 / 投入比例不等於 OEE、FPY 或良率。不同階工單的數量不可直接加總。</p>
        </section>
      </div>

      <section className="panel orders-panel">
        <div className="panel-top order-heading"><div><div className="eyebrow">WORK ORDER HIERARCHY</div><h3>主工單與子工單 <span className="count-tag">{filtered.length} / {records.length} 筆</span></h3></div><div className="panel-actions"><span>選擇工單查看下方完整欄位</span><button className="button button-outline" onClick={() => saveCsv(filtered)} disabled={!filtered.length}>↓ 匯出 CSV</button></div></div>
        {filtered.length ? <div className="workorder-list">
          {filtered.map((order) => {
            const isRoot = order.PARENT_MO === null || order.MO_NUMBER === order.M_WONO;
            const pct = ratio(order.OUTPUT_QTY, order.TARGET_QTY);
            return <button type="button" className={`workorder-card ${active?.MO_NUMBER === order.MO_NUMBER ? "selected" : ""}`} key={order.MO_NUMBER} onClick={() => setSelectedMo(order.MO_NUMBER)}>
              <div className="mo-identity"><div className="mo-title"><span className={isRoot ? "pill pill-blue" : "pill pill-purple"}>{isRoot ? "主工單" : "子工單"}</span><strong>{order.MO_NUMBER}</strong><span className="small-status">{orderState(order)}</span></div><b className="model-name">{order.MODEL_NAME}</b><span className="model-desc" title={order.MODEL_DESC}>{order.MODEL_DESC}</span><small>線體 {order.DEFAULT_LINE} · {order.OUTPUT_GROUP}</small></div>
              <div className="mo-quantities">
                <DataPoint label="TARGET" value={order.TARGET_QTY} />
                <DataPoint label="INPUT" value={order.INPUT_QTY} />
                <DataPoint label="OUTPUT" value={order.OUTPUT_QTY} emphasized />
                <DataPoint label="WIP" value={order.WIP} />
                <div className="mo-progress"><strong>{pfmt(pct)}</strong><span>產出 / 目標</span><div className="small-progress"><i style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} /></div></div>
              </div>
              <span className="row-arrow">›</span>
            </button>;
          })}
        </div> : <Empty message={data ? "沒有符合篩選條件的工單；請調整工廠、線體或開工日期。" : pending ? "正在讀取工單資料…" : "目前沒有工單資料。請檢查 API 設定並重新整理。"} />}
      </section>

      <section className="panel detail-panel">
        <div className="panel-top"><div><div className="eyebrow">FULL API DATA / SELECTED ORDER</div><h3>工單完整明細 <span className="subtle-code">{active?.MO_NUMBER ?? "未選取"}</span></h3></div>{active && <span className="pill pill-blue">{allFields.length} 個欄位</span>}</div>
        {active ? <div className="detail-groups">
          {FIELD_GROUPS.map((group) => <div className="detail-group" key={group.id}><h4>{group.label}</h4><div className="field-grid">{ORDER_FIELDS.filter((field) => field.group === group.id).map((field) => <div className="field-item" key={field.key}><span>{field.label}<small>{field.key}</small></span><strong title={toDisplay(active[field.key])}>{toDisplay(active[field.key])}</strong></div>)}</div></div>)}
          {extraFields.length > 0 && <div className="detail-group"><h4>其他 API 欄位</h4><div className="field-grid">{extraFields.map((field) => <div className="field-item" key={field}><span>{field}</span><strong>{toDisplay(active[field])}</strong></div>)}</div></div>}
        </div> : <Empty message="請先取得工單資料並選取一筆工單。" />}
      </section>

      <section className="panel raw-panel">
        <div className="panel-top"><div><div className="eyebrow">DATA GRID / ALL RECORDS</div><h3>API 全欄位資料表</h3></div><button className="button button-outline" onClick={() => setShowAllFields(!showAllFields)}>{showAllFields ? "收合表格" : "展開表格"}</button></div>
        {showAllFields && <><p className="scroll-hint">共 {allFields.length} 欄（原 API 24 欄，額外欄位自動顯示） · 左右捲動查看全部資料 · — 代表 null 或空值</p><div className="table-scroll"><table><thead><tr>{allFields.map((field) => <th key={field.key}><span>{field.label}</span><small>{field.key}</small></th>)}</tr></thead><tbody>{filtered.map((order) => <tr key={order.MO_NUMBER} className={active?.MO_NUMBER === order.MO_NUMBER ? "highlight-row" : ""} onClick={() => setSelectedMo(order.MO_NUMBER)}>{allFields.map((field) => <td key={field.key} title={toDisplay(order[field.key])}>{toDisplay(order[field.key])}</td>)}</tr>)}</tbody></table></div>{!filtered.length && <Empty message="目前沒有可顯示的資料列。" />}</>}
      </section>

      <footer className="footer"><span>MES Manufacturing Dashboard · 查詢工單 {data?.queriedMo ?? requestedMo} · RESULT: {data?.RESULT ?? "—"} · 畫面提供工單層級資料，非站點即時 OEE</span><span>Data source: {data?.source === "live" ? "Manufacturing API" : data?.source === "sample" ? "Sample JSON" : "Not connected"}</span></footer>
    </main>
  );
}

function Kpi({ title, caption, value, tone = "", suffix }: { title: string; caption: string; value: string; tone?: string; suffix?: string }) {
  return <div className={`kpi ${tone}`}><span className="kpi-caption">{caption}</span><span className="kpi-title">{title}</span><strong>{value}</strong><span className="kpi-suffix">{suffix || "pcs · 工單層級"}</span></div>;
}
function MiniMetric({ label, value, warning = false }: { label: string; value: number; warning?: boolean }) {
  return <div className="mini-metric"><span>{label}</span><b className={warning && value > 0 ? "orange-text" : ""}>{nfmt.format(value)}</b></div>;
}
function DataPoint({ label, value, emphasized = false }: { label: string; value: number; emphasized?: boolean }) {
  return <div className="data-point"><span>{label}</span><strong className={emphasized ? "green-text" : ""}>{nfmt.format(value)}</strong></div>;
}
function Fact({ label, value }: { label: string; value: string | number | null | undefined }) {
  return <div className="fact"><span>{label}</span><b>{toDisplay(value ?? null)}</b></div>;
}
function Empty({ message }: { message: string }) {
  return <div className="empty-state">{message}</div>;
}
