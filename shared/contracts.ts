import { z } from "zod";

const id = z.uuid();
const timestamp = z.iso.datetime();
const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase());

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email,
  password: z.string().min(12, "Use at least 12 characters.").max(128),
}).strict();
export const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();
export const userSchema = z.object({ id, name: z.string(), email: z.string().email() });
export const sessionSchema = z.object({ user: userSchema });
export type User = z.infer<typeof userSchema>;

const website = z.union([
  z.literal(""),
  z.url().max(2048).refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  }, "Use an HTTP or HTTPS website URL without credentials."),
]);
export const businessInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().max(120),
  description: z.string().trim().max(2000),
  website: website,
}).strict();
export const businessSchema = businessInputSchema.extend({ id, createdAt: timestamp, updatedAt: timestamp });
export const businessesSchema = z.object({ businesses: z.array(businessSchema) });
export const businessResponseSchema = z.object({ business: businessSchema });
export type BusinessInput = z.infer<typeof businessInputSchema>;
export type Business = z.infer<typeof businessSchema>;

export const evidenceSchema = z.object({
  id, businessId: id,
  source: z.enum(["manual", "website", "product", "whatsapp"]),
  reference: z.string().min(1).max(2048),
  summary: z.string().min(1).max(2000),
  capturedAt: timestamp,
});
export const evidenceResponseSchema = z.object({ evidence: z.array(evidenceSchema) });
export type Evidence = z.infer<typeof evidenceSchema>;

export const activitySchema = z.object({
  id, businessId: id, evidenceId: id,
  action: z.enum(["business.created", "business.updated", "website.scanned", "product.saved", "products.imported"]),
  createdAt: timestamp,
});
export const activitiesSchema = z.object({ activities: z.array(activitySchema) });
export type Activity = z.infer<typeof activitySchema>;

export const healthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("growthpulse-api"),
  database: z.object({ engine: z.literal("sqlite"), status: z.literal("ok") }),
});
