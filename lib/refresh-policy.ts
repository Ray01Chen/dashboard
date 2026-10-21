import type { DashboardPayload } from "./api";

type RefreshSettings = { enabled: boolean; retryOnError: boolean };

// A factory with an exhausted API request normally waits for a successful manual refresh.
// Continuous mode ignores that pause for scheduling, while the stored flag tracks the latest result.
export function shouldAutoRefresh(settings: RefreshSettings, paused: boolean): boolean {
  return settings.enabled && (settings.retryOnError || !paused);
}

// Once continuous mode gets a fully healthy response, clear the old failure so switching
// back to pause-on-error mode does not leave an already recovered factory stopped.
export function nextAutoRefreshPaused(
  wasPaused: boolean,
  manualRefresh: boolean,
  payload: DashboardPayload | null,
  retryOnError = false,
): boolean {
  if (!payload || payload.lines.some(line => line.lineError || line.detailError)) return true;
  return manualRefresh || retryOnError ? false : wasPaused;
}
