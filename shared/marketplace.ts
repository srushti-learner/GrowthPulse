import { z } from "zod";
import { researchSourceSchema } from "./research.js";

export const marketplaceLimits = { milliseconds: 180_000, listings: 6, reviews: 50, searches: 4 } as const;
export const marketplaceRelations = ["unconfirmed", "my_listing", "other_seller", "alternative", "excluded"] as const;
export const marketplaceRelationLabels: Record<typeof marketplaceRelations[number], string> = {
  unconfirmed: "Needs confirmation", my_listing: "My listing", other_seller: "My product, another seller",
  alternative: "Comparable product", excluded: "Not relevant",
};
export const marketplaceReviewSchema = z.object({
  id: z.string().regex(/^r_[a-f0-9]{16}$/), text: z.string().min(10).max(500),
  rating: z.number().min(0).max(5).nullable(), date: z.string().date().nullable(),
}).strict();
export const marketplaceListingSchema = z.object({
  id: z.string().regex(/^m_[a-f0-9]{16}$/), url: z.url(), marketplace: z.enum(["Amazon India", "Flipkart"]),
  title: z.string().max(300), description: z.string().max(2000), capturedAt: z.iso.datetime(), method: z.enum(["public_page", "owner_export"]),
  status: z.enum(["captured", "unavailable"]), limitation: z.string().max(500),
  gtin: z.string().max(14), variants: z.string().max(1000), seller: z.string().max(200),
  price: z.string().max(16), currency: z.string().max(3),
  rating: z.number().min(0).max(5).nullable(), reviewCount: z.number().int().nonnegative().nullable(),
  relation: z.enum(marketplaceRelations), identifierMatch: z.boolean(),
  reviews: z.array(marketplaceReviewSchema).max(marketplaceLimits.reviews),
  sources: z.array(researchSourceSchema).max(10),
}).strict();
const themeSchema = z.object({
  title: z.string().trim().min(1).max(100),
  sentiment: z.enum(["positive", "negative", "mixed"]),
  scope: z.enum(["own_product", "alternatives"]),
  reviewIds: z.array(marketplaceReviewSchema.shape.id).min(2).max(10),
  experiment: z.string().trim().min(1).max(350),
}).strict();
export const marketplaceThemesSchema = z.object({ themes: z.array(themeSchema).max(4) }).strict();
export const marketplaceReportSchema = z.object({
  id: z.uuid(), productId: z.uuid(), productName: z.string(), fingerprint: z.string().length(64), createdAt: z.iso.datetime(),
  listings: z.array(marketplaceListingSchema).max(marketplaceLimits.listings),
  themes: marketplaceThemesSchema.shape.themes, analysedAt: z.iso.datetime().nullable(),
  limitations: z.array(z.string().max(500)).max(12),
}).strict();
export const marketplaceResponseSchema = z.object({
  configured: z.boolean(), discoveryConfigured: z.boolean(),
  report: marketplaceReportSchema.nullable(), running: z.boolean(), stale: z.boolean(), error: z.string().nullable(),
});
export const marketplaceResearchInput = z.object({
  consent: z.literal(true), requestKey: z.uuid(),
  urls: z.array(z.string().trim().min(1).max(2048)).max(marketplaceLimits.listings).default([]),
  refresh: z.boolean().default(false),
}).strict();
export const marketplaceMatchInput = z.object({
  reportId: z.uuid(), listingId: marketplaceListingSchema.shape.id,
  relation: z.enum(marketplaceRelations),
}).strict();
export const marketplaceAnalyseInput = z.object({ reportId: z.uuid(), consent: z.literal(true) }).strict();
export const marketplaceImportInput = z.object({
  consent: z.literal(true), csv: z.string().min(1).max(49_152),
}).strict();
export type MarketplaceListing = z.infer<typeof marketplaceListingSchema>;
export type MarketplaceReport = z.infer<typeof marketplaceReportSchema>;
export type MarketplaceResponse = z.infer<typeof marketplaceResponseSchema>;
