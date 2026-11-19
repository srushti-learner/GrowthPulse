import { understandingStreamEventSchema, understandingTimeoutMs, type Understanding, type UnderstandingUpdate } from "../shared/understanding";
import { apiResponse, ApiFailure } from "./api";
import { activeAnalysis, analysisJobEventSchema, type AnalysisJob } from "../shared/analysis";
import { researchLimits } from "../shared/research";

const eventSchema = understandingStreamEventSchema.or(analysisJobEventSchema);

async function readStream(response: Response, signal: AbortSignal, onUpdate: (update: UnderstandingUpdate) => void,
  onJob?: (job: AnalysisJob) => void) {
  if (!response.headers.get("Content-Type")?.startsWith("application/x-ndjson") || !response.body) {
    throw new ApiFailure(502, "The server did not start a live analysis stream. Please reload and retry.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let completed: Understanding | undefined;
  let job: AnalysisJob | undefined;
  function consume(line: string) {
    signal.throwIfAborted();
    if (!line.trim()) return;
    let data: unknown;
    try { data = JSON.parse(line); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ApiFailure(502, "The analysis stream returned an unreadable update. Please retry.");
    }
    const event = eventSchema.safeParse(data);
    if (!event.success) throw new ApiFailure(502, "The analysis stream returned an invalid update. Please retry.");
    if (event.data.type === "error") throw new ApiFailure(event.data.status, event.data.message);
    if (event.data.type === "complete") completed = event.data.understanding;
    else if (event.data.type === "job") {
      job = event.data.job;
      onJob?.(job);
      if (job.status === "completed") {
        if (!job.understanding) throw new ApiFailure(502, "The saved analysis result is missing. Please reload.");
        completed = job.understanding;
      } else if (!activeAnalysis(job)) throw new ApiFailure(409, job.error ?? "This background analysis stopped. Retry explicitly when ready.");
      else {
        onUpdate({ type: "phase", phase: job.phase });
        if (job.preview) onUpdate({ type: "briefing", briefing: job.preview });
      }
    } else onUpdate(event.data);
  }
  try {
    while (!completed) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while (!completed && (newline = buffer.indexOf("\n")) !== -1) {
        if (newline > researchLimits.frameBytes) throw new ApiFailure(502, "An analysis update exceeded the size limit.");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consume(line);
      }
      if (!completed && buffer.length > researchLimits.frameBytes) throw new ApiFailure(502, "An analysis update exceeded the size limit.");
      if (done) {
        if (!completed && buffer.trim()) consume(buffer);
        break;
      }
    }
  } finally { reader.releaseLock(); }
  signal.throwIfAborted();
  return { completed, job };
}

async function pause(signal: AbortSignal, milliseconds: number) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function followAnalysisJob(job: AnalysisJob, signal: AbortSignal, onUpdate: (update: UnderstandingUpdate) => void,
  onJob?: (job: AnalysisJob) => void): Promise<Understanding> {
  const active = new AbortController();
  const combined = AbortSignal.any([signal, active.signal]);
  let latest = job;
  let failures = 0;
  try {
    while (true) {
      combined.throwIfAborted();
      onJob?.(latest);
      if (latest.status === "completed" && latest.understanding) return latest.understanding;
      if (!activeAnalysis(latest)) throw new ApiFailure(409, latest.error ?? "This analysis stopped. Retry explicitly when ready.");
      try {
        const response = await apiResponse(`/api/businesses/${job.businessId}/analysis-jobs/${job.id}/events`, { signal: combined }, 25_000);
        const result = await readStream(response, combined, onUpdate, (value) => { latest = value; onJob?.(value); });
        if (!result.job && !result.completed) throw new ApiFailure(502, "The progress connection returned no job status. Reload to reconnect to saved work.");
        failures = 0;
        if (result.completed) return result.completed;
      } catch (error) {
        combined.throwIfAborted();
        const transient = error instanceof TypeError || (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name));
        if (!transient) throw error;
        if (++failures >= 3) throw new ApiFailure(503, "Connection to your background analysis was lost. It may still be running. Reload to reconnect; do not start a new briefing.");
      }
      await pause(combined, failures ? 1000 : 100);
    }
  } finally { active.abort(); }
}

export async function streamUnderstanding(path: string, signal: AbortSignal, onUpdate: (update: UnderstandingUpdate) => void,
  scanId?: string, onJob?: (job: AnalysisJob) => void, requestKey: string = crypto.randomUUID(),
  options?: { resumeJobId?: string }): Promise<Understanding> {
  const active = new AbortController();
  const combined = AbortSignal.any([signal, active.signal]);
  try {
    const response = await apiResponse(path, {
      method: "POST",
      headers: { Accept: "application/x-ndjson", Prefer: "respond-async", "Idempotency-Key": requestKey },
      body: JSON.stringify({ permission: true, research: true, researchVersion: researchLimits.version, reuseCustomerEvidence: true, ...(scanId ? { scanId } : {}),
        ...(options?.resumeJobId ? { resumeJobId: options.resumeJobId } : {}) }),
      signal: combined,
    }, understandingTimeoutMs + 5000);
    const result = await readStream(response, combined, onUpdate, onJob);
    if (result.completed) return result.completed;
    if (result.job) return await followAnalysisJob(result.job, combined, onUpdate, onJob);
    throw new ApiFailure(502, "The live analysis ended before it finished. Reload to check saved results before retrying.");
  } finally { active.abort(); }
}
