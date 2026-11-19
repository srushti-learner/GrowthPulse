import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsDataSchema, moneyScale as M, type DailySales, type SalesSnapshot } from "../shared/analytics.js";
import { nextDate } from "../shared/analytics-math.js";
import { weeklyReport } from "../shared/weekly-review.js";
import type { GrowthOpportunity } from "../shared/growth.js";
import { openStore } from "./database.js";
import { createApp } from "./app.js";
import { newSession } from "./auth.js";
import { salesObservationVersion } from "./weekly-review-store.js";

const today = "2026-11-19";
const date = "2026-11-02";
const day = (date: string, gross = 100 * M): DailySales => ({
  date, gross, discounts: 0, reversals: 0, orders: gross ? 2 : 0, units: gross ? 2 : 0,
  cogs: null, operatingExpenses: null, sessions: null, purchasingSessions: null,
});
const history = (count = 14) => Array.from({ length: count }, (_, index) => day(nextDate(date, index), (index < 7 ? 100 : 110) * M));
const snapshot = (days = history()): SalesSnapshot => ({
  currency: "GBP", days, products: [], accepted: days.length, rejected: 0, excluded: 0, errors: [], warnings: [],
});
const data = (days = history()) => analyticsDataSchema.parse({
  version: "fixture", currency: "GBP", days, products: [], sources: [], imports: [], scenarios: [], warnings: [],
});
const opportunity: GrowthOpportunity = {
  id: "a".repeat(64), title: "Clarify the product page", detail: "Review product information.", agents: ["growth"],
  sources: [{ id: "e_1111111111111111", url: "https://shop.example.com/", quote: "Product details.", capturedAt: `${today}T12:00:00.000Z` }],
  reviewReason: "Owner must verify.", strategy: {
    objective: "Clarify details.", actions: ["Review page."], metric: "Orders",
    hypothesis: "Check whether clearer details help.", measurement: "Compare supplied records.",
  },
};

describe("complete-week business comparisons", () => {
  it("uses the last two completed Monday-Sunday weeks and the exact 10% attention boundary", () => {
    const report = weeklyReport(data([...history(), day("2026-11-19", 999 * M)]), today);
    expect(report.current).toMatchObject({ start: "2026-11-09", end: "2026-11-15", observedDates: 7 });
    expect(report.previous).toMatchObject({ start: date, end: "2026-11-08" });
    expect(report.changes.find((item) => item.metric === "net")).toMatchObject({ percent: 10, attention: true, before: 700 * M, after: 770 * M });
    const below = weeklyReport(data(history().map((entry, index) => index < 7 ? entry : { ...entry, gross: 109 * M })), today);
    expect(below.changes.find((item) => item.metric === "net")).toMatchObject({ percent: 9, attention: false });
    expect(weeklyReport(data(), "2026-11-16").current.end).toBe("2026-11-15");
    expect(weeklyReport(data(), "2026-11-15").current.end).toBe("2026-11-08");
  });
  it("does not turn a missing date, repeated date, zero denominator or unrecorded AOV into a growth claim", () => {
    const incomplete = weeklyReport(data(history().slice(1)), today);
    expect(incomplete.previous.values).toBeNull();
    expect(incomplete.changes).toEqual([]);
    const duplicate = weeklyReport(data([history()[0], ...history().slice(0, 13)]), today);
    expect(duplicate.previous.values).toBeNull();
    const zero = weeklyReport(data(history().map((entry, index) => index < 7 ? day(entry.date, 0) : entry)), today);
    expect(zero.changes.find((item) => item.metric === "net")).toMatchObject({ percent: null, attention: true });
    expect(zero.changes.some((item) => item.metric === "aov")).toBe(false);
    const refund = weeklyReport(data(history().map((entry, index) => index < 7 ? { ...entry, reversals: 200 * M } : entry)), today);
    expect(refund.changes.find((item) => item.metric === "net")?.percent).toBeNull();
  });
  it("does not let traffic, scenarios or a renamed identical export create a new sales observation identity", () => {
    const initial = data();
    expect(salesObservationVersion({ ...initial, version: "traffic-only-change", sources: [{ name: "renamed.csv", kind: "import", createdAt: `${today}T12:00:00.000Z` }] }))
      .toBe(salesObservationVersion(initial));
    expect(salesObservationVersion({ ...initial, warnings: ["Rejected rows acknowledged."] })).not.toBe(salesObservationVersion(initial));
    expect(weeklyReport({ ...initial, sources: [{ name: "Owner estimate", kind: "estimate", createdAt: `${today}T12:00:00.000Z` }] }, today).hasEstimates).toBe(true);
  });
});

describe("durable owner-scoped weekly review pilot", () => {
  const stores: ReturnType<typeof openStore>[] = [];
  const directories: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${today}T12:00:00.000Z`));
  });
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
    vi.useRealTimers();
  });
  async function setup(path = ":memory:") {
    const store = openStore(path); stores.push(store);
    const user = { id: randomUUID(), name: "Synthetic owner", email: `${randomUUID()}@example.test` };
    const session = newSession();
    await store.createAccount(user, "unused", session.tokenHash, session.expiresAt);
    const business = (await store.saveBusiness(user.id, { name: "Synthetic shop", category: "", description: "", website: "" }))!;
    const upload = async (input = snapshot(), filename = `${randomUUID()}.csv`) => {
      const current = await store.salesData(user.id, business.id);
      const draft = await store.previewSales(user.id, business.id, filename, randomUUID(), input);
      await store.commitSales(user.id, business.id, draft.id, current.version, true);
      return draft;
    };
    return { store, user, business, session, upload };
  }
  it("saves accepted observations only, deduplicates reports, rejects stale saves and preserves a corrected report across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gp-weekly-review-")); directories.push(directory);
    const path = join(directory, "fixture.sqlite");
    const { store, user, business, upload } = await setup(path);
    await store.previewSales(user.id, business.id, "preview.csv", "preview", snapshot());
    expect((await store.weeklyReview(user.id, business.id)).observationCount).toBe(0);
    const draft = await upload();
    let review = await store.weeklyReview(user.id, business.id);
    expect(review.observationCount).toBe(1);
    expect(review.reviews).toEqual([]);
    review = await store.saveWeeklyReview(user.id, business.id, { expectedVersion: review.version, periodEnd: review.current.current.end });
    const original = review.reviews[0];
    expect((await store.saveWeeklyReview(user.id, business.id, { expectedVersion: review.version, periodEnd: review.current.current.end })).reviews).toEqual([original]);
    await store.commitSales(user.id, business.id, draft.id, "old-version", true);
    await upload(snapshot(), "renamed-identical.csv");
    expect((await store.weeklyReview(user.id, business.id)).observationCount).toBe(1);
    await upload(snapshot(history().map((entry) => ({ ...entry, gross: entry.gross * 2 }))));
    await expect(store.saveWeeklyReview(user.id, business.id, { expectedVersion: review.version, periodEnd: review.current.current.end })).rejects.toThrow("Sales history changed");
    const corrected = await store.weeklyReview(user.id, business.id);
    expect(corrected.observationCount).toBe(2);
    expect(corrected.reviews).toEqual([original]);
    expect(corrected.current.current.values!.net).toBe(1540 * M);
    await store.close();
    const reopened = openStore(path); stores.push(reopened);
    expect((await reopened.weeklyReview(user.id, business.id)).reviews).toEqual([original]);
    expect((await reopened.weeklyReview(user.id, business.id)).observationCount).toBe(2);
  });
  it("keeps a frozen action baseline while a replacement export supplies outcomes, then freezes the owner decision", async () => {
    const { store, user, business, upload } = await setup();
    await upload(snapshot(history(7)));
    await store.addGrowthPlan(user.id, business.id, opportunity);
    let review = await store.weeklyReview(user.id, business.id);
    review = await store.startActionMeasurement(user.id, business.id, {
      expectedVersion: review.version, opportunityId: opportunity.id, metric: "net", startDate: "2026-11-09",
    });
    const measurement = review.measurements[0].measurement;
    expect(measurement.baseline.period.values!.net).toBe(700 * M);
    expect(measurement.reviewDate).toBe("2026-11-16");
    expect(review.measurements[0].status).toBe("needs_data");
    await expect(store.startActionMeasurement(user.id, business.id, {
      expectedVersion: review.version, opportunityId: opportunity.id, metric: "orders", startDate: "2026-11-09",
    })).rejects.toThrow("already has an open");
    await upload(snapshot(history().slice(7)));
    review = await store.weeklyReview(user.id, business.id);
    expect(review.current.changes).toEqual([]);
    expect(review.measurements[0]).toMatchObject({ status: "ready", value: 770 * M, percent: 10 });
    await expect(store.decideActionMeasurement(user.id, business.id, measurement.id, {
      expectedVersion: "stale", decision: "continue", note: "Check another period.",
    })).rejects.toThrow("Sales history changed");
    review = await store.decideActionMeasurement(user.id, business.id, measurement.id, {
      expectedVersion: review.version, decision: "revise", note: "Other campaigns ran too; clarify the next test.",
    });
    const saved = review.measurements[0];
    expect(saved).toMatchObject({ status: "reviewed", measurement: { decision: "revise", outcome: { value: 770 * M } } });
    expect((await store.listGrowthPlan(user.id, business.id))[0].status).toBe("planned");
    await upload(snapshot(history().slice(7).map((entry) => ({ ...entry, gross: 10 * M }))));
    expect((await store.weeklyReview(user.id, business.id)).measurements[0]).toEqual(saved);
    await expect(store.decideActionMeasurement(user.id, business.id, measurement.id, {
      expectedVersion: (await store.weeklyReview(user.id, business.id)).version, decision: "stop", note: "Rewrite.",
    })).rejects.toThrow("already recorded");
  });
  it("records manual estimates, distinguishes freshness from update time, and declines incomplete or premature measurements", async () => {
    const { store, user, business, upload } = await setup();
    let review = await store.weeklyReview(user.id, business.id);
    await expect(store.saveWeeklyReview(user.id, business.id, { expectedVersion: review.version, periodEnd: review.current.current.end })).rejects.toThrow("all 14 dates");
    await upload(snapshot(history(7)));
    await store.addGrowthPlan(user.id, business.id, opportunity);
    review = await store.weeklyReview(user.id, business.id);
    await expect(store.startActionMeasurement(user.id, business.id, {
      expectedVersion: review.version, opportunityId: opportunity.id, metric: "net", startDate: "2026-11-10",
    })).rejects.toThrow("seven recorded dates");
    const actuals = await store.salesData(user.id, business.id);
    await store.saveManualSales(user.id, business.id, {
      currency: "GBP", day: day("2026-11-01", 0), evidence: "Synthetic till estimate", estimated: true,
    }, actuals.version);
    review = await store.weeklyReview(user.id, business.id);
    expect(review.current.hasEstimates).toBe(true);
    expect(review.observationCount).toBe(2);
    expect(review.stale).toBe(true);
    expect(review.observedAt).toBe(`${today}T12:00:00.000Z`);
    review = await store.startActionMeasurement(user.id, business.id, {
      expectedVersion: review.version, opportunityId: opportunity.id, metric: "net", startDate: "2026-11-09",
    });
    vi.setSystemTime(new Date("2026-11-12T12:00:00.000Z"));
    expect((await store.weeklyReview(user.id, business.id)).measurements[0].status).toBe("waiting");
    await expect(store.decideActionMeasurement(user.id, business.id, review.measurements[0].measurement.id, {
      expectedVersion: review.version, decision: "continue", note: "Too early.",
    })).rejects.toThrow("Wait until");
    const stopped = await store.decideActionMeasurement(user.id, business.id, review.measurements[0].measurement.id, {
      expectedVersion: review.version, decision: "stop", note: "Unable to keep this experiment running.",
    });
    expect(stopped.measurements[0]).toMatchObject({ status: "stopped", value: null, percent: null, measurement: { outcome: null, decision: "stop" } });
    const followup = await store.startActionMeasurement(user.id, business.id, {
      expectedVersion: review.version, opportunityId: opportunity.id, metric: "orders", startDate: "2026-11-09",
    });
    expect(followup.measurements).toHaveLength(2);
    expect(followup.measurements.find((entry) => !entry.measurement.decision)?.status).toBe("waiting");
  });
  it("keeps all new endpoints authenticated, same-origin and isolated to the business owner", async () => {
    const { store, user, business, session, upload } = await setup();
    await upload();
    const app = createApp({ store, origin: "http://localhost:5173" });
    const endpoint = `/api/businesses/${business.id}/weekly-review`;
    const cookie = `gp_session=${session.token}`;
    expect((await request(app).get(endpoint)).status).toBe(401);
    const owner = await request(app).get(endpoint).set("Cookie", cookie);
    expect(owner.status).toBe(200);
    const payload = { expectedVersion: owner.body.version, periodEnd: owner.body.current.current.end };
    expect((await request(app).post(endpoint).set("Cookie", cookie).send(payload)).status).toBe(403);
    expect((await request(app).post(endpoint).set("Cookie", cookie).set("Origin", "http://localhost:5173").send(payload)).status).toBe(201);
    const other = { id: randomUUID(), name: "Second owner", email: `${randomUUID()}@example.test` };
    const second = newSession();
    await store.createAccount(other, "unused", second.tokenHash, second.expiresAt);
    const foreign = `gp_session=${second.token}`;
    expect((await request(app).get(endpoint).set("Cookie", foreign)).status).toBe(404);
    expect((await request(app).post(endpoint).set("Cookie", foreign).set("Origin", "http://localhost:5173").send(payload)).status).toBe(404);
    await expect(store.weeklyReview(other.id, business.id)).rejects.toMatchObject({ status: 404 });
    await expect(store.startActionMeasurement(other.id, business.id, {
      expectedVersion: owner.body.version, opportunityId: opportunity.id, startDate: "2026-11-09", metric: "net",
    })).rejects.toMatchObject({ status: 404 });
    await expect(store.decideActionMeasurement(other.id, business.id, randomUUID(), {
      expectedVersion: owner.body.version, decision: "stop", note: "Foreign owner.",
    })).rejects.toMatchObject({ status: 404 });
    expect((await store.weeklyReview(user.id, business.id)).reviews).toHaveLength(1);
  });
});
