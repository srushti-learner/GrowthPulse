import type { SqlDatabase } from "./sql-database.js";
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
  research_enabled: number; research_version: number; resume_job_id: string | null; reuse_customer_evidence: number;
};
export type ClaimedAnalysis = { id: string; ownerId: string; businessId: string; url: string; scanId: string | null; lease: string; research: boolean; reuseCustomerEvidence: boolean };

export function analysisStore(database: SqlDatabase) {
  function row(id: string) { return database.prepare<[string], JobRow>("SELECT * FROM analysis_jobs WHERE id = ?").get(id); }
  async function view(record: JobRow): Promise<AnalysisJob> {
    const saved = record.understanding_id ? await database.prepare<[string], { result: string; reviewedAt: string | null }>(
      "SELECT result_json AS result, reviewed_at AS reviewedAt FROM business_understandings WHERE id = ?",
    ).get(record.understanding_id) : undefined;
    return analysisJobSchema.parse({
      id: record.id, businessId: record.business_id, requestedUrl: record.requested_url, scanId: record.scan_id, status: record.status,
      phase: record.phase, preview: record.preview_json ? JSON.parse(record.preview_json) : null,
      understanding: saved ? { ...JSON.parse(saved.result), reviewedAt: saved.reviewedAt } : null,
      error: record.error, revision: record.revision, createdAt: record.created_at, updatedAt: record.updated_at,
      research: await readResearchReport(database, record.id, !!record.research_enabled, ["queued", "running"].includes(record.status)),
      researchEnabled: !!record.research_enabled,
      researchVersion: record.research_version,
      reuseCustomerEvidence: !!record.reuse_customer_evidence,
    });
  }
  async function leased(id: string, lease: string) {
    const record = await row(id);
    return record?.status === "running" && record.lease_token === lease && record.lease_until! > Date.now() ? record : undefined;
  }
  async function transition(id: string, status: AnalysisJob["status"], error: string | null) {
    await database.prepare(`UPDATE analysis_jobs SET status = ?, error = ?, preview_json = NULL,
      lease_token = NULL, lease_until = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`)
      .run(status, error, new Date().toISOString(), id);
  }
  return {
    async getAnalysisJob(ownerId: string, businessId: string, id: string) {
      const record = await row(id);
      return record?.owner_id === ownerId && record.business_id === businessId ? view(record) : null;
    },
    async latestAnalysisJob(ownerId: string, businessId: string) {
      const record = await database.prepare<[string, string], JobRow>(
        "SELECT * FROM analysis_jobs WHERE owner_id = ? AND business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      ).get(ownerId, businessId);
      return record ? view(record) : null;
    },
    async latestAnalysisWithSuggestions(ownerId: string, businessId: string, url: string) {
      const suggestionQuery = database.dialect === "mysql"
        ? `EXISTS (SELECT 1 FROM research_steps s,
            JSON_TABLE(s.result_json, '$.findings[*]' COLUMNS (
              kind VARCHAR(32) PATH '$.kind', sources JSON PATH '$.sources'
            )) f
            WHERE s.job_id = j.id AND JSON_UNQUOTE(JSON_EXTRACT(s.result_json, '$.status')) IN ('completed', 'limited')
              AND f.kind = 'suggestion' AND JSON_LENGTH(f.sources) > 0)`
        : `EXISTS (SELECT 1 FROM research_steps s, json_each(s.result_json, '$.findings') f
            WHERE s.job_id = j.id AND json_extract(s.result_json, '$.status') IN ('completed', 'limited')
              AND json_extract(f.value, '$.kind') = 'suggestion' AND json_array_length(f.value, '$.sources') > 0)`;
      const record = await database.prepare<[string, string, string], JobRow>(`
        SELECT j.* FROM analysis_jobs j WHERE j.owner_id = ? AND j.business_id = ? AND j.requested_url = ?
          AND ${suggestionQuery}
        ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1
      `).get(ownerId, businessId, url);
      return record ? view(record) : null;
    },
    async matchingAnalysisJob(ownerId: string, businessId: string, key: string, url: string, scanId?: string, research = false, resumeJobId?: string, reuseCustomerEvidence = false) {
      return database.transaction(async () => {
        const record = await database.prepare<[string, string, string, string], JobRow>(
          `SELECT j.* FROM analysis_jobs j WHERE j.owner_id = ? AND j.business_id = ?
            AND (j.request_key = ? OR j.id = (SELECT job_id FROM analysis_request_aliases
              WHERE owner_id = j.owner_id AND business_id = j.business_id AND request_key = ?))`,
        ).get(ownerId, businessId, key, key);
        if (record) {
          if (record.requested_url !== url || record.input_scan_id !== (scanId ?? null)
            || !!record.research_enabled !== research || record.resume_job_id !== (resumeJobId ?? null)
            || !!record.reuse_customer_evidence !== reuseCustomerEvidence) {
            throw new AnalysisError(409, "This request key was already used for a different analysis.");
          }
          return view(record);
        }
        const active = await database.prepare<[string, string], JobRow>(
          "SELECT * FROM analysis_jobs WHERE owner_id = ? AND business_id = ? AND status IN ('queued', 'running')",
        ).get(ownerId, businessId);
        if (!active) return null;
        if (active.requested_url === url && active.input_scan_id === (scanId ?? null)
          && !!active.research_enabled === research && active.resume_job_id === (resumeJobId ?? null)
          && !!active.reuse_customer_evidence === reuseCustomerEvidence) {
          await database.prepare("INSERT INTO analysis_request_aliases (owner_id, business_id, request_key, job_id) VALUES (?, ?, ?, ?)")
            .run(ownerId, businessId, key, active.id);
          return view(active);
        }
        throw new AnalysisError(409, "An analysis is already queued or running for this business. Reload to reconnect, or cancel it before starting a new one.");
      }).immediate();
    },
    enqueueAnalysis(ownerId: string, businessId: string, key: string, url: string, scanId?: string, research = false, resumeJobId?: string, evidenceScanId = scanId, reuseCustomerEvidence = false) {
      return database.transaction(async () => {
        if (reuseCustomerEvidence && !research) throw new AnalysisError(400, "Saved customer evidence requires wider research permission.");
        const existing = await this.matchingAnalysisJob(ownerId, businessId, key, url, scanId, research, resumeJobId, reuseCustomerEvidence);
        if (existing) return existing;
        if (!await database.prepare("SELECT id FROM businesses WHERE id = ? AND owner_id = ?").get(businessId, ownerId)) {
          throw new AnalysisError(404, "Business not found.");
        }
        if (evidenceScanId && !await database.prepare(`SELECT id FROM website_scans WHERE id = ? AND business_id = ?
          AND requested_url = ? AND status <> 'failed' AND page_count > 0`).get(evidenceScanId, businessId, url)) {
          throw new AnalysisError(404, "Matching saved website evidence was not found for this business.");
        }
        if (resumeJobId) {
          const previous = await row(resumeJobId);
          if (!previous || previous.owner_id !== ownerId || previous.business_id !== businessId || previous.requested_url !== url
            || !scanId || previous.scan_id !== scanId || !!previous.research_enabled !== research || ["queued", "running"].includes(previous.status)) {
            throw new AnalysisError(409, "Only stopped research with the same website, saved scan and research permission can be resumed.");
          }
        }
        const count = (await database.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM analysis_jobs WHERE status = 'queued'").get())!.count;
        if (count >= analysisLimits.queued) throw new AnalysisError(429, "The analysis queue is full. Please try again later.");
        const id = randomUUID(), now = new Date().toISOString();
        await database.prepare(`INSERT INTO analysis_jobs
          (id, owner_id, business_id, requested_url, request_key, input_scan_id, scan_id, status, phase, created_at, updated_at, research_enabled, resume_job_id, research_version, reuse_customer_evidence)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'connecting', ?, ?, ?, ?, 2, ?)`)
          .run(id, ownerId, businessId, url, key, scanId ?? null, evidenceScanId ?? null, now, now, Number(research), resumeJobId ?? null, Number(reuseCustomerEvidence));
        if (resumeJobId) {
          const status = database.dialect === "mysql" ? "JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.status'))" : "json_extract(result_json, '$.status')";
          const reused = database.dialect === "mysql"
            ? "JSON_SET(result_json, '$.reused', CAST('true' AS JSON))"
            : "json_set(result_json, '$.reused', json('true'))";
          await database.prepare(`INSERT INTO research_steps (job_id, step_key, result_json, artifact_json)
            SELECT ?, step_key, ${reused}, artifact_json FROM research_steps
            WHERE job_id = ? AND (${status} = 'completed'
              OR (${status} = 'limited' AND artifact_json IS NOT NULL))`).run(id, resumeJobId);
        }
        return view((await row(id))!);
      }).immediate();
    },
    claimAnalysis(): Promise<ClaimedAnalysis | null> {
      return database.transaction(async () => {
        const now = Date.now();
        const stale = await database.prepare<[number], { id: string }>(
          "SELECT id FROM analysis_jobs WHERE status = 'running' AND lease_until <= ?",
        ).all(now);
        for (const { id } of stale) await transition(id, "interrupted", "The analysis worker stopped before finishing. Any saved website evidence remains available. Retry explicitly; AI work is not repeated automatically.");
        const expired = await database.prepare<[string], { id: string }>(
          "SELECT id FROM analysis_jobs WHERE status = 'queued' AND created_at <= ?",
        ).all(new Date(now - analysisLimits.queueLifetimeMs).toISOString());
        for (const { id } of expired) await transition(id, "failed", "This analysis waited too long in the queue. Please start it again when ready.");
        if (await database.prepare("SELECT id FROM analysis_jobs WHERE status = 'running'").get()) return null;
        const next = await database.prepare<[], JobRow>("SELECT * FROM analysis_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1").get();
        if (!next) return null;
        const lease = randomUUID();
        await database.prepare(`UPDATE analysis_jobs SET status = 'running', lease_token = ?, lease_until = ?,
          revision = revision + 1, updated_at = ? WHERE id = ?`).run(lease, now + analysisLimits.leaseMs, new Date(now).toISOString(), next.id);
        return { id: next.id, ownerId: next.owner_id, businessId: next.business_id, url: next.requested_url, scanId: next.scan_id, lease,
          research: !!next.research_enabled, reuseCustomerEvidence: !!next.reuse_customer_evidence };
      }).immediate();
    },
    async renewAnalysisLease(id: string, lease: string) {
      return (await database.prepare(`UPDATE analysis_jobs SET lease_until = ? WHERE id = ?
        AND status = 'running' AND lease_token = ? AND lease_until > ?`)
        .run(Date.now() + analysisLimits.leaseMs, id, lease, Date.now())).changes === 1;
    },
    async updateAnalysis(id: string, lease: string, update: UnderstandingUpdate) {
      if (!await leased(id, lease)) return false;
      const phase = update.type === "phase" ? update.phase : "analysing";
      const preview = update.type === "briefing" ? JSON.stringify(briefingPreviewSchema.parse(update.briefing)) : null;
      return (await database.prepare(`UPDATE analysis_jobs SET phase = ?, preview_json = COALESCE(?, preview_json),
        revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until > ?`)
        .run(phase, preview, new Date().toISOString(), id, lease, Date.now())).changes === 1;
    },
    checkpointAnalysisScan(id: string, lease: string, save: () => Promise<SavedScan | undefined>) {
      return database.transaction(async () => {
        if (!await leased(id, lease)) throw new AnalysisError(409, "This analysis is no longer running.");
        const scan = await save();
        if (!scan) throw new AnalysisError(404, "Business not found.");
        if (!await leased(id, lease)) throw new AnalysisError(409, "This analysis is no longer running.");
        await database.prepare("UPDATE analysis_jobs SET scan_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(scan.status !== "failed" && scan.pages.length ? scan.id : null, new Date().toISOString(), id);
        return scan;
      }).immediate();
    },
    completeAnalysis(id: string, lease: string, save: () => Promise<Understanding>) {
      return database.transaction(async () => {
        if (!await leased(id, lease)) return false;
        const result = await save();
        if (!await leased(id, lease)) throw new AnalysisError(409, "This analysis is no longer running.");
        await database.prepare("UPDATE analysis_jobs SET understanding_id = ? WHERE id = ?").run(result.id, id);
        await transition(id, "completed", null);
        return true;
      }).immediate();
    },
    failAnalysis(id: string, lease: string, message: string, interrupted = false) {
      return database.transaction(async () => {
        if (!await leased(id, lease)) return false;
        await transition(id, interrupted ? "interrupted" : "failed", message.slice(0, 2048));
        return true;
      }).immediate();
    },
    cancelAnalysis(ownerId: string, businessId: string, id: string) {
      return database.transaction(async () => {
        const record = await row(id);
        if (!record || record.owner_id !== ownerId || record.business_id !== businessId) throw new AnalysisError(404, "Analysis not found.");
        if (record.status === "queued" || record.status === "running") await transition(id, "cancelled", "Analysis cancelled. Your profile is unchanged. Any saved website evidence remains available.");
        return view((await row(id))!);
      }).immediate();
    },
  };
}
