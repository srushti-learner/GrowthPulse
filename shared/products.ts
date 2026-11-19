import { z } from "zod";
import { scannedCatalogueSchema } from "./website.js";

export const catalogueLimit = 200;
export const importRowLimit = 100;
export const productDescriptionLimit = 2000;
export const normalizedSku = (value: string) => value.trim().toUpperCase();
export const normalizedGtin = (value: string) => value ? value.padStart(14, "0") : "";
function validGtin(value: string) {
  if (!value) return true;
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return false;
  const digits = [...value].map(Number);
  const check = digits.pop()!;
  return (10 - digits.reverse().reduce((sum, digit, index) => sum + digit * (index % 2 ? 1 : 3), 0) % 10) % 10 === check;
}
const price = z.string().trim().max(16).refine((value) => !value || /^\d{1,10}(?:\.\d{1,4})?$/.test(value), "Use a nonnegative decimal price, without currency symbols or separators (up to 4 decimal places).");
const currency = z.string().trim().toUpperCase().refine((value) => !value || Intl.supportedValuesOf("currency").includes(value), "Use a supported three-letter currency such as INR or USD.");
export const productImageUrlSchema = z.string().max(2048).refine((value) => {
  let url: URL;
  try { url = new URL(value); }
  catch { return false; }
  return url.protocol === "https:" && !url.username && !url.password && !url.port
    && url.hostname.includes(".") && /[a-z]/i.test(url.hostname) && !url.hostname.includes(":") && !url.hostname.endsWith(".")
    && !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/i.test(url.hostname);
}, "Use a public HTTPS image URL without credentials or a custom port.");
export const offerSchema = z.object({
  price, currency, availability: z.string().trim().max(200),
}).strict().refine((value) => !value.price || !!value.currency, { path: ["currency"], message: "Currency is required when price is supplied." });
export const productInputSchema = z.object({
  name: z.string().trim().min(1, "Product name is required.").max(300),
  description: z.string().trim().max(productDescriptionLimit),
  sku: z.string().trim().max(100),
  gtin: z.string().trim().refine(validGtin, "Use a valid GTIN-8/12/13/14 with its check digit, or leave it blank."),
  price, currency,
  availability: z.string().trim().max(200),
  variants: z.string().trim().max(1000),
  offers: z.array(offerSchema).max(20).default([]),
  imageUrl: productImageUrlSchema.optional(),
}).strict().refine((value) => !value.price || !!value.currency, { path: ["currency"], message: "Currency is required when price is supplied." });
export type ProductInput = z.infer<typeof productInputSchema>;
export const productPreviewSchema = z.object(productInputSchema.shape).partial();
export const emptyProduct: ProductInput = { name: "", description: "", sku: "", gtin: "", price: "", currency: "", availability: "unknown", variants: "", offers: [] };
export const listingSchema = z.object({
  id: z.uuid(), source: z.enum(["manual", "csv", "website"]), sourceName: z.string(),
  reference: z.string(), sourceKey: z.string(), capturedAt: z.iso.datetime(), data: productInputSchema,
});
export const productSchema = z.object({
  id: z.uuid(), businessId: z.uuid(), name: z.string(), description: z.string(), sku: z.string(), gtin: z.string(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), listings: z.array(listingSchema),
});
export type Product = z.infer<typeof productSchema>;
export const productsResponseSchema = z.object({ products: z.array(productSchema) });
export const scannedProductsResponseSchema = productsResponseSchema.extend({ catalogue: scannedCatalogueSchema.nullable() });
export const productResponseSchema = z.object({ product: productSchema });
export const importRowSchema = z.object({
  row: z.number().int().positive(), sourceKey: z.string(), reference: z.string().max(2048),
  capturedAt: z.iso.datetime(), data: productInputSchema.nullable(), errors: z.array(z.string()), notes: z.array(z.string()),
  preview: productPreviewSchema.optional(),
});
export type ImportRow = z.infer<typeof importRowSchema>;
export const importDraftSchema = z.object({
  id: z.uuid(), businessId: z.uuid(), source: z.enum(["csv", "website"]), sourceName: z.string(),
  createdAt: z.iso.datetime(), rows: z.array(importRowSchema).max(importRowLimit),
  matches: z.array(z.object({ row: z.number(), kind: z.enum(["repeat", "identifier", "review", "new"]), productId: z.uuid().nullable(), candidates: z.array(z.uuid()) })),
  committed: z.boolean(),
});
export const importResponseSchema = z.object({ draft: importDraftSchema });
export type ImportDraft = z.infer<typeof importDraftSchema>;
export const decisionsSchema = z.object({
  decisions: z.array(z.discriminatedUnion("action", [
    z.object({ row: z.number().int().positive(), action: z.literal("skip") }).strict(),
    z.object({ row: z.number().int().positive(), action: z.literal("new") }).strict(),
    z.object({ row: z.number().int().positive(), action: z.literal("link"), productId: z.uuid() }).strict(),
  ])).max(importRowLimit),
}).strict();
export type ImportDecision = z.infer<typeof decisionsSchema>["decisions"][number];
export const importResultSchema = z.object({ result: z.object({ imported: z.number().int(), skipped: z.number().int(), created: z.number().int(), updated: z.number().int() }) });
export const csvImportSchema = z.object({ sourceName: z.string().trim().min(1).max(80), csv: z.string().min(1).max(49_152) }).strict();
export const websiteImportSchema = z.object({ scanId: z.uuid() }).strict();
