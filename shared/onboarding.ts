import { z } from "zod";
import { businessSchema } from "./contracts.js";
import { savedScanSchema, scanResultSchema } from "./website.js";
import { understandingSchema } from "./understanding.js";

export const previewLifetime = 30 * 60 * 1000;
export const onboardingPreviewSchema = z.object({
  scan: scanResultSchema,
  expiresAt: z.iso.datetime(),
});
export const onboardingPreviewResponseSchema = z.object({ preview: onboardingPreviewSchema.nullable() });
export const onboardingScanResponseSchema = z.object({ preview: onboardingPreviewSchema });
export const onboardingClaimSchema = z.object({ permission: z.literal(true) }).strict();
export const onboardingClaimResponseSchema = z.object({
  business: businessSchema,
  scan: savedScanSchema,
  understanding: understandingSchema.nullable(),
});
export type OnboardingPreview = z.infer<typeof onboardingPreviewSchema>;
