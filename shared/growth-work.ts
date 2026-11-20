import { z } from "zod";
import { researchSourceSchema } from "./research.js";

export const workScopes = ["product", "products", "business", "new_product", "unclear"] as const;
export const workScopeLabels = {
  product: "One product", products: "Several products", business: "Website, channel or business",
  new_product: "New product concept", unclear: "Needs your decision",
};
const references = z.array(z.string().regex(/^e_[a-f0-9]{16}$/)).min(1).max(6);
export const workDecisionOutputSchema = z.object({
  scope: z.enum(workScopes), reason: z.string().trim().min(1).max(600), references,
  candidates: z.array(z.object({
    productId: z.uuid(), reason: z.string().trim().min(1).max(400), references,
  }).strict()).max(8),
}).strict();
export const workDecisionSchema = z.object({
  scope: z.enum(workScopes), reason: z.string(),
  candidates: z.array(z.object({ productId: z.uuid(), reason: z.string(), sources: z.array(researchSourceSchema).min(1) })),
  sources: z.array(researchSourceSchema).min(1),
  catalogueFingerprint: z.string(), createdAt: z.iso.datetime(),
});
export const workSelectionSchema = z.object({
  scope: z.enum(["product", "products", "business", "new_product"]),
  products: z.array(z.object({ productId: z.uuid(), fingerprint: z.string() })).max(8),
  confirmedAt: z.iso.datetime(),
});
export const workStepStatuses = ["draft", "approved", "implemented", "measured"] as const;
export const workStepSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().min(1).max(150), detail: z.string().min(1).max(600),
  sources: z.array(researchSourceSchema).min(1).max(6),
  status: z.enum(workStepStatuses), outcome: z.string().max(1000),
  productId: z.uuid().optional(),
  origin: z.enum(["action", "product", "owner"]).optional(),
});
export const growthWorkSchema = z.object({
  decision: workDecisionSchema.nullable(), selection: workSelectionSchema.nullable(),
  steps: z.array(workStepSchema).max(30),
});
export const emptyGrowthWork = () => ({ decision: null, selection: null, steps: [] } satisfies GrowthWork);
export const workProposalOutputSchema = z.object({
  steps: z.array(z.object({ title: z.string().trim().min(1).max(150), detail: z.string().trim().min(1).max(600), references }).strict()).min(1).max(6),
}).strict();
export const workConsentSchema = z.object({ consent: z.literal(true), revision: z.number().int().nonnegative() }).strict();
export const workSelectionInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  catalogueFingerprint: z.string().min(1),
  scope: z.enum(["product", "products", "business", "new_product"]),
  productIds: z.array(z.uuid()).max(8),
}).strict().refine((value) => new Set(value.productIds).size === value.productIds.length
  && (value.scope === "product" ? value.productIds.length === 1 : value.scope === "products"
    ? value.productIds.length >= 2 : value.productIds.length === 0), "Choose one product, several products, or no products for business/new-product work.");
export const workStepInputSchema = z.object({
  revision: z.number().int().nonnegative(), stepId: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(workStepStatuses), outcome: z.string().trim().max(1000),
}).strict().refine((value) => value.status !== "measured" || !!value.outcome, "Record the observed result before marking a step measured.");
export const manualWorkStepInputSchema = z.object({
  revision: z.number().int().nonnegative(), title: z.string().trim().min(1).max(150), detail: z.string().trim().min(1).max(600),
}).strict();
export type GrowthWork = z.infer<typeof growthWorkSchema>;
export type WorkDecision = z.infer<typeof workDecisionSchema>;
export type WorkSelection = z.infer<typeof workSelectionSchema>;
export type WorkStep = z.infer<typeof workStepSchema>;
export const isActionGeneratedStep = (step: WorkStep) => step.origin === "action" || !step.origin && !step.productId;
