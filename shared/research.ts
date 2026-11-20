import { z } from "zod";
import { scanLimits } from "./website.js";

export const researchAgents = ["store", "competitor", "customer", "pricing", "opportunity", "growth"] as const;
export const researchAgentLabels: Record<ResearchAgent, string> = {
  store: "Store intelligence", competitor: "Competitor intelligence", customer: "Customer intelligence",
  pricing: "Pricing intelligence", opportunity: "Product opportunities", growth: "Growth strategy",
};
export const researchLimits = {
  version: 2, milliseconds: 600_000, searches: 6, competitors: 6, productsPerSite: 5,
  modelCalls: 14, outputTokens: 2000, contextCharacters: 32_000, steps: 26, stepBytes: 8 * 1024,
  frameBytes: 512 * 1024,
} as const;
export const competitorDimensions = ["products", "positioning", "market", "pricing", "offers", "buying_experience"] as const;
export const competitorDimensionLabels = {
  products: "Products and customer need", positioning: "Positioning", market: "Market served",
  pricing: "Published prices and packs", offers: "Offers", buying_experience: "Buying experience",
};
export const researchSourceSchema = z.object({
  id: z.string().regex(/^e_[a-f0-9]{16}$/), url: z.url().max(2048),
  quote: z.string().min(10).max(500), capturedAt: z.iso.datetime(),
  customerReview: z.object({
    productId: z.uuid(), productName: z.string().min(1).max(150), reportId: z.uuid(),
    relation: z.enum(["my_listing", "other_seller", "same_product", "alternative"]),
    method: z.enum(["public_page", "owner_export"]), reviewDate: z.string().date().nullable(),
    analysedAt: z.iso.datetime(),
  }).strict().optional(),
}).strict();
export const researchFindingSchema = z.object({
  kind: z.enum(["observation", "hypothesis", "suggestion"]),
  title: z.string().trim().min(1).max(150),
  detail: z.string().trim().min(1).max(600),
  sources: z.array(researchSourceSchema).min(1).max(3),
}).strict();
export const verifiedBrandSchema = z.object({
  name: z.string().trim().min(1).max(120), url: z.url().max(2048),
  relevance: z.string().min(1).max(400),
  marketVerified: z.boolean(),
  facts: z.array(z.object({
    dimension: z.enum(competitorDimensions), text: z.string().min(1).max(300),
    sourceId: researchSourceSchema.shape.id,
  }).strict()).min(1).max(6),
  sources: z.array(researchSourceSchema).min(1).max(9),
  limitations: z.array(z.string().max(300)).max(8),
}).strict();
export const researchStepSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,60}$/),
  agent: z.enum(researchAgents),
  status: z.enum(["running", "completed", "limited", "failed"]),
  findings: z.array(researchFindingSchema).max(4),
  limitations: z.array(z.string().trim().min(1).max(500)).max(8),
  diagnostic: z.object({ code: z.string().max(80), paths: z.array(z.string().max(120)).max(10) }).strict().nullable(),
  startedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
  reused: z.boolean().default(false),
  inputVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  profile: verifiedBrandSchema.optional(),
  capture: z.object({ url: z.url().max(2048), pages: z.number().int().min(0).max(scanLimits.pages) }).strict().optional(),
  search: z.object({ query: z.string().max(500), domains: z.array(z.string().max(253)).max(5) }).strict().optional(),
}).strict();
export const researchReportSchema = z.object({
  version: z.literal(1), status: z.enum(["running", "complete", "partial"]),
  enabled: z.boolean(), steps: z.array(researchStepSchema).max(researchLimits.steps),
  usage: z.object({
    searches: z.number().int().min(0).max(researchLimits.searches),
    modelCalls: z.number().int().min(0).max(researchLimits.modelCalls),
    competitorScans: z.number().int().min(0).max(researchLimits.competitors),
  }).strict(),
}).strict();
export type ResearchAgent = typeof researchAgents[number];
export type ResearchSource = z.infer<typeof researchSourceSchema>;
export type ResearchFinding = z.infer<typeof researchFindingSchema>;
export type ResearchStep = z.infer<typeof researchStepSchema>;
export type ResearchReport = z.infer<typeof researchReportSchema>;
export type VerifiedBrand = z.infer<typeof verifiedBrandSchema>;
