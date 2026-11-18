import type Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { researchLimits, researchReportSchema, researchStepSchema, type ResearchReport, type ResearchStep } from "../shared/research.js";

type Usage = keyof ResearchReport["usage"];
const columns: Record<Usage, string> = { searches: "searches", modelCalls: "model_calls", competitorScans: "competitor_scans" };
const ceilings: Record<Usage, number> = {
  searches: researchLimits.searches, modelCalls: researchLimits.modelCalls, competitorScans: researchLimits.competitors,
};
export class ResearchStopped extends Error {}
export class ResearchLimit extends Error {}
export type ResearchJournal = ReturnType<ReturnType<typeof researchStore>["researchJournal"]>;

export function researchStore(database: Database.Database) {
  const checkpointer = new SqliteSaver(database);
  return {
    researchCheckpointer: checkpointer,
    researchJournal(id: string, lease: string) {
      function current() {
        const row = database.prepare<[string, string, number], { research: number; version: number; status: string }>(
          `SELECT research_enabled AS research, research_version AS version, status FROM analysis_jobs
           WHERE id = ? AND lease_token = ? AND status = 'running' AND lease_until > ?`,
        ).get(id, lease, Date.now());
        if (!row) throw new ResearchStopped("This research job is no longer running.");
        return row;
      }
      return {
        id, checkpointer,
        get version() { return current().version; },
        report() {
          return readResearchReport(database, id, !!current().research, false);
        },
        read(key: string) {
          current();
          const row = database.prepare<[string, string], { result: string; artifact: string | null }>(
            "SELECT result_json AS result, artifact_json AS artifact FROM research_steps WHERE job_id = ? AND step_key = ?",
          ).get(id, key);
          return row ? { step: researchStepSchema.parse(JSON.parse(row.result)), artifact: row.artifact ? JSON.parse(row.artifact) as unknown : undefined } : null;
        },
        write(input: ResearchStep, artifact?: unknown) {
          const step = researchStepSchema.parse(input);
          let clipped = false;
          while (Buffer.byteLength(JSON.stringify(step)) > researchLimits.stepBytes && step.findings.length) {
            step.findings.pop(); clipped = true;
          }
          if (clipped) {
            step.limitations = [...step.limitations.slice(0, 7), "Some findings exceeded the live-report size budget and were omitted from this summary. The full validated step artifact remains saved."];
            step.status = "limited";
            step.diagnostic = { code: "report_size", paths: ["findings"] };
          }
          if (Buffer.byteLength(JSON.stringify(step)) > researchLimits.stepBytes) {
            throw new ResearchLimit("This research step exceeded the live-report size limit. Its summary was not accepted.");
          }
          const json = artifact === undefined ? null : JSON.stringify(artifact);
          if (json && Buffer.byteLength(json) > 2 * 1024 * 1024) throw new ResearchLimit("Research evidence exceeded its storage limit.");
          database.transaction(() => {
            current();
            const count = database.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM research_steps WHERE job_id = ?").get(id)!.count;
            if (count >= researchLimits.steps && !this.read(step.key)) throw new ResearchLimit("Research step limit reached.");
            database.prepare(`INSERT INTO research_steps (job_id, step_key, result_json, artifact_json) VALUES (?, ?, ?, ?)
              ON CONFLICT(job_id, step_key) DO UPDATE SET result_json = excluded.result_json, artifact_json = excluded.artifact_json`)
              .run(id, step.key, JSON.stringify(step), json);
            database.prepare("UPDATE analysis_jobs SET revision = revision + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
          }).immediate();
        },
        consume(kind: Usage) {
          database.transaction(() => {
            const job = current();
            database.prepare("INSERT OR IGNORE INTO research_usage (job_id) VALUES (?)").run(id);
            const column = columns[kind];
            const changed = database.prepare(`UPDATE research_usage SET ${column} = ${column} + 1 WHERE job_id = ? AND ${column} < ?`)
              .run(id, job.version === 1 ? { searches: 1, modelCalls: 7, competitorScans: 2 }[kind] : ceilings[kind]).changes;
            if (!changed) throw new ResearchLimit(`The per-run ${kind} limit was reached.`);
          }).immediate();
        },
      };
    },
  };
}

export function readResearchReport(database: Database.Database, id: string, enabled: boolean, active: boolean) {
  const steps = database.prepare<[string], { json: string; captureUrl: string | null; capturePages: number | null }>(
    `SELECT s.result_json AS json,
      CASE WHEN s.step_key GLOB 'competitor-site-[0-9]' THEN
        COALESCE(json_extract(s.artifact_json, '$.requestedUrl'),
          json_extract(d.artifact_json, '$[' || substr(s.step_key, 17) || '].url')) END AS captureUrl,
      CASE WHEN s.step_key GLOB 'competitor-site-[0-9]' THEN
        json_array_length(s.artifact_json, '$.pages') END AS capturePages
     FROM research_steps s LEFT JOIN research_steps d ON d.job_id = s.job_id AND d.step_key = 'discovery'
     WHERE s.job_id = ? ORDER BY s.rowid`,
  ).all(id).map(({ json, captureUrl, capturePages }) => researchStepSchema.parse({
    ...JSON.parse(json),
    ...(captureUrl ? { capture: { url: captureUrl, pages: capturePages ?? 0 } } : {}),
  }));
  if (!steps.length) return undefined;
  const row = database.prepare<[string], { searches: number; modelCalls: number; competitorScans: number }>(
    "SELECT searches, model_calls AS modelCalls, competitor_scans AS competitorScans FROM research_usage WHERE job_id = ?",
  ).get(id);
  return researchReportSchema.parse({
    version: 1, enabled, status: active ? "running" : steps.some((step) => step.status !== "completed") ? "partial" : "complete",
    steps: steps.map((step) => !active && step.status === "running" ? {
      ...step, status: "failed", completedAt: new Date().toISOString(),
      limitations: ["This step was interrupted. Accepted findings from other steps remain saved."],
      diagnostic: { code: "interrupted", paths: [] },
    } : step),
    usage: row ?? { searches: 0, modelCalls: 0, competitorScans: 0 },
  });
}
