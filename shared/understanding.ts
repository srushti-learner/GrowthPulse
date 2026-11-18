import { z } from "zod";
import { scanLimits, scanResultSchema } from "./website.js";
import { businessInputSchema, businessSchema } from "./contracts.js";
import { researchLimits, researchReportSchema } from "./research.js";

export const understandingTimeoutMs = 120_000;
export const briefingTextLimits = {
  summary: 700, insight: 500, insightReason: 400, question: 300, unknownReason: 300,
  action: 300, actionReason: 300, category: 120, description: 2000,
} as const;
export const briefingActionCharacterLimit = briefingTextLimits.action;
export const businessAnalysisDisclosure = `Competitor research is included. Public research queries go to Tavily; captured public website and competing-brand evidence goes to Anthropic for AI analysis. Private account details and profile notes are not sent. Up to ${researchLimits.searches} web searches, ${researchLimits.competitors} brand-site scans and ${researchLimits.modelCalls} AI requests per attempt, for up to ${researchLimits.milliseconds / 60_000} minutes. This is sampled research, not exhaustive market coverage. Tavily credits and separate AI charges may apply.`;
export const agentEvidenceLimits = { bytes: 256 * 1024, products: 100 } as const;
export const evidenceCoverageSchema = z.object({
  pagesProvided: z.number().int().min(0).max(scanLimits.pages),
  productRecordsCaptured: z.number().int().min(0).max(scanLimits.pages * 50),
  productRecordsProvided: z.number().int().min(0).max(agentEvidenceLimits.products),
  inputBytes: z.number().int().min(0).max(agentEvidenceLimits.bytes),
  limited: z.boolean(),
  limitations: z.array(z.string().max(500)).max(30),
});
export const understandingInputSchema = z.object({
  permission: z.literal(true, { error: "Confirm permission to scan and send public website evidence to Anthropic." }),
  scanId: z.uuid().optional(),
  research: z.boolean().optional(),
  researchVersion: z.literal(2).optional(),
  resumeJobId: z.uuid().optional(),
}).strict();
const sourcesSchema = z.array(z.object({
  url: z.url().max(2048),
  quote: z.string().trim().min(10).max(500),
}).strict()).min(1).max(3);
export const briefingSchema = z.object({
  summary: z.object({ text: z.string().trim().min(1).max(briefingTextLimits.summary), sources: sourcesSchema }).strict(),
  insights: z.array(z.object({
    area: z.enum(["offering", "positioning", "buying_experience"]),
    text: z.string().trim().min(1).max(briefingTextLimits.insight),
    whyItMatters: z.string().trim().min(1).max(briefingTextLimits.insightReason),
    sources: sourcesSchema,
  }).strict()).min(1).max(3).refine((items) => new Set(items.map((item) => item.area)).size === items.length, "Use each business area only once.")
    .describe("Return 1-3 insights. Use each area (offering, positioning, buying_experience) at most once; combine observations about the same area into one insight."),
  unknowns: z.array(z.object({
    question: z.string().trim().min(1).max(briefingTextLimits.question),
    whyItMatters: z.string().trim().min(1).max(briefingTextLimits.unknownReason),
  }).strict()).min(1).max(4),
  nextSteps: z.array(z.object({
    action: z.string().trim().min(1).max(briefingActionCharacterLimit)
      .describe(`One concise next check, at most ${briefingActionCharacterLimit} characters. Put supporting rationale in reason.`),
    reason: z.string().trim().min(1).max(briefingTextLimits.actionReason),
  }).strict()).min(1).max(3),
}).strict();
export const suggestionSchema = z.object({
  field: z.enum(["category", "description"]),
  value: z.string().trim().min(1).max(briefingTextLimits.description).describe("For category, use at most 120 characters. For description, use at most 2000 characters."),
  sources: sourcesSchema,
}).strict().refine((value) => value.field !== "category" || value.value.length <= briefingTextLimits.category, "Category must be at most 120 characters.");
const validatedBriefingSchema = briefingSchema.extend({
  summary: briefingSchema.shape.summary.optional(),
  insights: z.array(briefingSchema.shape.insights.element).max(3)
    .refine((items) => new Set(items.map((item) => item.area)).size === items.length, "Use each business area only once."),
  unknowns: z.array(briefingSchema.shape.unknowns.element).max(4),
  nextSteps: z.array(briefingSchema.shape.nextSteps.element).max(3),
}).refine((value) => !!value.summary || value.insights.length > 0, "A briefing needs at least one supported finding.");
export const partialBriefingNotice = "Some proposed sections could not be validated and were omitted. The remaining source-backed briefing is saved.";
export const proposalSchema = z.object({
  briefing: validatedBriefingSchema.nullable().describe("A cited business briefing. Use null only when evidence cannot support a summary and one insight; suggestions must then be empty."),
  suggestions: z.array(suggestionSchema).max(2).refine((items) => new Set(items.map((item) => item.field)).size === items.length, "Each field can be proposed only once.")
    .describe("Optional profile changes: at most one category and one description, never repeated fields. Return [] when briefing is null."),
  validationIssues: z.array(z.object({ path: z.string().max(120), code: z.string().max(60) }).strict()).min(1).max(30).optional(),
}).strict();
export const understandingSchema = proposalSchema.extend({
  briefing: validatedBriefingSchema.nullable().default(null),
  id: z.uuid(), businessId: z.uuid(), scanId: z.uuid(), createdAt: z.iso.datetime(),
  scanStatus: scanResultSchema.shape.status,
  reviewedAt: z.iso.datetime().nullable(),
  warnings: z.array(z.string()).max(30),
  productImportId: z.uuid().nullable(),
  evidenceCoverage: evidenceCoverageSchema.optional(),
  research: researchReportSchema.optional(),
});
export const understandingResponseSchema = z.object({
  understanding: understandingSchema.nullable(),
  lastSuccessfulUnderstanding: understandingSchema.nullable().optional(),
});
export const briefingPreviewSchema = z.object({
  summary: briefingSchema.shape.summary.omit({ sources: true }).partial().strip().optional(),
  insights: z.array(briefingSchema.shape.insights.element.omit({ sources: true }).partial().strip()).max(3).optional(),
  unknowns: z.array(briefingSchema.shape.unknowns.element.partial()).max(4).optional(),
  nextSteps: z.array(briefingSchema.shape.nextSteps.element.partial()).max(3).optional(),
});
export const understandingUpdateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("phase"), phase: z.enum(["connecting", "scanning", "analysing", "validating"]) }).strict(),
  z.object({ type: z.literal("briefing"), briefing: briefingPreviewSchema }).strict(),
]);
export const understandingStreamEventSchema = z.union([
  understandingUpdateSchema,
  z.object({ type: z.literal("complete"), understanding: understandingSchema }).strict(),
  z.object({ type: z.literal("error"), status: z.number().int().min(400).max(599), message: z.string().max(2048) }).strict(),
]);
export const understandingReviewInputSchema = businessInputSchema.pick({ category: true, description: true })
  .extend({ expectedUpdatedAt: z.iso.datetime() }).strict();
export const understandingReviewResponseSchema = z.object({ business: businessSchema, understanding: understandingSchema });
export type UnderstandingReviewInput = z.infer<typeof understandingReviewInputSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Understanding = z.infer<typeof understandingSchema>;
export type BriefingPreview = z.infer<typeof briefingPreviewSchema>;
export type UnderstandingUpdate = z.infer<typeof understandingUpdateSchema>;
export type UnderstandingStreamEvent = z.infer<typeof understandingStreamEventSchema>;
