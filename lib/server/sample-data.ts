/** Offline sample is a JSON data file, not compiled into a TypeScript module. */
import "server-only";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ManufacturingResponse, WorkOrder } from "../api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function readSampleResponse(relativeFile: string): Promise<ManufacturingResponse> {
  // The path in dashboard.json is project-relative, not arbitrary filesystem access.
  // realpath-based resolution also rejects symlinks escaping the project directory.
  const projectRoot = path.resolve(process.cwd());
  const requestedFile = path.resolve(projectRoot, relativeFile);
  const relative = path.relative(projectRoot, requestedFile);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".json")) {
    throw new Error("sampleDataFile 必須是專案內的 JSON 相對路徑。");
  }
  let raw: string;
  try {
    const realRoot = await realpath(projectRoot);
    const realFile = await realpath(requestedFile);
    const relativeResolved = path.relative(realRoot, realFile);
    if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
      throw new Error("sampleDataFile 不可指向專案外部的檔案。");
    }
    raw = await readFile(realFile, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.includes("不可指向專案外部")) throw error;
    throw new Error("找不到範例資料檔，請檢查 config/dashboard.json 的 sampleDataFile。");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("範例資料檔不是有效的 JSON。"); }
  if (!isRecord(parsed) || parsed.RESULT !== "OK" || !Array.isArray(parsed.MESSAGE) ||
      !parsed.MESSAGE.every((row: unknown) => isRecord(row) && typeof row.MO_NUMBER === "string" &&
        typeof row.M_WONO === "string" && typeof row.OUTPUT_QTY === "number")) {
    throw new Error("範例資料檔必須符合 MES 的 RESULT / MESSAGE 工單格式。");
  }
  return parsed as ManufacturingResponse;
}
