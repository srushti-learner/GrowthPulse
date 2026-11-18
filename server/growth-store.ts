import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { growthPlanItemSchema, type GrowthOpportunity, type GrowthPlanInput, type GrowthPlanItem } from "../shared/growth.js";
import { researchAgentLabels, type ResearchReport, type ResearchAgent } from "../shared/research.js";

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
            "Check the captured evidence against the current website and confirm the problem with customers or analytics.",
            finding.detail,
            "Draft the smallest change that tests this recommendation; review costs and obtain owner approval before publishing.",
            "Choose a comparable baseline and test audience, then record the outcome before expanding the change.",
          ],
          metric: metrics[step.agent],
          hypothesis: `Test whether this recommendation improves the chosen metric: ${finding.title}`,
          measurement: "Set a baseline, eligible audience, test duration and success threshold before starting. Compare against a control where feasible; account for seasonality and sample size.",
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
export function growthStore(database: Database.Database) {
  function authorize(ownerId: string, businessId: string) {
    if (!database.prepare("SELECT id FROM businesses WHERE id = ? AND owner_id = ?").get(businessId, ownerId)) {
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
    listGrowthPlan(ownerId: string, businessId: string) {
      authorize(ownerId, businessId);
      return database.prepare<[string], PlanRow>("SELECT * FROM growth_plan WHERE business_id = ? ORDER BY created_at, opportunity_id")
        .all(businessId).map(view);
    },
    addGrowthPlan(ownerId: string, businessId: string, opportunity: GrowthOpportunity) {
      authorize(ownerId, businessId);
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO growth_plan (business_id, opportunity_id, opportunity_json, status, impact, effort, time_to_value, created_at, updated_at)
        VALUES (?, ?, ?, 'planned', 'unknown', 'unknown', 'unknown', ?, ?) ON CONFLICT (business_id, opportunity_id) DO NOTHING`)
        .run(businessId, opportunity.id, JSON.stringify(opportunity), now, now);
      return this.listGrowthPlan(ownerId, businessId).find((item) => item.opportunity.id === opportunity.id)!;
    },
    updateGrowthPlan(ownerId: string, businessId: string, id: string, input: GrowthPlanInput) {
      authorize(ownerId, businessId);
      const saved = database.prepare(`UPDATE growth_plan SET status = ?, impact = ?, effort = ?, time_to_value = ?,
        revision = revision + 1, updated_at = ? WHERE business_id = ? AND opportunity_id = ? AND revision = ?`)
        .run(input.status, input.impact, input.effort, input.timeToValue, new Date().toISOString(), businessId, id, input.revision);
      const item = this.listGrowthPlan(ownerId, businessId).find((item) => item.opportunity.id === id);
      if (!item) throw new GrowthError(404, "Saved growth action not found.");
      if (!saved.changes) throw new GrowthError(409, "This growth action changed in another view. Reload before updating it.");
      return item;
    },
  };
}
