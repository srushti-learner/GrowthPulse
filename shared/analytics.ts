import { z } from "zod";
import { trafficImportSchema } from "./traffic.js";
import { growthOpportunityId } from "./growth.js";

// Monetary amounts use integer ten-thousandths of the selected currency.
export const moneyScale = 10_000;
const amount = z.number().int().nonnegative().max(8_000_000_000_000);
const moneyFields = ["gross", "discounts", "reversals", "cogs", "operatingExpenses"] as const;
export const analyticsDate = z.iso.date();
export const analyticsCurrency = z.string().regex(/^[A-Z]{3}$/).refine((value) => Intl.supportedValuesOf("currency").includes(value), "Choose a supported currency.");
export const dailySalesSchema = z.object({
  date: analyticsDate, gross: amount, discounts: amount, reversals: amount,
  orders: z.number().int().nonnegative(), units: z.number().int(),
  sessions: z.number().int().nonnegative().nullable(),
  purchasingSessions: z.number().int().nonnegative().nullable(),
  cogs: amount.nullable(), operatingExpenses: amount.nullable(),
}).strict().refine((day) => day.discounts <= day.gross, "Discounts cannot exceed gross sales.")
  .refine((day) => day.gross === 0 || day.orders > 0, "Positive booked sales require at least one order.")
  .refine((day) => day.purchasingSessions === null || (day.sessions !== null && day.purchasingSessions <= day.sessions), "Purchasing sessions require total sessions and cannot exceed them.");
export type DailySales = z.infer<typeof dailySalesSchema>;
export const salesSnapshotSchema = z.object({
  currency: analyticsCurrency, days: z.array(dailySalesSchema).min(1).max(3660),
  products: z.array(z.object({ sku: z.string(), name: z.string(), netSales: z.number().int(), units: z.number().int() })).max(12),
  accepted: z.number().int(), rejected: z.number().int(), excluded: z.number().int(),
  errors: z.array(z.string()).max(12), warnings: z.array(z.string()).max(20),
}).refine((snapshot) => moneyFields.every((key) => snapshot.days.reduce((total, day) => total + (day[key] ?? 0), 0) <= 8_000_000_000_000), "Import totals exceed the supported monetary range.");
export type SalesSnapshot = z.infer<typeof salesSnapshotSchema>;
export const salesImportSchema = z.object({
  id: z.uuid(), filename: z.string(), createdAt: z.iso.datetime(), committed: z.boolean(),
  snapshot: salesSnapshotSchema,
});
export const salesImportResponseSchema = z.object({ draft: salesImportSchema });
export type SalesImport = z.infer<typeof salesImportSchema>;
export const manualSalesSchema = z.object({
  currency: analyticsCurrency, day: dailySalesSchema,
  evidence: z.string().trim().min(3).max(300),
  estimated: z.boolean(),
}).strict();
export const scenarioInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  start: analyticsDate, end: analyticsDate,
  ordersPct: z.number().min(-100).max(300),
  aovPct: z.number().min(-100).max(300),
  costPct: z.number().min(-100).max(300),
  opportunityId: growthOpportunityId.optional(),
}).strict().refine((value) => value.start <= value.end, "The end date must follow the start date.");
export type ScenarioInput = z.infer<typeof scenarioInputSchema>;
export const savedScenarioSchema = z.object({
  id: z.uuid(), createdAt: z.iso.datetime(), input: scenarioInputSchema,
  baselineVersion: z.string(), days: z.array(dailySalesSchema),
});
export type SavedScenario = z.infer<typeof savedScenarioSchema>;
export const analyticsDataSchema = z.object({
  currency: analyticsCurrency.nullable(), version: z.string(),
  days: z.array(dailySalesSchema), products: salesSnapshotSchema.shape.products,
  sources: z.array(z.object({ name: z.string(), kind: z.enum(["import", "manual", "estimate"]), createdAt: z.string() })),
  imports: z.array(salesImportSchema.omit({ snapshot: true })),
  scenarios: z.array(savedScenarioSchema),
  traffic: trafficImportSchema.nullable().default(null),
  warnings: z.array(z.string()),
}).refine((data) => moneyFields.every((key) => data.days.reduce((total, day) => total + (day[key] ?? 0), 0) <= 8_000_000_000_000), "Combined history exceeds the supported monetary range.");
export type AnalyticsData = z.infer<typeof analyticsDataSchema>;
export const analyticsResponseSchema = z.object({ analytics: analyticsDataSchema });
