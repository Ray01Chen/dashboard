import type { Language } from "./i18n";

const locale = { en: "en-GB", zh: "zh-TW", th: "th-TH" } as const;
const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const factoryOffset = "+07:00";

export function formatTimestamp(value: string | Date, language: Language, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale[language], { timeZone, dateStyle: "medium", timeStyle: "medium" }).format(date);
}

export function formatClock(value: Date, language: Language, timeZone: string): string {
  return new Intl.DateTimeFormat(locale[language], { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
}

export function formatTimeZoneOffset(value: Date, timeZone: string): string {
  const offset = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(value).find(part => part.type === "timeZoneName")?.value;
  return offset ? offset.replace(/^GMT/, "UTC") : timeZone;
}

// MES timestamps without an offset are local to the factory (UTC+7).
export function parseMesDate(value: string): Date | null {
  const mes = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/.exec(value.trim());
  if (mes) {
    const month = months.indexOf(mes[2].toUpperCase());
    if (month < 0) return null;
    const date = new Date(Date.UTC(Number(mes[3]), month, Number(mes[1]),
      Number(mes[4] || 0) - 7, Number(mes[5] || 0), Number(mes[6] || 0)));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value.trim())
    ? value.trim().replace(" ", "T") + factoryOffset : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatMesField(value: unknown, language: Language, timeZone: string): string {
  if (typeof value !== "string" || !value.trim()) return "—";
  const trimmed = value.trim();
  const dateOnly = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(trimmed);
  if (dateOnly) {
    const month = months.indexOf(dateOnly[2].toUpperCase());
    if (month < 0) return trimmed;
    return new Intl.DateTimeFormat(locale[language], { timeZone: "UTC", dateStyle: "medium" })
      .format(new Date(Date.UTC(Number(dateOnly[3]), month, Number(dateOnly[1]))));
  }
  const date = parseMesDate(trimmed);
  return date ? formatTimestamp(date, language, timeZone) : trimmed;
}

export function formatMesSlot(slot: string, reference: string, language: Language, timeZone: string): string {
  const match = /^T(\d{2})(\d{2})_(\d{2})(\d{2})$/.exec(slot);
  if (!match) return slot;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(reference));
  const part = (type: string) => parts.find(item => item.type === type)?.value || "";
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  const start = new Date(`${day}T${match[1]}:${match[2]}:00${factoryOffset}`);
  const end = new Date(`${day}T${match[3]}:${match[4]}:00${factoryOffset}`);
  if (end <= start) end.setUTCDate(end.getUTCDate() + 1);
  const formatter = new Intl.DateTimeFormat(locale[language], { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
  const dateFormatter = new Intl.DateTimeFormat(locale[language], { timeZone, day: "2-digit", month: "short" });
  const startDay = dateFormatter.format(start);
  const endDay = dateFormatter.format(end);
  return startDay === endDay
    ? `${startDay} ${formatter.format(start)}–${formatter.format(end)}`
    : `${startDay} ${formatter.format(start)}–${endDay} ${formatter.format(end)}`;
}
