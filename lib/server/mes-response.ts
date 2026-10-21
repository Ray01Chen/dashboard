import type { LineInformation, ManufacturingResponse } from "../api";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const textOrNumber = (value: unknown): string | number | null =>
  typeof value === "string" || typeof value === "number" ? value : null;

export function parseLineInformation(value: unknown): LineInformation {
  const body = record(value) && value.RESULT === "OK" && record(value.MESSAGE) ? value.MESSAGE : value;
  if (!record(body) || !("CURRENT_MO" in body) ||
    (body.CURRENT_MO !== null && typeof body.CURRENT_MO !== "string") ||
    (body.CURRENT_MODEL !== null && body.CURRENT_MODEL !== undefined && typeof body.CURRENT_MODEL !== "string")) {
    throw new Error("Line API response is missing CURRENT_MO or CURRENT_MODEL.");
  }
  const arrays = ["UTILIZATION_MACHINE", "AVERAGE_TBS_MACHINE", "LINE_BALANCE",
    "STD_ARCHIVE_PERCENTAGE_DATA", "STD_ARCHIVE_DATA", "STD_ARCHIVE_WIP"];
  if (arrays.some(key => body[key] != null && !Array.isArray(body[key]))) {
    throw new Error("Line API response has an invalid metrics array.");
  }
  return {
    ...body,
    CURRENT_MO: body.CURRENT_MO as string | null,
    CURRENT_MODEL: typeof body.CURRENT_MODEL === "string" ? body.CURRENT_MODEL : null,
    UTILIZATION_RATE_TODAY: numeric(body.UTILIZATION_RATE_TODAY),
    UTILIZATION_RATE_YESTERDAY: numeric(body.UTILIZATION_RATE_YESTERDAY),
    AVERAGE_TBS: numeric(body.AVERAGE_TBS),
    AUTOMATION_DEGREE: textOrNumber(body.AUTOMATION_DEGREE),
    DL_COUNT: numeric(body.DL_COUNT),
    EQUIPMENT_COUNT: numeric(body.EQUIPMENT_COUNT),
    CALCULATE_DAY: numeric(body.CALCULATE_DAY),
    FPYR: numeric(body.FPYR),
    UPH: textOrNumber(body.UPH),
    OI_RATE: textOrNumber(body.OI_RATE),
    UTILIZATION_MACHINE: (body.UTILIZATION_MACHINE || []) as LineInformation["UTILIZATION_MACHINE"],
    AVERAGE_TBS_MACHINE: (body.AVERAGE_TBS_MACHINE || []) as LineInformation["AVERAGE_TBS_MACHINE"],
    LINE_BALANCE: (body.LINE_BALANCE || []) as LineInformation["LINE_BALANCE"],
    STD_ARCHIVE_PERCENTAGE_DATA: (body.STD_ARCHIVE_PERCENTAGE_DATA || []) as LineInformation["STD_ARCHIVE_PERCENTAGE_DATA"],
    STD_ARCHIVE_DATA: (body.STD_ARCHIVE_DATA || []) as LineInformation["STD_ARCHIVE_DATA"],
    STD_ARCHIVE_WIP: (body.STD_ARCHIVE_WIP || []) as LineInformation["STD_ARCHIVE_WIP"],
  };
}

export function parseWorkOrderResponse(value: unknown): ManufacturingResponse {
  if (!record(value) || value.RESULT !== "OK" || !Array.isArray(value.MESSAGE) ||
    !value.MESSAGE.every((row: unknown) => record(row) && typeof row.MO_NUMBER === "string" &&
      typeof row.M_WONO === "string" && typeof row.OUTPUT_QTY === "number")) {
    throw new Error("Work order API response has an invalid RESULT or MESSAGE.");
  }
  return value as ManufacturingResponse;
}
