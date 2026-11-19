import { savedScanSchema, scanLimits, scanResponseSchema, scanStreamEventSchema, type ScanProgress } from "../shared/website";
import { apiResponse, ApiFailure } from "./api";

export async function scanWebsite(path: string, input: { url: string; permission: boolean }, signal: AbortSignal,
  onProgress: (progress: ScanProgress) => void) {
  const active = new AbortController();
  const combined = AbortSignal.any([signal, active.signal, AbortSignal.timeout(scanLimits.milliseconds + 10_000)]);
  try {
    const response = await apiResponse(path, {
      method: "POST", headers: { Accept: "application/x-ndjson" }, body: JSON.stringify(input), signal: combined,
    }, scanLimits.milliseconds + 10_000);
    if (!response.headers.get("Content-Type")?.startsWith("application/x-ndjson")) {
      const body: unknown = await response.json();
      const saved = savedScanSchema.safeParse(body && typeof body === "object" && "scan" in body ? body.scan : undefined);
      if (saved.success) return saved.data;
      const preview = scanResponseSchema.safeParse(body);
      if (!preview.success) throw new ApiFailure(502, "The server returned an invalid scan result. Check saved scans before retrying.");
      return preview.data.scan;
    }
    if (!response.body) throw new ApiFailure(502, "The server did not start a scan stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let complete: Extract<ReturnType<typeof scanStreamEventSchema.parse>, { type: "complete" }> | undefined;
    function consume(line: string) {
      if (!line.trim()) return;
      combined.throwIfAborted();
      let raw: unknown;
      try { raw = JSON.parse(line); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new ApiFailure(502, "The website scan returned an unreadable update. Check saved scans before retrying.");
      }
      const event = scanStreamEventSchema.safeParse(raw);
      if (!event.success) throw new ApiFailure(502, "The website scan returned an invalid update. Check saved scans before retrying.");
      if (event.data.type === "error") throw new ApiFailure(event.data.status, event.data.message);
      if (event.data.type === "progress") onProgress(event.data.progress);
      else complete = event.data;
    }
    try {
      while (!complete) {
        combined.throwIfAborted();
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let newline: number;
        while (!complete && (newline = buffer.indexOf("\n")) !== -1) {
          if (newline > 4 * 1024 * 1024) throw new ApiFailure(502, "A website scan update exceeded the size limit.");
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          consume(line);
        }
        if (!complete && buffer.length > 4 * 1024 * 1024) throw new ApiFailure(502, "A website scan update exceeded the size limit.");
        if (done) { if (!complete && buffer.trim()) consume(buffer); break; }
      }
    } finally { reader.releaseLock(); }
    combined.throwIfAborted();
    if (!complete) throw new ApiFailure(502, "The scan connection ended before a result arrived. Check saved scans before retrying.");
    return complete.scan;
  } finally { active.abort(); }
}
