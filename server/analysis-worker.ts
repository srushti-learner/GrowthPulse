import type { Store } from "./database.js";
import { AgentError, type BusinessAgent } from "./business-agent.js";
import { createWebsiteScanner, type WebsiteScanner } from "./website-scanner.js";
import { understandingTimeoutMs, type UnderstandingUpdate } from "../shared/understanding.js";
import { AnalysisError } from "./analysis-store.js";
import { recordUnderstanding } from "./record-understanding.js";
import { publicUrl, ScanError } from "./public-http.js";
import { claimWorkSlot } from "./work-slots.js";

export function createAnalysisWorker({ store, agent, scanner = createWebsiteScanner() }: {
  store: Store; agent: BusinessAgent; scanner?: WebsiteScanner;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let stopping = false;
  async function execute() {
    const release = claimWorkSlot();
    if (!release) return;
    try { await executeClaim(); } finally { release(); }
  }
  async function executeClaim() {
    if (stopping) return;
    const job = store.claimAnalysis();
    if (!job) return;
    const active = new AbortController();
    controller = active;
    const signal = AbortSignal.any([active.signal, AbortSignal.timeout(agent.timeoutMs ?? understandingTimeoutMs)]);
    let pending: UnderstandingUpdate | undefined;
    let lastPreview = 0;
    const update = (value: UnderstandingUpdate) => {
      if (!store.updateAnalysis(job.id, job.lease, value)) active.abort();
    };
    function flush() {
      if (pending) { const value = pending; pending = undefined; update(value); lastPreview = Date.now(); }
    }
    const heartbeat = setInterval(() => {
      try { if (!store.renewAnalysisLease(job.id, job.lease)) active.abort(); }
      catch (error) { active.abort(error); }
    }, 1000);
    const snapshots = setInterval(() => {
      try { flush(); } catch (error) { active.abort(error); }
    }, 250);
    try {
      const business = store.getBusiness(job.ownerId, job.businessId);
      if (!business?.website || publicUrl(business.website).href !== job.url) throw new AnalysisError(409, "The business website changed. Start a new analysis with permission for the current website.");
      let savedScan = job.scanId ? store.getScan(job.ownerId, job.businessId, job.scanId) : undefined;
      if (job.scanId && (!savedScan || savedScan.requestedUrl !== job.url || !savedScan.pages.length || savedScan.status === "failed")) {
        throw new AnalysisError(409, "The saved website evidence is unavailable or does not match this website. Read the website again.");
      }
      const proposal = await agent.run(job.url, async () => {
        if (savedScan) return savedScan;
        const scan = await scanner(job.url, signal);
        signal.throwIfAborted();
        savedScan = store.checkpointAnalysisScan(job.id, job.lease, () => store.saveScan(job.ownerId, job.businessId, scan));
        return savedScan;
      }, signal, (value) => {
        signal.throwIfAborted();
        if (value.type === "phase") { flush(); update(value); }
        else { pending = value; if (Date.now() - lastPreview >= 250) flush(); }
      }, { research: job.research, journal: store.researchJournal(job.id, job.lease) });
      signal.throwIfAborted();
      if (!savedScan) throw new AgentError(502, "No website evidence was captured. Your profile is unchanged.");
      if (savedScan.status === "failed" || !savedScan.pages.length) throw new AgentError(400, "No permitted public pages could be read, so AI analysis could not run. Your previous briefing is unchanged. Check Website history, then read the website again or use manual information and CSV.");
      const scan = savedScan;
      store.completeAnalysis(job.id, job.lease, () => {
        const current = store.getBusiness(job.ownerId, job.businessId);
        if (!current?.website || publicUrl(current.website).href !== job.url) throw new AnalysisError(409, "The business website changed during analysis. Your profile is unchanged; start a new review.");
        return recordUnderstanding(store, job.ownerId, job.businessId, scan, proposal);
      });
    } catch (error) {
      const known = error instanceof AgentError || error instanceof AnalysisError || error instanceof ScanError;
      const message = signal.aborted ? "The background analysis was interrupted or timed out. Any captured website evidence remains available. Retry explicitly when ready."
        : known ? error.message : "The background analysis could not finish. Your profile is unchanged. Check saved website evidence before retrying.";
      console.error("Analysis job failed:", { jobId: job.id, phase: store.getAnalysisJob(job.ownerId, job.businessId, job.id)?.phase,
        kind: signal.aborted ? "interrupted" : known ? error.constructor.name : "unexpected" });
      store.failAnalysis(job.id, job.lease, message, signal.aborted);
    } finally {
      clearInterval(heartbeat); clearInterval(snapshots);
      controller = undefined;
    }
  }
  const worker = {
    tick(): Promise<void> {
      if (!running) running = execute().finally(() => { running = undefined; });
      return running;
    },
    start() {
      if (timer) return;
      stopping = false;
      const tick = () => { void worker.tick().catch((error: unknown) => console.error("Analysis worker unavailable:", error instanceof Error ? error.name : "unknown")); };
      timer = setInterval(tick, 500); timer.unref(); tick();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      controller?.abort();
      await running;
    },
  };
  return worker;
}
