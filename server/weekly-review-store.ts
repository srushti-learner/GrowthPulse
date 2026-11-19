import { createHash, randomUUID } from "node:crypto";
import type { AnalyticsData } from "../shared/analytics.js";
import { nextDate, percentageChange } from "../shared/analytics-math.js";
import {
  actionMeasurementSchema, decideMeasurementInput, measurementProgress, salesPeriod,
  reviewSourceNames, savedWeeklyReviewSchema, saveWeeklyReviewInput, startMeasurementInput, weeklyReport, weeklyReviewResponseSchema,
  type ActionMeasurement,
} from "../shared/weekly-review.js";
import { growthOpportunitySchema } from "../shared/growth.js";
import { SalesError } from "./sales-imports.js";
import type { SqlDatabase } from "./sql-database.js";

export function salesObservationVersion(data: AnalyticsData) {
  return createHash("sha256").update(JSON.stringify({
    currency: data.currency, days: data.days,
    hasEstimates: data.sources.some((source) => source.kind === "estimate"), warnings: data.warnings,
  })).digest("hex").slice(0, 24);
}

export async function recordSalesObservation(database: SqlDatabase, businessId: string, data: AnalyticsData) {
  if (!data.days.length) return;
  await database.prepare(`INSERT INTO sales_observations (business_id,version,captured_at,snapshot_json) VALUES (?,?,?,?)
    ${database.dialect === "mysql" ? "ON DUPLICATE KEY UPDATE version=VALUES(version)" : "ON CONFLICT(business_id,version) DO NOTHING"}`)
    .run(businessId, salesObservationVersion(data), new Date().toISOString(), JSON.stringify({
      currency: data.currency, days: data.days, sources: data.sources, warnings: data.warnings,
    }));
}

export function weeklyReviewStore(database: SqlDatabase, salesData: (ownerId: string, businessId: string) => Promise<AnalyticsData>) {
  async function current(ownerId: string, businessId: string, expectedVersion?: string) {
    const raw = await salesData(ownerId, businessId);
    const data = { ...raw, version: salesObservationVersion(raw) };
    if (expectedVersion !== undefined && expectedVersion !== data.version) {
      throw new SalesError(409, "Sales history changed. Reload the weekly review before saving.");
    }
    return data;
  }
  async function measurements(businessId: string) {
    return (await database.prepare<[string], { json: string }>(
      "SELECT measurement_json AS json FROM action_measurements WHERE business_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
    ).all(businessId)).map((row) => actionMeasurementSchema.parse(JSON.parse(row.json)));
  }
  async function state(ownerId: string, businessId: string) {
    return database.transaction(async () => {
      const data = await current(ownerId, businessId);
      const captured = await database.prepare<[string, string], { capturedAt: string }>(
        "SELECT captured_at AS capturedAt FROM sales_observations WHERE business_id=? AND version=?",
      ).get(businessId, data.version);
      const count = await database.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM sales_observations WHERE business_id=?").get(businessId);
      const coveredThrough = data.days.at(-1)?.date ?? null;
      const today = new Date().toISOString().slice(0, 10);
      return weeklyReviewResponseSchema.parse({
        version: data.version,
        observedAt: captured?.capturedAt ?? data.sources.map((source) => source.createdAt).sort().at(-1) ?? null,
        coveredThrough, stale: !coveredThrough || coveredThrough < nextDate(today, -7),
        observationCount: count?.count ?? 0, current: weeklyReport(data, today),
        reviews: (await database.prepare<[string], { json: string }>(
          "SELECT review_json AS json FROM weekly_reviews WHERE business_id=? ORDER BY created_at DESC,rowid DESC LIMIT 12",
        ).all(businessId)).map((row) => savedWeeklyReviewSchema.parse(JSON.parse(row.json))),
        measurements: (await measurements(businessId)).map((measurement) => measurementProgress(measurement, data, today)),
      });
    })();
  }
  return {
    weeklyReview: state,
    async saveWeeklyReview(ownerId: string, businessId: string, input: unknown) {
      const parsed = saveWeeklyReviewInput.parse(input);
      return database.transaction(async () => {
        const data = await current(ownerId, businessId, parsed.expectedVersion);
        const report = weeklyReport(data);
        if (report.current.end !== parsed.periodEnd) throw new SalesError(409, "The reporting week changed. Reload before saving.");
        if (!report.previous.values || !report.current.values) throw new SalesError(400, "Record all 14 dates in the two complete reporting weeks before saving a weekly review. Missing dates are unknown, not zero.");
        const saved = savedWeeklyReviewSchema.parse({ id: randomUUID(), version: data.version, createdAt: new Date().toISOString(), report });
        await recordSalesObservation(database, businessId, data);
        await database.prepare(`INSERT INTO weekly_reviews (id,business_id,version,period_end,created_at,review_json) VALUES (?,?,?,?,?,?)
          ${database.dialect === "mysql" ? "ON DUPLICATE KEY UPDATE version=VALUES(version)" : "ON CONFLICT(business_id,version,period_end) DO NOTHING"}`)
          .run(saved.id, businessId, data.version, report.current.end, saved.createdAt, JSON.stringify(saved));
        return state(ownerId, businessId);
      })();
    },
    async startActionMeasurement(ownerId: string, businessId: string, input: unknown) {
      const parsed = startMeasurementInput.parse(input);
      return database.transaction(async () => {
        const data = await current(ownerId, businessId, parsed.expectedVersion);
        const today = new Date().toISOString().slice(0, 10);
        if (parsed.startDate > today || parsed.startDate < nextDate(today, -365)) {
          throw new SalesError(400, "Choose an action start date within the past year, not a future date.");
        }
        const plan = await database.prepare<[string, string], { opportunity: string; status: string }>(
          "SELECT opportunity_json AS opportunity,status FROM growth_plan WHERE business_id=? AND opportunity_id=?",
        ).get(businessId, parsed.opportunityId);
        if (!plan || plan.status === "dismissed") throw new SalesError(404, "Choose a saved, non-dismissed growth action.");
        const opportunity = growthOpportunitySchema.parse(JSON.parse(plan.opportunity));
        const active = await database.prepare("SELECT id FROM action_measurements WHERE business_id=? AND opportunity_id=? AND decided_at IS NULL")
          .get(businessId, opportunity.id);
        if (active) throw new SalesError(409, "This action already has an open outcome review. Finish it before starting a follow-up.");
        const count = await database.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM action_measurements WHERE business_id=?").get(businessId);
        if ((count?.count ?? 0) >= 100) throw new SalesError(400, "This pilot supports up to 100 action outcome reviews per business.");
        const baseline = salesPeriod(data.days, nextDate(parsed.startDate, -7));
        if (!data.currency || baseline.values?.[parsed.metric] === undefined || baseline.values[parsed.metric] === null) {
          throw new SalesError(400, "The baseline needs seven recorded dates immediately before the action starts and a measurable value. Record zero-sales days explicitly; AOV needs orders.");
        }
        const measurement = actionMeasurementSchema.parse({
          id: randomUUID(), opportunityId: opportunity.id, title: opportunity.title, metric: parsed.metric, currency: data.currency,
          startDate: parsed.startDate, reviewDate: nextDate(parsed.startDate, 7), createdAt: new Date().toISOString(),
          baseline: { version: data.version, period: baseline, hasEstimates: data.sources.some((source) => source.kind === "estimate"), warnings: data.warnings, sourceNames: reviewSourceNames(data) },
          outcome: null, decision: null, note: "", decidedAt: null,
        });
        await recordSalesObservation(database, businessId, data);
        await database.prepare("INSERT INTO action_measurements (id,business_id,opportunity_id,created_at,decided_at,measurement_json) VALUES (?,?,?,?,NULL,?)")
          .run(measurement.id, businessId, opportunity.id, measurement.createdAt, JSON.stringify(measurement));
        return state(ownerId, businessId);
      })();
    },
    async decideActionMeasurement(ownerId: string, businessId: string, id: string, input: unknown) {
      const parsed = decideMeasurementInput.parse(input);
      return database.transaction(async () => {
        const data = await current(ownerId, businessId, parsed.expectedVersion);
        const row = await database.prepare<[string, string], { json: string }>(
          "SELECT measurement_json AS json FROM action_measurements WHERE business_id=? AND id=?",
        ).get(businessId, id);
        if (!row) throw new SalesError(404, "Action outcome review not found.");
        const measurement = actionMeasurementSchema.parse(JSON.parse(row.json));
        if (measurement.decision) throw new SalesError(409, "This review is already recorded. Reload to see the saved decision.");
        const progress = measurementProgress(measurement, data);
        const measurable = progress.status === "ready" && progress.value !== null;
        if (!measurable && parsed.decision !== "stop") {
          throw new SalesError(400, "Wait until the review date and supply all seven outcome dates before recording a decision.");
        }
        const now = new Date().toISOString();
        const baseline = measurement.baseline.period.values![measurement.metric]!;
        const saved: ActionMeasurement = {
          ...measurement, decision: parsed.decision, note: parsed.note, decidedAt: now,
          outcome: measurable && progress.value !== null ? {
            version: data.version, recordedAt: now, value: progress.value, percent: percentageChange(progress.value, baseline),
            hasEstimates: progress.hasEstimates, warnings: progress.warnings, sourceNames: reviewSourceNames(data),
          } : null,
        };
        await recordSalesObservation(database, businessId, data);
        await database.prepare("UPDATE action_measurements SET measurement_json=?,decided_at=? WHERE business_id=? AND id=? AND decided_at IS NULL")
          .run(JSON.stringify(actionMeasurementSchema.parse(saved)), now, businessId, id);
        return state(ownerId, businessId);
      })();
    },
  };
}
