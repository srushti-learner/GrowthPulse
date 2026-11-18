import { z } from "zod";
import type { Product } from "./products.js";

export const productDimensions = ["description", "positioning", "visuals", "information", "discoverability", "customer_appeal"] as const;
export const productDimensionLabels: Record<typeof productDimensions[number], string> = {
  description: "Description quality", positioning: "Value proposition", visuals: "Visual presentation",
  information: "Product information", discoverability: "Discoverability", customer_appeal: "Customer appeal",
};
const referenceId = z.string().regex(/^e_[a-f0-9]{16}$/);
const references = z.array(referenceId).min(1).max(4);
export const productEvidenceSchema = z.object({
  id: referenceId, source: z.enum(["manual", "csv", "website"]), sourceName: z.string(),
  reference: z.string(), quote: z.string().min(10).max(500), capturedAt: z.iso.datetime(),
});
export const productAnalysisOutputSchema = z.object({
  summary: z.object({ text: z.string().trim().min(1).max(600), references }),
  dimensions: z.array(z.object({
    dimension: z.enum(productDimensions), status: z.enum(["supported", "needs_review", "not_assessed"]),
    diagnosis: z.string().trim().min(1).max(400), references,
  }).strict()).length(6),
  rewrite: z.object({
    title: z.string().trim().min(1).max(300), description: z.string().trim().max(2000),
    seoTitle: z.string().trim().max(70), metaDescription: z.string().trim().max(170), references,
  }).strict(),
  recommendations: z.array(z.object({
    title: z.string().trim().min(1).max(150), detail: z.string().trim().min(1).max(600),
    priority: z.enum(["first", "next", "later"]), references,
  }).strict()).min(1).max(4),
}).strict();
export const savedProductAnalysisSchema = z.object({
  id: z.uuid(), productId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime(),
  result: productAnalysisOutputSchema, evidence: z.array(productEvidenceSchema).min(1).max(64),
});
export const productIntelligenceResponseSchema = z.object({
  configured: z.boolean(), analysis: savedProductAnalysisSchema.nullable(), stale: z.boolean(),
  running: z.boolean(), error: z.string().nullable(),
});
export const productAnalysisConsentSchema = z.object({ consent: z.literal(true) }).strict();
export const productAnalysisSummariesSchema = z.object({
  analyses: z.array(z.object({ productId: z.uuid(), fingerprint: z.string(), createdAt: z.iso.datetime() })),
});
export const productPlanInputSchema = z.object({ analysisId: z.uuid(), index: z.number().int().min(0).max(3) }).strict();
export const productRewriteInputSchema = z.object({
  analysisId: z.uuid(), title: z.string().trim().min(1).max(300), description: z.string().trim().max(2000),
}).strict();
export type ProductAnalysisOutput = z.infer<typeof productAnalysisOutputSchema>;
export type SavedProductAnalysis = z.infer<typeof savedProductAnalysisSchema>;
export type ProductEvidence = z.infer<typeof productEvidenceSchema>;
export type ProductIntelligenceResponse = z.infer<typeof productIntelligenceResponseSchema>;
export type ProductAnalysisSummary = z.infer<typeof productAnalysisSummariesSchema>["analyses"][number];

export function productReadiness(product: Product) {
  const listings = product.listings.map((listing) => listing.data);
  return [
    { key: "description", label: "Description recorded", present: !!product.description.trim() || listings.some((data) => !!data.description.trim()) },
    { key: "image", label: "Image URL recorded", present: listings.some((data) => !!data.imageUrl) },
    { key: "price", label: "Price and currency recorded", present: listings.some((data) => !!data.price && !!data.currency || data.offers.some((offer) => !!offer.price && !!offer.currency)) },
    { key: "availability", label: "Availability recorded", present: listings.some((data) => !!data.availability.trim() && data.availability.trim().toLowerCase() !== "unknown") },
    { key: "identity", label: "SKU or GTIN recorded", present: !!product.sku || !!product.gtin || listings.some((data) => !!data.sku || !!data.gtin) },
    { key: "variants", label: "Variant information recorded", present: listings.some((data) => !!data.variants.trim()) },
  ];
}
