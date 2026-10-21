import type { ApiProgress } from "../api";

// NDJSON lets the browser show the retries actually being made by the server.
export function progressStream<T>(run: (report: (event: ApiProgress) => void) => Promise<T>): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: object) => {
        if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      void run(event => send({ type: "progress", ...event }))
        .then(data => send({ type: "result", data }), error =>
          send({ type: "error", error: error instanceof Error ? error.message : "MES data unavailable." }))
        .finally(() => { if (!cancelled) controller.close(); });
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store",
      "X-Accel-Buffering": "no" },
  });
}
