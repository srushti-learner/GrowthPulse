import { z } from "zod";
import { researchAgents, researchSourceSchema } from "./research.js";
import { growthWorkSchema, workDecisionSchema } from "./growth-work.js";
import { productSchema } from "./products.js";

export const growthOpportunityId = z.string().regex(/^[a-f0-9]{64}$/);
export const growthAssessment = ["unknown", "low", "medium", "high"] as const;
export const growthStatuses = ["planned", "in_progress", "completed", "dismissed"] as const;
export const growthTimelines = ["unknown", "days", "weeks", "months"] as const;
export const growthOpportunitySchema = z.object({
  id: growthOpportunityId,
  title: z.string().min(1).max(150),
  detail: z.string().min(1).max(600),
  agents: z.array(z.enum(researchAgents)).min(1).max(6),
  sources: z.array(researchSourceSchema).min(1).max(18),
  reviewReason: z.string(),
  originProductId: z.uuid().optional(),
  work: growthWorkSchema.optional(),
  strategy: z.object({
    objective: z.string(), actions: z.array(z.string()).min(1).max(5), metric: z.string(),
    hypothesis: z.string(), measurement: z.string(),
  }),
});
export const growthPlanInputSchema = z.object({
  status: z.enum(growthStatuses),
  impact: z.enum(growthAssessment),
  effort: z.enum(growthAssessment),
  timeToValue: z.enum(growthTimelines),
  revision: z.number().int().nonnegative(),
}).strict();
export const growthPlanItemSchema = growthPlanInputSchema.extend({
  opportunity: growthOpportunitySchema, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export const growthResponseSchema = z.object({
  opportunities: z.array(growthOpportunitySchema),
  plan: z.array(growthPlanItemSchema),
  researchStatus: z.enum(["unavailable", "running", "partial", "complete"]),
  evidenceSavedAt: z.iso.datetime().nullable(),
});
export const growthPlanResponseSchema = z.object({ item: growthPlanItemSchema });
export const growthWorkResponseSchema = z.object({
  configured: z.boolean(), opportunity: growthOpportunitySchema, item: growthPlanItemSchema.nullable(),
  products: z.array(productSchema), decision: workDecisionSchema.nullable(), stale: z.boolean(),
  catalogueFingerprint: z.string(),
});
export type GrowthWorkResponse = z.infer<typeof growthWorkResponseSchema>;
export type GrowthOpportunity = z.infer<typeof growthOpportunitySchema>;
export type GrowthPlanItem = z.infer<typeof growthPlanItemSchema>;
export type GrowthPlanInput = z.infer<typeof growthPlanInputSchema>;
export type GrowthResponse = z.infer<typeof growthResponseSchema>;
