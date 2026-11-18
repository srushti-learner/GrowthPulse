import type { SqlDatabase } from "./sql-database.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { researchLimits, researchReportSchema, researchStepSchema, type ResearchReport, type ResearchStep } from "../shared/research.js";

type Usage = keyof ResearchReport["usage"];
const columns: Record<Usage, string> = { searches: "searches", modelCalls: "model_calls", competitorScans: "competitor_scans" };
const ceilings: Record<Usage, number> = {
  searches: researchLimits.searches, modelCalls: researchLimits.modelCalls, competitorScans: researchLimits.competitors,
};
export class ResearchStopped extends Error {}
export class ResearchLimit extends Error {}
export type ResearchJournal = ReturnType<ReturnType<typeof researchStore>["researchJournal"]>;

export function researchStore(database: SqlDatabase, checkpointer: BaseCheckpointSaver) {
  return {
    researchCheckpointer: checkpointer,
    researchJournal(id: string, lease: string) {
      async function current() {
        const row = await database.prepare<[string, string, number], { research: number; version: number; status: string }>(
          `SELECT research_enabled AS research, research_version AS version, status FROM analysis_jobs
           WHERE id = ? AND lease_token = ? AND status = 'running' AND lease_until > ?`,
        ).get(id, lease, Date.now());
        if (!row) throw new ResearchStopped("This research job is no longer running.");
        return row;
      }
      return {
        id, checkpointer,
        async version() { return (await current()).version; },
        async report() {
          return readResearchReport(database, id, !!(await current()).research, false);
        },
        async read(key: string) {
          await current();
          const row = await database.prepare<[string, string], { result: string; artifact: string | null }>(
            "SELECT result_json AS result, artifact_json AS artifact FROM research_steps WHERE job_id = ? AND step_key = ?",
          ).get(id, key);
          return row ? { step: researchStepSchema.parse(JSON.parse(row.result)), artifact: row.artifact ? JSON.parse(row.artifact) as unknown : undefined } : null;
        },
        async write(input: ResearchStep, artifact?: unknown) {
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
          await database.transaction(async () => {
            await current();
            const count = (await database.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM research_steps WHERE job_id = ?").get(id))!.count;
            if (count >= researchLimits.steps && !await this.read(step.key)) throw new ResearchLimit("Research step limit reached.");
            await database.prepare(`INSERT INTO research_steps (job_id, step_key, result_json, artifact_json) VALUES (?, ?, ?, ?)
              ${database.dialect === "mysql"
                ? "ON DUPLICATE KEY UPDATE result_json = VALUES(result_json), artifact_json = VALUES(artifact_json)"
                : "ON CONFLICT(job_id, step_key) DO UPDATE SET result_json = excluded.result_json, artifact_json = excluded.artifact_json"}`)
              .run(id, step.key, JSON.stringify(step), json);
            await database.prepare("UPDATE analysis_jobs SET revision = revision + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
            await current();
          }).immediate();
        },
        async consume(kind: Usage) {
          await database.transaction(async () => {
            const job = await current();
            await database.prepare(database.dialect === "mysql"
              ? "INSERT INTO research_usage (job_id) VALUES (?) ON DUPLICATE KEY UPDATE job_id = VALUES(job_id)"
              : "INSERT OR IGNORE INTO research_usage (job_id) VALUES (?)").run(id);
            const column = columns[kind];
            const changed = (await database.prepare(`UPDATE research_usage SET ${column} = ${column} + 1 WHERE job_id = ? AND ${column} < ?`)
              .run(id, job.version === 1 ? { searches: 1, modelCalls: 7, competitorScans: 2 }[kind] : ceilings[kind])).changes;
            if (!changed) throw new ResearchLimit(`The per-run ${kind} limit was reached.`);
            await current();
          }).immediate();
        },
      };
    },
  };
}

export async function readResearchReport(database: SqlDatabase, id: string, enabled: boolean, active: boolean) {
  const steps = (await database.prepare<[string], { json: string; artifact: string | null; discovery: string | null; key: string }>(
    `SELECT s.result_json AS json, s.artifact_json AS artifact, d.artifact_json AS discovery, s.step_key AS \`key\`
     FROM research_steps s LEFT JOIN research_steps d ON d.job_id = s.job_id AND d.step_key = 'discovery'
     WHERE s.job_id = ? ORDER BY s.rowid`,
  ).all(id)).map(({ json, artifact, discovery, key }) => {
    const scan = artifact ? JSON.parse(artifact) : undefined;
    const index = /^competitor-site-([0-9])$/.exec(key)?.[1];
    const captureUrl = index === undefined ? undefined
      : scan?.requestedUrl ?? (discovery ? JSON.parse(discovery)[Number(index)]?.url : undefined);
    return researchStepSchema.parse({
      ...JSON.parse(json),
      ...(captureUrl ? { capture: { url: captureUrl, pages: Array.isArray(scan?.pages) ? scan.pages.length : 0 } } : {}),
    });
  });
  if (!steps.length) return undefined;
  const row = await database.prepare<[string], { searches: number; modelCalls: number; competitorScans: number }>(
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
