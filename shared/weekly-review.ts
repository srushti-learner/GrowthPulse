import { z } from "zod";
import { analyticsCurrency, analyticsDate, type AnalyticsData, type DailySales } from "./analytics.js";
import { nextDate, percentageChange, salesMetrics } from "./analytics-math.js";
import { growthOpportunityId } from "./growth.js";

export const reviewMetrics = ["net", "orders", "aov"] as const;
export const reviewMetricLabels = { net: "Net sales", orders: "Orders", aov: "Average order value" };
const valuesSchema = z.object({ net: z.number(), orders: z.number().int().nonnegative(), aov: z.number().nullable() });
const periodSchema = z.object({
  start: analyticsDate, end: analyticsDate, observedDates: z.number().int().min(0).max(7),
  values: valuesSchema.nullable(),
});
export const weeklyReportSchema = z.object({
  asOf: analyticsDate, currency: analyticsCurrency.nullable(),
  previous: periodSchema, current: periodSchema,
  changes: z.array(z.object({
    metric: z.enum(reviewMetrics), before: z.number(), after: z.number(),
    percent: z.number().nullable(), attention: z.boolean(),
  })).max(3),
  hasEstimates: z.boolean(), warnings: z.array(z.string()).max(21),
  sourceNames: z.array(z.string()).max(12),
});
export type WeeklyReport = z.infer<typeof weeklyReportSchema>;
export const savedWeeklyReviewSchema = z.object({
  id: z.uuid(), version: z.string(), createdAt: z.iso.datetime(), report: weeklyReportSchema,
});
const outcomeSchema = z.object({
  version: z.string(), recordedAt: z.iso.datetime(), value: z.number(), percent: z.number().nullable(),
  hasEstimates: z.boolean(), warnings: z.array(z.string()).max(21),
  sourceNames: z.array(z.string()).max(12).optional(),
});
export const actionMeasurementSchema = z.object({
  id: z.uuid(), opportunityId: growthOpportunityId, title: z.string(),
  metric: z.enum(reviewMetrics), currency: analyticsCurrency,
  startDate: analyticsDate, reviewDate: analyticsDate, createdAt: z.iso.datetime(),
  baseline: z.object({
    version: z.string(), period: periodSchema, hasEstimates: z.boolean(), warnings: z.array(z.string()).max(21),
    sourceNames: z.array(z.string()).max(12).optional(),
  }),
  outcome: outcomeSchema.nullable(),
  decision: z.enum(["continue", "revise", "stop"]).nullable(),
  note: z.string(), decidedAt: z.iso.datetime().nullable(),
});
export type ActionMeasurement = z.infer<typeof actionMeasurementSchema>;
export const weeklyReviewResponseSchema = z.object({
  version: z.string(), observedAt: z.iso.datetime().nullable(), coveredThrough: analyticsDate.nullable(),
  stale: z.boolean(), observationCount: z.number().int().nonnegative(),
  current: weeklyReportSchema, reviews: z.array(savedWeeklyReviewSchema).max(12),
  measurements: z.array(z.object({
    measurement: actionMeasurementSchema,
    status: z.enum(["waiting", "needs_data", "ready", "reviewed", "stopped"]),
    observedDates: z.number().int().min(0).max(7), value: z.number().nullable(), percent: z.number().nullable(),
    hasEstimates: z.boolean(), warnings: z.array(z.string()).max(21),
  })).max(100),
});
export type WeeklyReviewState = z.infer<typeof weeklyReviewResponseSchema>;
export const saveWeeklyReviewInput = z.object({
  expectedVersion: z.string().min(1).max(128), periodEnd: analyticsDate,
}).strict();
export const startMeasurementInput = z.object({
  expectedVersion: z.string().min(1).max(128), opportunityId: growthOpportunityId,
  metric: z.enum(reviewMetrics), startDate: analyticsDate,
}).strict();
export const decideMeasurementInput = z.object({
  expectedVersion: z.string().min(1).max(128), decision: z.enum(["continue", "revise", "stop"]),
  note: z.string().trim().min(3).max(500),
}).strict();

export const reviewSourceNames = (data: AnalyticsData) => [...new Set(data.sources.map((source) => source.name))].slice(0, 12);

export function salesPeriod(days: DailySales[], start: string) {
  const end = nextDate(start, 6);
  const dates = new Set(Array.from({ length: 7 }, (_, index) => nextDate(start, index)));
  const selected = days.filter((day) => dates.has(day.date));
  const complete = selected.length === 7 && new Set(selected.map((day) => day.date)).size === 7;
  const metrics = complete ? salesMetrics(selected) : null;
  return {
    start, end, observedDates: new Set(selected.map((day) => day.date)).size,
    values: metrics ? { net: metrics.net, orders: metrics.orders, aov: metrics.aov } : null,
  };
}

export function weeklyReport(data: AnalyticsData, asOf = new Date().toISOString().slice(0, 10)): WeeklyReport {
  analyticsDate.parse(asOf);
  const weekday = new Date(`${asOf}T00:00:00Z`).getUTCDay();
  const currentMonday = nextDate(asOf, -((weekday + 6) % 7));
  const previous = salesPeriod(data.days, nextDate(currentMonday, -14));
  const current = salesPeriod(data.days, nextDate(currentMonday, -7));
  return {
    asOf, currency: data.currency, previous, current,
    changes: reviewMetrics.flatMap((metric) => {
      const before = previous.values?.[metric], after = current.values?.[metric];
      if (before === undefined || before === null || after === undefined || after === null) return [];
      const percent = percentageChange(after, before);
      return [{ metric, before, after, percent, attention: percent === null ? after !== before : Math.abs(percent) >= 10 }];
    }),
    hasEstimates: data.sources.some((source) => source.kind === "estimate"),
    warnings: data.warnings, sourceNames: reviewSourceNames(data),
  };
}

export function measurementProgress(measurement: ActionMeasurement, data: AnalyticsData, asOf = new Date().toISOString().slice(0, 10)): WeeklyReviewState["measurements"][number] {
  const period = salesPeriod(data.days, measurement.startDate);
  const value = data.currency === measurement.currency ? period.values?.[measurement.metric] ?? null : null;
  const baseline = measurement.baseline.period.values?.[measurement.metric] ?? null;
  const outcome = measurement.outcome;
  const stopped = !!measurement.decision && !outcome;
  return {
    measurement,
    status: stopped ? "stopped" : measurement.decision ? "reviewed" : asOf < measurement.reviewDate ? "waiting" : value === null ? "needs_data" : "ready",
    observedDates: outcome ? 7 : period.observedDates,
    value: stopped ? null : outcome?.value ?? value,
    percent: stopped ? null : outcome ? outcome.percent : value === null || baseline === null ? null : percentageChange(value, baseline),
    hasEstimates: outcome?.hasEstimates ?? data.sources.some((source) => source.kind === "estimate"),
    warnings: outcome?.warnings ?? data.warnings,
  };
}
