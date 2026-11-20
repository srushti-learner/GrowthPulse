import type { SqlDatabase } from "./sql-database.js";
import { createHash } from "node:crypto";
import { growthPlanItemSchema, type GrowthOpportunity, type GrowthPlanInput, type GrowthPlanItem } from "../shared/growth.js";
import { researchAgentLabels, type ResearchReport, type ResearchAgent } from "../shared/research.js";
import { growthWorkSchema, type GrowthWork } from "../shared/growth-work.js";

export class GrowthError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const metrics: Record<ResearchAgent, string> = {
  store: "Product-page purchase conversion rate",
  competitor: "Purchase conversion rate for the changed offer",
  customer: "Customer task completion and purchase conversion rate",
  pricing: "Gross margin per order and purchase conversion rate",
  opportunity: "Demand for the proposed product, alongside contribution margin",
  growth: "Purchase conversion rate and contribution margin",
};

export function growthOpportunities(businessId: string, report?: ResearchReport): GrowthOpportunity[] {
  const grouped = new Map<string, GrowthOpportunity>();
  for (const step of report?.steps ?? []) {
    if (step.status !== "completed" && step.status !== "limited") continue;
    for (const finding of step.findings) {
      if (finding.kind !== "suggestion" || !finding.sources.length) continue;
      const key = `${finding.title.trim().toLowerCase().replace(/\s+/g, " ")}:${finding.detail.trim().toLowerCase().replace(/\s+/g, " ")}`;
      const previous = grouped.get(key);
      if (previous) {
        previous.agents = [...new Set([...previous.agents, step.agent])];
        previous.sources = [...new Map([...previous.sources, ...finding.sources].map((source) => [source.id, source])).values()].slice(0, 18);
        continue;
      }
      grouped.set(key, {
        id: createHash("sha256").update(`${businessId}:${key}`).digest("hex"),
        title: finding.title, detail: finding.detail, agents: [step.agent], sources: finding.sources,
        reviewReason: "",
        strategy: {
          objective: finding.title,
          actions: [
            `For "${finding.title}", confirm the proposed problem with the cited sources and current customer or sales evidence.`,
            finding.detail,
            "Choose the exact target and change in My actions. Create a small draft, review costs, and obtain owner approval before publishing.",
            "Choose one primary metric and an owner-defined success threshold. Keep other variables stable and record a comparable baseline before testing.",
          ],
          metric: metrics[step.agent],
          hypothesis: `Test whether this recommendation improves the chosen metric: ${finding.title}`,
          measurement: `Choose one primary measure relevant to "${finding.title}". Use ${metrics[step.agent].toLowerCase()} only where the required data exists. Record the start date, eligible audience, baseline and test duration; account for seasonality and sample size. No uplift is predicted.`,
        },
      });
    }
  }
  return [...grouped.values()].sort((a, b) => Number(b.agents.includes("growth")) - Number(a.agents.includes("growth"))
    || b.agents.length - a.agents.length || new Set(b.sources.map((s) => s.url)).size - new Set(a.sources.map((s) => s.url)).size
    || a.id.localeCompare(b.id)).map((item) => ({
    ...item,
    reviewReason: `${item.agents.includes("growth") ? "Saved Growth strategy recommendation. " : ""}Supported by ${item.agents.map((agent) => researchAgentLabels[agent]).join(", ")}; ${new Set(item.sources.map((source) => source.url)).size} captured page(s). Review order reflects synthesis and source coverage, not predicted business impact.`,
  }));
}

type PlanRow = {
  opportunity_json: string; status: GrowthPlanItem["status"]; impact: GrowthPlanItem["impact"];
  effort: GrowthPlanItem["effort"]; time_to_value: GrowthPlanItem["timeToValue"]; revision: number; created_at: string; updated_at: string;
};
export function growthStore(database: SqlDatabase) {
  async function authorize(ownerId: string, businessId: string) {
    if (!await database.prepare("SELECT id FROM businesses WHERE id = ? AND owner_id = ?").get(businessId, ownerId)) {
      throw new GrowthError(404, "Business not found.");
    }
  }
  function view(row: PlanRow) {
    return growthPlanItemSchema.parse({
      opportunity: JSON.parse(row.opportunity_json), status: row.status, impact: row.impact, effort: row.effort,
      timeToValue: row.time_to_value, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    });
  }
  return {
    async listGrowthPlan(ownerId: string, businessId: string) {
      await authorize(ownerId, businessId);
      return (await database.prepare<[string], PlanRow>("SELECT * FROM growth_plan WHERE business_id = ? ORDER BY created_at, opportunity_id")
        .all(businessId)).map(view);
    },
    async addGrowthPlan(ownerId: string, businessId: string, opportunity: GrowthOpportunity) {
      return database.transaction(async () => {
        await authorize(ownerId, businessId);
        const now = new Date().toISOString();
        await database.prepare(`INSERT INTO growth_plan (business_id, opportunity_id, opportunity_json, status, impact, effort, time_to_value, created_at, updated_at)
          VALUES (?, ?, ?, 'planned', 'unknown', 'unknown', 'unknown', ?, ?) ${database.dialect === "mysql"
            ? "ON DUPLICATE KEY UPDATE opportunity_id=VALUES(opportunity_id)"
            : "ON CONFLICT (business_id, opportunity_id) DO NOTHING"}`)
          .run(businessId, opportunity.id, JSON.stringify(opportunity), now, now);
        return (await this.listGrowthPlan(ownerId, businessId)).find((item) => item.opportunity.id === opportunity.id)!;
      })();
    },
    async updateGrowthPlan(ownerId: string, businessId: string, id: string, input: GrowthPlanInput) {
      return database.transaction(async () => {
        await authorize(ownerId, businessId);
        const saved = await database.prepare(`UPDATE growth_plan SET status = ?, impact = ?, effort = ?, time_to_value = ?,
          revision = revision + 1, updated_at = ? WHERE business_id = ? AND opportunity_id = ? AND revision = ?`)
          .run(input.status, input.impact, input.effort, input.timeToValue, new Date().toISOString(), businessId, id, input.revision);
        const item = (await this.listGrowthPlan(ownerId, businessId)).find((item) => item.opportunity.id === id);
        if (!item) throw new GrowthError(404, "Saved growth action not found.");
        if (!saved.changes) throw new GrowthError(409, "This growth action changed in another view. Reload before updating it.");
        return item;
      })();
    },
    async updateGrowthWork(ownerId: string, businessId: string, id: string, revision: number, work: GrowthWork) {
      const accepted = growthWorkSchema.parse(work);
      return database.transaction(async () => {
        await authorize(ownerId, businessId);
        const item = (await this.listGrowthPlan(ownerId, businessId)).find((entry) => entry.opportunity.id === id);
        if (!item) throw new GrowthError(404, "Save this action to your growth plan before connecting work.");
        const updated = await database.prepare(`UPDATE growth_plan SET opportunity_json = ?, revision = revision + 1,
          updated_at = ? WHERE business_id = ? AND opportunity_id = ? AND revision = ?`)
          .run(JSON.stringify({ ...item.opportunity, work: accepted }), new Date().toISOString(), businessId, id, revision);
        if (!updated.changes) throw new GrowthError(409, "This action changed in another view. Reload before updating its work.");
        return (await this.listGrowthPlan(ownerId, businessId)).find((entry) => entry.opportunity.id === id)!;
      })();
    },
  };
}
