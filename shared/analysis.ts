import { z } from "zod";
import { briefingPreviewSchema, understandingSchema } from "./understanding.js";
import { researchReportSchema } from "./research.js";

export const analysisJobSchema = z.object({
  id: z.uuid(), businessId: z.uuid(), requestedUrl: z.url(), scanId: z.uuid().nullable(),
  status: z.enum(["queued", "running", "completed", "failed", "interrupted", "cancelled"]),
  phase: z.enum(["connecting", "scanning", "analysing", "validating"]),
  preview: briefingPreviewSchema.nullable(),
  understanding: understandingSchema.nullable(),
  error: z.string().max(2048).nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  research: researchReportSchema.optional(),
  researchEnabled: z.boolean().optional(),
  researchVersion: z.number().int().min(1).max(2).optional(),
  reuseCustomerEvidence: z.boolean().optional(),
});
export const analysisJobResponseSchema = z.object({ job: analysisJobSchema });
export const analysisJobEventSchema = z.object({ type: z.literal("job"), job: analysisJobSchema }).strict();
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export const analysisLimits = { queued: 50, leaseMs: 30_000, queueLifetimeMs: 15 * 60_000 } as const;
export function activeAnalysis(job: AnalysisJob) { return job.status === "queued" || job.status === "running"; }
