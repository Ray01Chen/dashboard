"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayValue, getDashboard, getWorkOrders, progress, saveSettings, workOrderRowKeys, type DashboardPayload, type SettingsPayload,
  type ApiProgress, type LineInformation, type LineResult, type WorkOrder } from "../lib/api";
import { orderFieldGroups, orderFieldNames, translations, type Language } from "../lib/i18n";
import { nextAutoRefreshPaused, shouldAutoRefresh } from "../lib/refresh-policy";
import { formatClock, formatMesField, formatMesSlot, formatTimeZoneOffset, formatTimestamp } from "../lib/time";

type Theme = "light" | "dark";
type FactoryDraft = { name: string; mesFactory: string; enabled: boolean;
  lines: { name: string; enabled: boolean }[] };
type View = "overview" | "line" | "settings";
const lineKey = (item: LineResult) => item.factory + "\0" + item.line;
const firstEnabledFactory = (settings: SettingsPayload) => settings.factories.find(factory => factory.enabled)?.name || "";
const factoryDrafts = (settings: SettingsPayload): FactoryDraft[] =>
  settings.factories.map(factory => ({ name: factory.name, mesFactory: factory.mesFactory,
    enabled: factory.enabled, lines: factory.lines.map(line => ({ ...line })) }));
const amount = (value: unknown, language: Language) => displayValue(value, language);
const isTimestampField = (key: string, value: unknown): value is string =>
  typeof value === "string" && /(?:_DATE|_TIME|_AT|TIMESTAMP)$/.test(key);
const fieldValue = (key: string, value: unknown, language: Language, timeZone: string) =>
  isTimestampField(key, value) ? formatMesField(value, language, timeZone) : amount(value, language);
const pct = (value: number | null | undefined, language: Language) =>
  value === null || value === undefined ? "—" : `${amount(value, language)}%`;
const barWidth = (value: number | null | undefined) => `${Math.max(0, Math.min(100, value || 0))}%`;
const mainOrder = (line: LineResult) =>
  line.orders.find(order => order.MO_NUMBER === line.information?.CURRENT_MO?.trim()) ||
  line.orders.find(order => !order.PARENT_MO || order.PARENT_MO === order.MO_NUMBER);

function exportCsv(line: LineResult, language: Language, timeZone: string) {
  if (!line.orders.length) return;
  const columns = [...new Set(line.orders.flatMap(order => Object.keys(order)))];
  const cell = (value: unknown) => {
    let content = value == null ? "" : String(value);
    if (/^[\s]*[=+\-@\t\r]/.test(content)) content = "'" + content;
    return `"${content.replaceAll('"', '""')}"`;
  };
  const csv = [columns.map(cell).join(","), ...line.orders.map(order => columns.map(key => {
    const value = order[key];
    return cell(isTimestampField(key, value) ? formatMesField(value, language, timeZone) : value);
  }).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `MES_${line.factory}_${line.line}.csv`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}

function LoadingStatus({ message, event, language, compact = false }: {
  message: string; event: ApiProgress | null; language: Language; compact?: boolean;
}) {
  const t = translations[language];
  const step = event?.stage === "oauth" ? t.oauthStep : event?.stage === "order" ? t.orderStep : t.lineStep;
  const detail = event?.attempt
    ? `${t.trying} ${step} ${event.attempt}/${event.maxAttempts}${event.line ? ` · ${event.factory} / ${event.line}` : ""}`
    : event?.total ? `${event.completed || 0}/${event.total} ${t.completed}` : t.connecting;
  return <div className={`loading-status ${compact ? "compact" : "panel"}`} role="status" aria-live="polite">
    <span className="loading-spinner" aria-hidden="true" /><div><strong>{message}</strong><small>{detail}</small></div>
  </div>;
}

function DataTable({ headers, rows, empty }: { headers: string[]; rows: (string | number)[][]; empty: string }) {
  if (!rows.length) return <p className="empty-inline">{empty}</p>;
  return <div className="table-scroll"><table><thead><tr>{headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
}

function WorkOrderFields({ order, language, timeZone }: { order: WorkOrder; language: Language; timeZone: string }) {
  const t = translations[language];
  const named = new Set<string>(Object.values(orderFieldGroups).flat());
  const groups: { label: string; keys: string[] }[] = [
    { label: t.identity, keys: [...orderFieldGroups.identity] },
    { label: t.quantities, keys: [...orderFieldGroups.quantities] },
    { label: t.routing, keys: [...orderFieldGroups.routing] },
    { label: t.otherFields, keys: Object.keys(order).filter(key => !named.has(key)) },
  ];
  return <div className="field-sections">{groups.filter(group => group.keys.some(key => key in order)).map(group =>
    <section key={group.label} className="field-section"><h3>{group.label}</h3><div className="field-grid">
      {group.keys.filter(key => key in order).map(key => <div key={key} className="field">
        <span>{orderFieldNames[language][key] || key}<small>{key}</small></span>
        <strong>{fieldValue(key, order[key], language, timeZone)}</strong>
      </div>)}
    </div></section>)}</div>;
}

function LineInformationSections({ info, language, timeZone, reference }: {
  info: LineInformation; language: Language; timeZone: string; reference: string;
}) {
  const t = translations[language];
  const archives = info.STD_ARCHIVE_DATA || [];
  const slots = [...new Set(archives.flatMap(row => Object.keys(row).filter(key => /^T\d{4}_\d{4}$/.test(key))))].sort();
  const processes = [...new Set(archives.map(row => row.PROCESS_NAME))];
  const archiveRows = processes.flatMap(process => slots.map(slot => {
    const plan = archives.find(row => row.PROCESS_NAME === process && row.QTY_TYPE === "PLAN_QTY");
    const actual = archives.find(row => row.PROCESS_NAME === process && row.QTY_TYPE === "REAL_QTY");
    return [process, formatMesSlot(slot, reference, language, timeZone),
      amount(plan?.[slot], language), amount(actual?.[slot], language)];
  }));
  const known = new Set(["CURRENT_MO", "CURRENT_MODEL", "UTILIZATION_RATE_TODAY", "UTILIZATION_RATE_YESTERDAY",
    "UTILIZATION_MACHINE", "AVERAGE_TBS", "AVERAGE_TBS_MACHINE", "AUTOMATION_DEGREE", "DL_COUNT",
    "EQUIPMENT_COUNT", "CALCULATE_DAY", "FPYR", "UPH", "OI_RATE", "LINE_BALANCE",
    "STD_ARCHIVE_PERCENTAGE_DATA", "STD_ARCHIVE_DATA", "STD_ARCHIVE_WIP"]);
  const extras = Object.entries(info).filter(([key]) => !known.has(key));
  return <div className="line-data-grid">
    <section className="panel data-section">
      <h3>{t.utilizationMachines} <small>{info.UTILIZATION_MACHINE.length}</small></h3>
      {info.UTILIZATION_MACHINE.length ? <div className="machine-list">{info.UTILIZATION_MACHINE.map((machine, index) =>
        <div className="machine-item" key={machine.EQUIPMENT_CODE + index}>
          <div><strong>{machine.MACHINE_NAME && machine.MACHINE_NAME !== "N/A" ? machine.MACHINE_NAME : machine.EQUIPMENT_CODE}</strong>
            <small>{machine.MACHINE_NAME && machine.MACHINE_NAME !== "N/A" ? machine.EQUIPMENT_CODE : ""}</small></div>
          <b>{pct(machine.UTILIZATION, language)}</b><div className="track"><i style={{ width: barWidth(machine.UTILIZATION) }} /></div>
        </div>)}</div> : <p className="empty-inline">{t.emptySection}</p>}
    </section>
    <section className="panel data-section">
      <h3>{t.quality}</h3>
      <div className="compact-metrics">
        <Metric label={t.yesterdayUtilization} value={pct(info.UTILIZATION_RATE_YESTERDAY, language)} />
        <Metric label={t.averageTbs} value={amount(info.AVERAGE_TBS, language)} />
        <Metric label={t.automation} value={amount(info.AUTOMATION_DEGREE, language)} />
        <Metric label={t.oiRate} value={amount(info.OI_RATE, language)} />
        <Metric label={t.directLabor} value={amount(info.DL_COUNT, language)} />
        <Metric label={t.equipmentCount} value={amount(info.EQUIPMENT_COUNT, language)} />
        <Metric label={t.calculateDay} value={amount(info.CALCULATE_DAY, language)} />
      </div>
      <h4>{t.attainment}</h4>
      <DataTable headers={[t.process, t.rate]} rows={info.STD_ARCHIVE_PERCENTAGE_DATA.map(row =>
        [row.PROCESS_NAME, pct(row.STD_ACH, language)])} empty={t.emptySection} />
    </section>
    <section className="panel data-section">
      <h3>{t.balance}</h3>
      <DataTable headers={[t.machine, t.cycleTime]} rows={info.LINE_BALANCE.map(row =>
        [row.MACHINE_NAME, amount(row.CYCLE_TIME, language)])} empty={t.emptySection} />
      <h4>{t.tbsMachines}</h4>
      <DataTable headers={[t.machine, t.tbs]} rows={info.AVERAGE_TBS_MACHINE.map(row =>
        [row.MACHINE_NAME && row.MACHINE_NAME !== "N/A" ? row.MACHINE_NAME : row.EQUIPMENT_CODE,
          amount(row.TBS, language)])} empty={t.emptySection} />
    </section>
    <section className="panel data-section">
      <h3>{t.processWip}</h3>
      <DataTable headers={["MO", t.process, t.firstPass, t.firstFail, t.firstRate, t.totalPass, t.totalFail, t.totalRate]}
        rows={info.STD_ARCHIVE_WIP.map(row => [row.MO_NUMBER, row.GROUP_NAME, amount(row.FIRST_PASS_QTY, language),
          amount(row.FIRST_FAIL_QTY, language), row.FIRST_PASS_RATE, amount(row.TOTAL_PASS_QTY, language),
          amount(row.TOTAL_FAIL_QTY, language), row.TOTAL_PASS_RATE])} empty={t.emptySection} />
    </section>
    <section className="panel data-section wide">
      <h3>{t.hourlyPlan}</h3>
      <DataTable headers={[t.process, t.timeSlot, t.planned, t.actual]} rows={archiveRows} empty={t.emptySection} />
      {archives.length > 0 && <p className="table-note">SAFE_RATE / ALERT_RATE: {processes.map(process => {
        const row = archives.find(item => item.PROCESS_NAME === process);
        return `${process} ${row?.SAFE_RATE ?? "—"}% / ${row?.ALERT_RATE ?? "—"}%`;
      }).join(" · ")}</p>}
    </section>
    {extras.length > 0 && <details className="panel data-section wide"><summary>{t.showMore}</summary>
      <div className="field-grid extra-fields">{extras.map(([key, value]) => <div className="field" key={key}>
        <span>{key}</span><strong>{typeof value === "object" ? JSON.stringify(value) : fieldValue(key, value, language, timeZone)}</strong>
      </div>)}</div></details>}
  </div>;
}

type OrderState = { key: string; mo: string; orders: WorkOrder[]; fetchedAt?: string; error?: string; stale?: boolean };

export default function Dashboard({ initialSettings }: { initialSettings: SettingsPayload }) {
  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState(initialSettings);
  const [factoriesDraft, setFactoriesDraft] = useState(() => factoryDrafts(initialSettings));
  const [language, setLanguage] = useState<Language>("en");
  const [theme, setTheme] = useState<Theme>("light");
  const [view, setView] = useState<View>("overview");
  const [selectedKey, setSelectedKey] = useState("");
  const [selectedOrderKey, setSelectedOrderKey] = useState("");
  const [selectedFactory, setSelectedFactory] = useState(() => firstEnabledFactory(initialSettings));
  const [autoRefreshPaused, setAutoRefreshPaused] = useState(false);
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [detail, setDetail] = useState<OrderState | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [detailProgress, setDetailProgress] = useState<ApiProgress | null>(null);
  const [error, setError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [apiProgress, setApiProgress] = useState<ApiProgress | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const requestId = useRef(0);
  const activeRefresh = useRef<AbortController | null>(null);
  // A stable ref lets the in-flight request and the save handler use the latest saved polling mode.
  const refreshSettingsRef = useRef(settings.autoRefresh);
  // A failure pauses only its factory; switching away and back does not silently restart polling.
  const pausedFactories = useRef(new Set<string>());
  const detailRequest = useRef<AbortController | null>(null);
  const t = translations[language];

  useEffect(() => {
    // Persist a failed factory across a browser reload so reloading cannot restart failed API polling.
    try {
      const savedPaused = JSON.parse(localStorage.getItem("mes-paused-factories") || "[]");
      if (Array.isArray(savedPaused)) pausedFactories.current = new Set(savedPaused.filter(value => typeof value === "string"));
    } catch { /* In-memory pause still works when browser storage is unavailable. */ }
    const savedLanguage = localStorage.getItem("mes-language");
    const savedTheme = localStorage.getItem("mes-theme");
    if (savedLanguage === "en" || savedLanguage === "zh" || savedLanguage === "th") setLanguage(savedLanguage);
    if (savedTheme === "light" || savedTheme === "dark") setTheme(savedTheme);
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = language === "zh" ? "zh-Hant" : language;
    localStorage.setItem("mes-theme", theme);
    localStorage.setItem("mes-language", language);
  }, [theme, language]);

  const updateAutoRefreshPause = useCallback((factory: string, paused: boolean) => {
    if (paused) pausedFactories.current.add(factory);
    else pausedFactories.current.delete(factory);
    setAutoRefreshPaused(paused);
    try { localStorage.setItem("mes-paused-factories", JSON.stringify([...pausedFactories.current])); }
    catch { /* Keep the in-memory state even if storage is blocked. */ }
  }, []);

  // The route reports per-line failures in a successful HTTP response, so inspect both the payload and thrown errors.
  const refresh = useCallback(async (factory: string, manualRefresh = false) => {
    if (!factory) return;
    activeRefresh.current?.abort();
    const controller = new AbortController();
    activeRefresh.current = controller;
    const signal = controller.signal;
    const id = ++requestId.current;
    setPending(true);
    setApiProgress(null);
    try {
      const result = await getDashboard(factory, signal, event => {
        if (id === requestId.current && !signal.aborted) setApiProgress(event);
      });
      if (id === requestId.current && !signal?.aborted) {
        const paused = nextAutoRefreshPaused(pausedFactories.current.has(factory), manualRefresh, result,
          refreshSettingsRef.current.retryOnError);
        updateAutoRefreshPause(factory, paused);
        // Keep the last good readings briefly during an outage while exposing the error in either polling mode.
        setData(previous => {
          if (!previous) return result;
          const prior = new Map(previous.lines.map(line => [lineKey(line), line]));
          return { ...result, lines: result.lines.map(line => {
            const old = prior.get(lineKey(line));
            if (line.lineError && old?.information && old.lineFetchedAt &&
              Date.now() - Date.parse(old.lineFetchedAt) <= 5 * 60 * 1000) {
              const keepOrder = !!old.orders.length && !!old.detailFetchedAt &&
                Date.now() - Date.parse(old.detailFetchedAt) <= 5 * 60 * 1000;
              return { ...line, information: old.information, lineFetchedAt: old.lineFetchedAt, lineStale: true,
                orders: keepOrder ? old.orders : [], detailFetchedAt: keepOrder ? old.detailFetchedAt : undefined,
                detailStale: keepOrder };
            }
            if (line.detailError && old?.orders.length && old.detailFetchedAt &&
              old.information?.CURRENT_MO?.trim() === line.information?.CURRENT_MO?.trim() &&
              Date.now() - Date.parse(old.detailFetchedAt) <= 5 * 60 * 1000) {
              return { ...line, orders: old.orders, detailFetchedAt: old.detailFetchedAt, detailStale: true };
            }
            return line;
          }) };
        });
        setError("");
      }
    } catch (caught) {
      if (id === requestId.current && !signal?.aborted) {
        updateAutoRefreshPause(factory, true);
        setError(caught instanceof Error ? caught.message : "Unknown error");
      }
    } finally {
      if (id === requestId.current && !signal.aborted) {
        setPending(false);
        setApiProgress(null);
        activeRefresh.current = null;
      }
    }
  }, [updateAutoRefreshPause]);
  useEffect(() => {
    setData(null);
    setError("");
    const paused = pausedFactories.current.has(selectedFactory);
    setAutoRefreshPaused(paused);
    if (selectedFactory && (!paused || shouldAutoRefresh(refreshSettingsRef.current, paused))) void refresh(selectedFactory);
    else { activeRefresh.current?.abort(); requestId.current++; setPending(false); }
    return () => { activeRefresh.current?.abort(); requestId.current++; };
  }, [refresh, selectedFactory]);
  useEffect(() => {
    if (!selectedFactory || !shouldAutoRefresh(settings.autoRefresh, autoRefreshPaused)) return;
    const timer = window.setInterval(() => {
      // Continuous mode can poll a failed factory; the in-flight guard still prevents overlapping API calls.
      if (!activeRefresh.current && shouldAutoRefresh(refreshSettingsRef.current,
        pausedFactories.current.has(selectedFactory))) void refresh(selectedFactory);
    }, settings.autoRefresh.intervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [refresh, selectedFactory, settings.autoRefresh, autoRefreshPaused]);

  useEffect(() => () => {
    detailRequest.current?.abort();
    detailRequest.current = null;
  }, [view, selectedKey]);

  async function retryDetails() {
    const line = data?.lines.find(item => lineKey(item) === selectedKey);
    const currentMo = line?.information?.CURRENT_MO?.trim();
    if (!line || !currentMo) return;
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setDetailPending(true);
    setDetailProgress(null);
    try {
      const result = await getWorkOrders(line.factory, line.line, controller.signal, event => {
        if (!controller.signal.aborted) setDetailProgress(event);
      });
      if (controller.signal.aborted) return;
      if (result.currentMo !== currentMo) throw new Error("Current work order changed. Refresh the line.");
      if (!result.orders.length) throw new Error("The work order API returned no orders.");
      setDetail({ key: selectedKey, mo: currentMo, orders: result.orders, fetchedAt: result.fetchedAt });
    } catch (caught) {
      if (controller.signal.aborted) return;
      // Detail retries use API 2 outside the overview; record the failure for pause-on-error mode.
      updateAutoRefreshPause(line.factory, true);
      const message = caught instanceof Error ? caught.message : "Work order details unavailable.";
      setDetail(previous => {
        const keep = previous?.key === selectedKey && previous.mo === currentMo && previous.orders.length &&
          previous.fetchedAt && Date.now() - Date.parse(previous.fetchedAt) <= 5 * 60 * 1000;
        return { key: selectedKey, mo: currentMo, orders: keep ? previous.orders : [],
          fetchedAt: keep ? previous.fetchedAt : undefined, error: message, stale: !!keep };
      });
    } finally {
      if (!controller.signal.aborted) {
        setDetailPending(false);
        setDetailProgress(null);
        detailRequest.current = null;
      }
    }
  }

  const lines = useMemo(() => data?.lines || [], [data]);
  const selectedBase = lines.find(line => lineKey(line) === selectedKey);
  const matchingDetail = detail?.key === selectedKey && detail.mo === selectedBase?.information?.CURRENT_MO?.trim() ? detail : null;
  const overviewNewer = selectedBase?.detailFetchedAt &&
    (!matchingDetail?.fetchedAt || Date.parse(selectedBase.detailFetchedAt) >= Date.parse(matchingDetail.fetchedAt));
  const currentDetail = overviewNewer && !selectedBase?.detailError ? null : matchingDetail;
  const hasDetailedOrders = !!currentDetail?.orders.length;
  const selected = selectedBase ? { ...selectedBase,
    orders: hasDetailedOrders ? currentDetail.orders : selectedBase.orders,
    detailError: currentDetail ? currentDetail.error : selectedBase.detailError,
    detailFetchedAt: hasDetailedOrders ? currentDetail.fetchedAt : selectedBase.detailFetchedAt,
    detailStale: hasDetailedOrders ? currentDetail.stale : selectedBase.detailStale,
  } : undefined;
  const orderKeys = selected ? workOrderRowKeys(selected.orders) : [];
  // MO_NUMBER is not unique in MES, so card selection uses the same row identity as React's key.
  const selectedOrderIndex = orderKeys.indexOf(selectedOrderKey);
  const selectedOrder = selectedOrderIndex >= 0 ? selected?.orders[selectedOrderIndex] : selected ? mainOrder(selected) : undefined;
  const availableFactories = settings.factories.filter(factory => factory.enabled);
  const updated = data ? formatTimestamp(data.fetchedAt, language, settings.timeZone) : "—";
  const clock = now ? formatClock(now, language, settings.timeZone) : "--:--";
  const zoneOffset = now ? formatTimeZoneOffset(now, settings.timeZone) : "";
  const blockedRefresh = autoRefreshPaused && settings.autoRefresh.enabled && !settings.autoRefresh.retryOnError;
  const retryingAfterError = autoRefreshPaused && settings.autoRefresh.enabled && settings.autoRefresh.retryOnError;
  const editFactory = (index: number, change: (factory: FactoryDraft) => FactoryDraft) =>
    setFactoriesDraft(previous => previous.map((factory, current) => current === index ? change(factory) : factory));
  const editLine = (factoryIndex: number, lineIndex: number,
    change: (line: FactoryDraft["lines"][number]) => FactoryDraft["lines"][number]) =>
    editFactory(factoryIndex, factory => ({ ...factory, lines: factory.lines.map((line, current) =>
      current === lineIndex ? change(line) : line) }));

  async function save() {
    setSaving(true);
    setSaveMessage("");
    try {
      const next: SettingsPayload = {
        ...draft,
        factories: factoriesDraft.map(factory => ({
          name: factory.name.trim(), mesFactory: factory.mesFactory.trim(), enabled: factory.enabled,
          lines: factory.lines.map(line => ({ name: line.name.trim(), enabled: line.enabled }))
            .filter(line => line.name),
        })),
      };
      const saved = await saveSettings(next);
      refreshSettingsRef.current = saved.autoRefresh;
      setSettings(saved);
      setDraft(saved);
      setFactoriesDraft(factoryDrafts(saved));
      setSaveMessage(t.saved);
      setView("overview");
      setSelectedKey("");
      setData(null);
      setError("");
      const nextFactory = saved.factories.some(factory => factory.name === selectedFactory && factory.enabled)
        ? selectedFactory : firstEnabledFactory(saved);
      setSelectedFactory(nextFactory);
      // Saving a setting is not a manual recovery. A paused factory in normal mode waits for Refresh.
      if (nextFactory === selectedFactory && nextFactory &&
        (!pausedFactories.current.has(nextFactory) || shouldAutoRefresh(saved.autoRefresh, true))) {
        await refresh(nextFactory);
      }
      if (!nextFactory) { activeRefresh.current?.abort(); setData(null); setError(""); setPending(false); }
    } catch (caught) { setSaveMessage(caught instanceof Error ? caught.message : "Could not save settings."); }
    finally { setSaving(false); }
  }
  const openSettings = () => {
    setDraft(settings);
    setFactoriesDraft(factoryDrafts(settings));
    setSaveMessage("");
    setView("settings");
  };

  return <main className="dashboard">
    <header className="site-header">
      <div className="header-left">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <h1>{t.brand}</h1></div>
      </div>
      <div className="header-right">
        {view !== "settings" && <label className="factory-picker">
          <select aria-label={t.factory} value={selectedFactory} disabled={!availableFactories.length}
            onChange={event => {
              setSelectedFactory(event.target.value);
              setSelectedKey("");
              setDetail(null);
              setData(null);
              setError("");
              setView("overview");
            }}>
            {!availableFactories.length && <option value="">{t.selectFactory}</option>}
            {availableFactories.map(factory => <option key={factory.name} value={factory.name}>{factory.name}</option>)}
          </select></label>}
        <label className="header-select"><select aria-label={t.language} value={language}
          onChange={event => setLanguage(event.target.value as Language)}>
          <option value="en">English</option><option value="zh">繁體中文</option><option value="th">ไทย</option>
        </select></label>
        <button className="theme-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label={theme === "light" ? t.day : t.night} aria-pressed={theme === "dark"}>
          {theme === "light" ? "☀ " + t.day : "☾ " + t.night}</button>
        <button className={`settings-button ${view === "settings" ? "selected" : ""}`} onClick={openSettings}
          aria-label={t.settings}><span aria-hidden="true">⚙</span><span>{t.settings}</span></button>
        <div className="header-time" title={settings.timeZone} aria-label={`${settings.timeZone} ${clock}`}>
          <span>{zoneOffset}</span><strong>{clock}</strong></div>
      </div>
    </header>
    {view === "settings" ? <div className="settings-view">
      <div className="page-title"><h2>{t.settingsTitle}</h2><p>{t.settingsHint}</p></div>
      <section className="panel settings-panel">
      <div className="settings-subhead first"><h2>{t.displaySettings}</h2></div>
      <div className="settings-grid">
        <label>{t.timeZone}<input list="timezone-options" value={draft.timeZone} placeholder="Asia/Bangkok"
          onChange={event => setDraft({ ...draft, timeZone: event.target.value })} /></label>
        <label>{t.refreshInterval}<input type="number" min="5" max="3600" value={draft.autoRefresh.intervalSeconds}
          onChange={event => setDraft({ ...draft, autoRefresh: { ...draft.autoRefresh, intervalSeconds: Number(event.target.value) } })} /></label>
        <label className="checkbox-label"><input type="checkbox" checked={draft.autoRefresh.enabled}
          onChange={event => setDraft({ ...draft, autoRefresh: { ...draft.autoRefresh,
            enabled: event.target.checked, retryOnError: event.target.checked && draft.autoRefresh.retryOnError } })} />
          <span>{t.autoRefresh}<small>{t.refreshHint}</small></span></label>
        <label className="checkbox-label"><input type="checkbox" checked={draft.autoRefresh.retryOnError}
          onChange={event => setDraft({ ...draft, autoRefresh: { ...draft.autoRefresh,
            enabled: event.target.checked || draft.autoRefresh.enabled, retryOnError: event.target.checked } })} />
          <span>{t.alwaysRefresh}<small>{t.alwaysRefreshHint}</small></span></label>
      </div>
      <datalist id="timezone-options"><option value="Asia/Bangkok" /><option value="Asia/Taipei" />
        <option value="Asia/Tokyo" /><option value="UTC" /><option value="Europe/London" /><option value="America/Los_Angeles" /></datalist>
      <div className="settings-subhead"><h2>{t.apiRequestSettings}</h2></div>
      <div className="settings-grid request-grid">
        <label>{t.timeoutMs}<input type="number" min="1000" max="120000" value={draft.apiRequest.timeoutMs}
          onChange={event => setDraft({ ...draft, apiRequest: { ...draft.apiRequest, timeoutMs: Number(event.target.value) } })} /></label>
        <label>{t.tokenExpirySafetySeconds}<input type="number" min="0" max="600" value={draft.apiRequest.tokenExpirySafetySeconds}
          onChange={event => setDraft({ ...draft, apiRequest: { ...draft.apiRequest, tokenExpirySafetySeconds: Number(event.target.value) } })} /></label>
        <label>{t.fallbackTokenExpiresSeconds}<input type="number" min="60" max="86400" value={draft.apiRequest.fallbackTokenExpiresSeconds}
          onChange={event => setDraft({ ...draft, apiRequest: { ...draft.apiRequest, fallbackTokenExpiresSeconds: Number(event.target.value) } })} /></label>
        <label>{t.concurrentRequests}<input type="number" min="1" max="20" value={draft.apiRequest.concurrentRequests}
          onChange={event => setDraft({ ...draft, apiRequest: { ...draft.apiRequest, concurrentRequests: Number(event.target.value) } })} /></label>
      </div><p className="help-text">{t.sourceHint}</p>
      <div className="settings-subhead"><h2>{t.factorySettings}</h2><button className="button subtle" onClick={() =>
        setFactoriesDraft([...factoriesDraft, { name: "", mesFactory: "", enabled: true, lines: [] }])}>+ {t.addFactory}</button></div>
      {factoriesDraft.map((factory, index) => <div className="factory-editor" key={index}>
        <div className="factory-editor-head"><strong>{t.factory} {index + 1}</strong>
          <div className="factory-editor-controls"><label className="enable-control"><input type="checkbox" checked={factory.enabled}
            onChange={event => editFactory(index, item => ({ ...item, enabled: event.target.checked }))} />{t.enabled}</label>
            <button onClick={() => setFactoriesDraft(previous => previous.filter((_, current) => current !== index))}>{t.removeFactory}</button></div></div>
        <div className="settings-grid">
          <label>{t.factoryName}<input value={factory.name} placeholder={t.factoryName}
            onChange={event => editFactory(index, item => ({ ...item, name: event.target.value }))} /></label>
          <label>{t.mesFactory}<input value={factory.mesFactory} placeholder={t.mesFactory}
            onChange={event => editFactory(index, item => ({ ...item, mesFactory: event.target.value }))} /></label>
        </div>
        <p className="help-text">{t.factoryApiHint}</p>
        <div className="line-editor-head"><strong>{t.lineNames}</strong><button className="button subtle" onClick={() =>
          editFactory(index, item => ({ ...item, lines: [...item.lines, { name: "", enabled: true }] }))}>+ {t.addLine}</button></div>
        {factory.lines.map((line, lineIndex) => <div className="line-editor" key={lineIndex}>
          <label className="enable-control"><input type="checkbox" checked={line.enabled}
            onChange={event => editLine(index, lineIndex, item => ({ ...item, enabled: event.target.checked }))} />{t.enabled}</label>
          <input aria-label={`${t.lineName} ${lineIndex + 1}`} value={line.name} placeholder={t.lineName}
            onChange={event => editLine(index, lineIndex, item => ({ ...item, name: event.target.value }))} />
          <button onClick={() => editFactory(index, item => ({ ...item,
            lines: item.lines.filter((_, current) => current !== lineIndex) }))}>{t.removeLine}</button>
        </div>)}
      </div>)}
      {saveMessage && <p className="form-message" role="status">{saveMessage}</p>}
      <div className="settings-actions"><button className="button subtle" onClick={() => setView("overview")}>{t.cancel}</button>
        <button className="button primary" disabled={saving} onClick={() => void save()}>{saving ? t.saving : t.save}</button></div>
      </section>
    </div> : view === "line" && selected ? <>
      <div className="back-row"><button onClick={() => setView("overview")}>← {t.back}</button></div>
      <section className="line-hero panel"><div><span className="eyebrow">{selected.factory} / {t.lineDetail}</span><h2>{selected.line}</h2>
        <p>{t.currentOrder}: <strong>{selected.information?.CURRENT_MO || "—"}</strong> · {t.model}: <strong>{selected.information?.CURRENT_MODEL || "—"}</strong>
          {mainOrder(selected)?.OUTPUT_GROUP && <> · {t.station}: <strong>{mainOrder(selected)?.OUTPUT_GROUP}</strong></>}</p></div>
        <span className={`status ${selected.lineError ? "bad" : selected.information?.CURRENT_MO ? "good" : "muted"}`}>
          <i />{selected.lineError ? t.unavailable : selected.information?.CURRENT_MO ? t.running : t.noOrder}</span></section>
      {(selected.lineError || selected.detailError) && <div className="alert" role="alert">
        {selected.lineError && <p><strong>{t.lineFailure}:</strong> {selected.lineError}
          {selected.lineStale && selected.lineFetchedAt && <> · {t.staleLine}: {formatTimestamp(selected.lineFetchedAt, language, settings.timeZone)}</>}
          <button className="inline-retry" onClick={() => void refresh(selectedFactory, true)}>{t.retry}</button></p>}
        {selected.detailError && <p><strong>{t.detailFailure}:</strong> {selected.detailError}
          {selected.detailStale && selected.detailFetchedAt && <> · {t.staleDetails}: {formatTimestamp(selected.detailFetchedAt, language, settings.timeZone)}</>}
          <button className="inline-retry" disabled={detailPending} onClick={() => void retryDetails()}>{t.retry}</button></p>}
      </div>}
      {selected.information && <>
        <div className="section-title"><div><span className="eyebrow">{t.lineMetrics}</span><h2>{t.quality}</h2></div></div>
        <div className="kpi-grid">
          <Metric label={t.dailyUtilization} value={pct(selected.information.UTILIZATION_RATE_TODAY, language)} />
          <Metric label={t.fpyr} value={pct(selected.information.FPYR, language)} />
          <Metric label={t.uph} value={amount(selected.information.UPH, language)} />
          <Metric label={t.progress} value={pct(progress(mainOrder(selected)), language)} />
        </div>
        <div className="section-title"><h2>{t.workOrders}</h2>
          <button className="button subtle" disabled={!selected.orders.length}
            onClick={() => exportCsv(selected, language, settings.timeZone)}>{t.export}</button></div>
        {detailPending && selected.orders.length > 0 &&
          <LoadingStatus message={t.loadingDetails} event={detailProgress} language={language} compact />}
        {selected.orders.length ? <div className="order-layout">
          {/* The selected record is the primary content; the compact family list is a navigation control. */}
          <section className="panel order-details"><div className="detail-head"><div><span className="eyebrow">{t.orderDetail}</span>
            <h3>{selectedOrder ? "MO " + selectedOrder.MO_NUMBER : t.selectOrder}</h3>
            {selectedOrder && <p>{selectedOrder.MODEL_NAME}</p>}</div>
            {selectedOrder && <span>{Object.keys(selectedOrder).length} {t.fields}</span>}</div>
            {selectedOrder && <WorkOrderFields order={selectedOrder} language={language} timeZone={settings.timeZone} />}</section>
          <aside className="panel order-picker" aria-label={t.relatedOrders}>
            <div className="order-picker-head"><h3>{t.relatedOrders}</h3><span>{selected.orders.length}</span></div>
            <div className="order-list">{selected.orders.map((order, index) => {
              const rowKey = orderKeys[index];
              const isMain = order.MO_NUMBER === selected.information?.CURRENT_MO || !order.PARENT_MO || order.PARENT_MO === order.MO_NUMBER;
              const orderProgress = progress(order);
              return <button key={rowKey} className={`order-card ${selectedOrder === order ? "selected" : ""}`}
                aria-pressed={selectedOrder === order}
                title={[order.MODEL_NAME, order.MODEL_DESC, order.OUTPUT_GROUP].filter(Boolean).join(" · ")}
                onClick={() => setSelectedOrderKey(rowKey)}>
                <div className="order-card-top"><span className="order-number">MO {order.MO_NUMBER}</span>
                  <span className="order-type">{isMain ? t.mainOrder : t.subOrder}</span></div>
                <div className="order-card-main"><strong>{order.MODEL_NAME || "—"}</strong>
                  <b>{pct(orderProgress, language)}</b></div>
                <div className="order-card-meta"><span>{order.OUTPUT_GROUP || "—"}</span>
                  <span>{amount(order.OUTPUT_QTY, language)} / {amount(order.TARGET_QTY, language)}</span></div>
                <div className="track" aria-hidden="true"><i style={{ width: barWidth(orderProgress) }} /></div>
              </button>;
            })}</div>
          </aside>
        </div> : detailPending ? <LoadingStatus message={t.loadingDetails} event={detailProgress} language={language} />
          : <div className="panel empty">{selected.detailError ? t.noDetail : t.noOrders}</div>}
        <div className="section-title"><div><span className="eyebrow">{t.lineMetrics}</span><h2>{t.equipment}</h2></div></div>
        <LineInformationSections info={selected.information} language={language} timeZone={settings.timeZone}
          reference={data?.fetchedAt || new Date().toISOString()} />
      </>}
    </> : <>
      {selectedFactory && <div className="overview-actions"><div className="overview-status">
        <span className="updated">{t.updated}: {updated}</span>
        {blockedRefresh && <span className="auto-refresh-paused" role="status">{t.autoRefreshPaused}</span>}
        {retryingAfterError && <span className="auto-refresh-retrying" role="status">{t.autoRefreshRetrying}</span>}
      </div>
        <button className="button subtle" disabled={pending}
          onClick={() => void refresh(selectedFactory, true)}>{pending ? t.refreshing : t.refresh}</button></div>}
      {pending && data && <LoadingStatus message={t.refreshing} event={apiProgress} language={language} compact />}
      {error && <div className="alert" role="alert"><strong>{t.error}:</strong> {error}
        <button onClick={() => void refresh(selectedFactory, true)}>{t.retry}</button></div>}
      {saveMessage && <p className="form-message" role="status">{saveMessage}</p>}
      {!selectedFactory ? <div className="panel empty">{t.noConfigured}</div> :
        !data && autoRefreshPaused && !shouldAutoRefresh(settings.autoRefresh, autoRefreshPaused) && !pending
          ? <div className="panel empty">{t.autoRefreshPaused}</div> :
        !data && (!error || pending) ? <LoadingStatus message={t.loading} event={apiProgress} language={language} /> :
        !data && error ? <div className="panel empty">{retryingAfterError ? t.autoRefreshRetrying : t.error}</div> :
        lines.length ? <div className="line-list">{lines.map(line => {
              const info = line.information;
              const order = mainOrder(line);
              const attainment = progress(order);
              const remaining = order && Number.isFinite(order.TARGET_QTY) && Number.isFinite(order.OUTPUT_QTY)
                ? Math.max(0, order.TARGET_QTY - order.OUTPUT_QTY) : null;
              const lastProcess = info?.STD_ARCHIVE_WIP.filter(row => row.MO_NUMBER === info.CURRENT_MO).at(-1);
              return <button className="line-row panel" key={lineKey(line)}
                onClick={() => { setSelectedKey(lineKey(line)); setSelectedOrderKey(""); setDetail(null);
                  setDetailPending(false); setDetailProgress(null); setView("line"); }}>
                <div className="line-compact-grid">
                  <div className="line-compact-name"><h2>{line.line}<span aria-hidden="true">ⓘ</span></h2>
                    <span className={`status ${line.lineError || line.detailError ? "bad" : info?.CURRENT_MO ? "good" : "muted"}`}><i />
                      {line.lineError || line.detailError ? t.unavailable : info?.CURRENT_MO ? t.running : t.noOrder}</span></div>
                  <div className="line-compact-order"><small>{t.currentOrder}</small>
                    <strong>{info?.CURRENT_MO || "—"}</strong><span>{info?.CURRENT_MODEL || "—"}</span></div>
                  <div className="line-compact-output"><small>{t.output} / {t.target}</small>
                    <strong>{amount(order?.OUTPUT_QTY, language)} <span>/ {amount(order?.TARGET_QTY, language)}</span></strong></div>
                  <div className="line-compact-progress"><div><small>{t.rate}</small><strong>{pct(attainment, language)}</strong></div>
                    <div className="track" aria-hidden="true"><i style={{ width: barWidth(attainment) }} /></div></div>
                  <div className="line-compact-quantities"><span>{t.input}<strong>{amount(order?.INPUT_QTY, language)}</strong></span>
                    <span>{t.wip}<strong>{amount(order?.WIP, language)}</strong></span>
                    <span>{t.remaining}<strong>{amount(remaining, language)}</strong></span></div>
                  <span className="line-compact-arrow" aria-hidden="true">→</span>
                </div>
                <div className="line-hover-details">
                  <span>{t.lastReportedProcess}<b>{lastProcess?.GROUP_NAME || "—"}</b></span>
                  <span>{t.dailyUtilization}<b>{pct(info?.UTILIZATION_RATE_TODAY, language)}</b></span>
                  <span>{t.fpyr}<b>{pct(info?.FPYR, language)}</b></span>
                  <span>{t.uph}<b>{amount(info?.UPH, language)}</b></span>
                </div>
                {line.lineError && <div className="line-warning" title={line.lineError}>{line.lineError}
                  {line.lineStale && line.lineFetchedAt && <> · {t.staleLine}: {formatTimestamp(line.lineFetchedAt, language, settings.timeZone)}</>}</div>}
                {line.detailError && <div className="line-warning" title={line.detailError}>{line.detailError}
                  {line.detailStale && line.detailFetchedAt && <> · {t.staleDetails}: {formatTimestamp(line.detailFetchedAt, language, settings.timeZone)}</>}</div>}
              </button>;
            })}</div> : <div className="panel empty">{t.noLines}</div>}
    </>}
    <footer><span>{data ? `${t.live} · ` : ""}{settings.timeZone}</span>
      {view !== "overview" && <span>{t.updated}: {updated}</span>}</footer>
  </main>;
}
