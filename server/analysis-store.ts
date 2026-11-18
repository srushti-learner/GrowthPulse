import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { analysisJobSchema, analysisLimits, type AnalysisJob } from "../shared/analysis.js";
import { briefingPreviewSchema, type Understanding, type UnderstandingUpdate } from "../shared/understanding.js";
import type { SavedScan } from "../shared/website.js";
import { readResearchReport } from "./research-store.js";

export class AnalysisError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type JobRow = {
  id: string; owner_id: string; business_id: string; requested_url: string; input_scan_id: string | null; scan_id: string | null;
  status: AnalysisJob["status"]; phase: AnalysisJob["phase"]; preview_json: string | null;
  understanding_id: string | null; error: string | null; revision: number;
  created_at: string; updated_at: string; lease_token: string | null; lease_until: number | null;
  research_enabled: number; research_version: number; resume_job_id: string | null;
};
export type ClaimedAnalysis = { id: string; ownerId: string; businessId: string; url: string; scanId: string | null; lease: string; research: boolean };

export function analysisStore(database: Database.Database) {
  function row(id: string) { return database.prepare<[string], JobRow>("SELECT * FROM analysis_jobs WHERE id = ?").get(id); }
  function view(record: JobRow): AnalysisJob {
    const saved = record.understanding_id ? database.prepare<[string], { result: string; reviewedAt: string | null }>(
      "SELECT result_json AS result, reviewed_at AS reviewedAt FROM business_understandings WHERE id = ?",
    ).get(record.understanding_id) : undefined;
    return analysisJobSchema.parse({
      id: record.id, businessId: record.business_id, requestedUrl: record.requested_url, scanId: record.scan_id, status: record.status,
      phase: record.phase, preview: record.preview_json ? JSON.parse(record.preview_json) : null,
      understanding: saved ? { ...JSON.parse(saved.result), reviewedAt: saved.reviewedAt } : null,
      error: record.error, revision: record.revision, createdAt: record.created_at, updatedAt: record.updated_at,
      research: readResearchReport(database, record.id, !!record.research_enabled, ["queued", "running"].includes(record.status)),
      researchEnabled: !!record.research_enabled,
      researchVersion: record.research_version,
    });
  }
  function leased(id: string, lease: string) {
    const record = row(id);
    return record?.status === "running" && record.lease_token === lease && record.lease_until! > Date.now() ? record : undefined;
  }
  function transition(id: string, status: AnalysisJob["status"], error: string | null) {
    database.prepare(`UPDATE analysis_jobs SET status = ?, error = ?, preview_json = NULL,
      lease_token = NULL, lease_until = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`)
      .run(status, error, new Date().toISOString(), id);
  }
  return {
    getAnalysisJob(ownerId: string, businessId: string, id: string) {
      const record = row(id);
      return record?.owner_id === ownerId && record.business_id === businessId ? view(record) : null;
    },
    latestAnalysisJob(ownerId: string, businessId: string) {
      const record = database.prepare<[string, string], JobRow>(
        "SELECT * FROM analysis_jobs WHERE owner_id = ? AND business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      ).get(ownerId, businessId);
      return record ? view(record) : null;
    },
    latestAnalysisWithSuggestions(ownerId: string, businessId: string, url: string) {
      const record = database.prepare<[string, string, string], JobRow>(`
        SELECT j.* FROM analysis_jobs j WHERE j.owner_id = ? AND j.business_id = ? AND j.requested_url = ?
          AND EXISTS (SELECT 1 FROM research_steps s, json_each(s.result_json, '$.findings') f
            WHERE s.job_id = j.id AND json_extract(s.result_json, '$.status') IN ('completed', 'limited')
              AND json_extract(f.value, '$.kind') = 'suggestion' AND json_array_length(f.value, '$.sources') > 0)
        ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1
      `).get(ownerId, businessId, url);
      return record ? view(record) : null;
    },
    matchingAnalysisJob(ownerId: string, businessId: string, key: string, url: string, scanId?: string, research = false, resumeJobId?: string) {
      const record = database.prepare<[string, string, string, string], JobRow>(
        `SELECT j.* FROM analysis_jobs j WHERE j.owner_id = ? AND j.business_id = ?
          AND (j.request_key = ? OR j.id = (SELECT job_id FROM analysis_request_aliases
            WHERE owner_id = j.owner_id AND business_id = j.business_id AND request_key = ?))`,
      ).get(ownerId, businessId, key, key);
      if (record) {
        if (record.requested_url !== url || record.input_scan_id !== (scanId ?? null)
          || !!record.research_enabled !== research || record.resume_job_id !== (resumeJobId ?? null)) {
          throw new AnalysisError(409, "This request key was already used for a different analysis.");
        }
        return view(record);
      }
      const active = database.prepare<[string, string], JobRow>(
        "SELECT * FROM analysis_jobs WHERE owner_id = ? AND business_id = ? AND status IN ('queued', 'running')",
      ).get(ownerId, businessId);
      if (!active) return null;
      if (active.requested_url === url && active.input_scan_id === (scanId ?? null)
        && !!active.research_enabled === research && active.resume_job_id === (resumeJobId ?? null)) {
        database.prepare("INSERT INTO analysis_request_aliases (owner_id, business_id, request_key, job_id) VALUES (?, ?, ?, ?)")
          .run(ownerId, businessId, key, active.id);
        return view(active);
      }
      throw new AnalysisError(409, "An analysis is already queued or running for this business. Reload to reconnect, or cancel it before starting a new one.");
    },
    enqueueAnalysis(ownerId: string, businessId: string, key: string, url: string, scanId?: string, research = false, resumeJobId?: string, evidenceScanId = scanId) {
      return database.transaction(() => {
        const existing = this.matchingAnalysisJob(ownerId, businessId, key, url, scanId, research, resumeJobId);
        if (existing) return existing;
        if (!database.prepare("SELECT id FROM businesses WHERE id = ? AND owner_id = ?").get(businessId, ownerId)) {
          throw new AnalysisError(404, "Business not found.");
        }
        if (evidenceScanId && !database.prepare(`SELECT id FROM website_scans WHERE id = ? AND business_id = ?
          AND requested_url = ? AND status <> 'failed' AND page_count > 0`).get(evidenceScanId, businessId, url)) {
          throw new AnalysisError(404, "Matching saved website evidence was not found for this business.");
        }
        if (resumeJobId) {
          const previous = row(resumeJobId);
          if (!previous || previous.owner_id !== ownerId || previous.business_id !== businessId || previous.requested_url !== url
            || !scanId || previous.scan_id !== scanId || !!previous.research_enabled !== research || ["queued", "running"].includes(previous.status)) {
            throw new AnalysisError(409, "Only stopped research with the same website, saved scan and research permission can be resumed.");
          }
        }
        const count = database.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM analysis_jobs WHERE status = 'queued'").get()!.count;
        if (count >= analysisLimits.queued) throw new AnalysisError(429, "The analysis queue is full. Please try again later.");
        const id = randomUUID(), now = new Date().toISOString();
        database.prepare(`INSERT INTO analysis_jobs
          (id, owner_id, business_id, requested_url, request_key, input_scan_id, scan_id, status, phase, created_at, updated_at, research_enabled, resume_job_id, research_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'connecting', ?, ?, ?, ?, 2)`)
          .run(id, ownerId, businessId, url, key, scanId ?? null, evidenceScanId ?? null, now, now, Number(research), resumeJobId ?? null);
        if (resumeJobId) {
          database.prepare(`INSERT INTO research_steps (job_id, step_key, result_json, artifact_json)
            SELECT ?, step_key, json_set(result_json, '$.reused', json('true')), artifact_json FROM research_steps
            WHERE job_id = ? AND (json_extract(result_json, '$.status') = 'completed'
              OR (json_extract(result_json, '$.status') = 'limited' AND artifact_json IS NOT NULL))`).run(id, resumeJobId);
        }
        return view(row(id)!);
      }).immediate();
    },
    claimAnalysis(): ClaimedAnalysis | null {
      return database.transaction(() => {
        const now = Date.now();
        const stale = database.prepare<[number], { id: string }>(
          "SELECT id FROM analysis_jobs WHERE status = 'running' AND lease_until <= ?",
        ).all(now);
        for (const { id } of stale) transition(id, "interrupted", "The analysis worker stopped before finishing. Any saved website evidence remains available. Retry explicitly; AI work is not repeated automatically.");
        const expired = database.prepare<[string], { id: string }>(
          "SELECT id FROM analysis_jobs WHERE status = 'queued' AND created_at <= ?",
        ).all(new Date(now - analysisLimits.queueLifetimeMs).toISOString());
        for (const { id } of expired) transition(id, "failed", "This analysis waited too long in the queue. Please start it again when ready.");
        if (database.prepare("SELECT id FROM analysis_jobs WHERE status = 'running'").get()) return null;
        const next = database.prepare<[], JobRow>("SELECT * FROM analysis_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1").get();
        if (!next) return null;
        const lease = randomUUID();
        database.prepare(`UPDATE analysis_jobs SET status = 'running', lease_token = ?, lease_until = ?,
          revision = revision + 1, updated_at = ? WHERE id = ?`).run(lease, now + analysisLimits.leaseMs, new Date(now).toISOString(), next.id);
        return { id: next.id, ownerId: next.owner_id, businessId: next.business_id, url: next.requested_url, scanId: next.scan_id, lease, research: !!next.research_enabled };
      }).immediate();
    },
    renewAnalysisLease(id: string, lease: string) {
      return database.prepare(`UPDATE analysis_jobs SET lease_until = ? WHERE id = ?
        AND status = 'running' AND lease_token = ? AND lease_until > ?`)
        .run(Date.now() + analysisLimits.leaseMs, id, lease, Date.now()).changes === 1;
    },
    updateAnalysis(id: string, lease: string, update: UnderstandingUpdate) {
      if (!leased(id, lease)) return false;
      const phase = update.type === "phase" ? update.phase : "analysing";
      const preview = update.type === "briefing" ? JSON.stringify(briefingPreviewSchema.parse(update.briefing)) : null;
      return database.prepare(`UPDATE analysis_jobs SET phase = ?, preview_json = COALESCE(?, preview_json),
        revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until > ?`)
        .run(phase, preview, new Date().toISOString(), id, lease, Date.now()).changes === 1;
    },
    checkpointAnalysisScan(id: string, lease: string, save: () => SavedScan | undefined) {
      return database.transaction(() => {
        if (!leased(id, lease)) throw new AnalysisError(409, "This analysis is no longer running.");
        const scan = save();
        if (!scan) throw new AnalysisError(404, "Business not found.");
        database.prepare("UPDATE analysis_jobs SET scan_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(scan.status !== "failed" && scan.pages.length ? scan.id : null, new Date().toISOString(), id);
        return scan;
      }).immediate();
    },
    completeAnalysis(id: string, lease: string, save: () => Understanding) {
      return database.transaction(() => {
        if (!leased(id, lease)) return false;
        const result = save();
        database.prepare("UPDATE analysis_jobs SET understanding_id = ? WHERE id = ?").run(result.id, id);
        transition(id, "completed", null);
        return true;
      }).immediate();
    },
    failAnalysis(id: string, lease: string, message: string, interrupted = false) {
      return database.transaction(() => {
        if (!leased(id, lease)) return false;
        transition(id, interrupted ? "interrupted" : "failed", message.slice(0, 2048));
        return true;
      }).immediate();
    },
    cancelAnalysis(ownerId: string, businessId: string, id: string) {
      return database.transaction(() => {
        const record = row(id);
        if (!record || record.owner_id !== ownerId || record.business_id !== businessId) throw new AnalysisError(404, "Analysis not found.");
        if (record.status === "queued" || record.status === "running") transition(id, "cancelled", "Analysis cancelled. Your profile is unchanged. Any saved website evidence remains available.");
        return view(row(id)!);
      }).immediate();
    },
  };
}
