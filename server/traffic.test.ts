import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "./database.js";
import { createApp } from "./app.js";
import { newSession } from "./auth.js";
import { readTrafficFile } from "./traffic-imports.js";
import { readSalesFile, salesFileHash } from "./sales-imports.js";
import { trafficMetrics } from "../shared/traffic.js";
import { salesMetrics } from "../shared/analytics-math.js";

const origin = "http://127.0.0.1:5173";
const trafficCsv = readFileSync(new URL("../test-data/google-analytics/daily-traffic.csv", import.meta.url));
const salesCsv = readFileSync(new URL("../test-data/google-analytics/purchase-items.csv", import.meta.url));
describe("traffic CSV validation and formulas", () => {
  it("uses the supplied real report, preserves 92 dates and calculates weighted session conversion", () => {
    const snapshot = readTrafficFile(trafficCsv);
    expect(snapshot.days).toHaveLength(92);
    expect(snapshot.days[0].date).toBe("2020-11-01");
    expect(snapshot.days.at(-1)!.date).toBe("2021-01-31");
    const metrics = trafficMetrics(snapshot.days);
    expect(metrics).toMatchObject({ sessions: 360974, purchasingSessions: 4851, eventCount: 4295584, missingSessionEvents: 0 });
    expect(metrics.conversion).toBeCloseTo(1.3438641);
    expect(metrics).not.toHaveProperty("userCount");
    expect(trafficMetrics([
      { ...snapshot.days[0], sessions: 100, purchasingSessions: 10 },
      { ...snapshot.days[1], sessions: 900, purchasingSessions: 0 },
    ]).conversion).toBe(1);
    expect(trafficMetrics([{ ...snapshot.days[0], sessions: 0, purchasingSessions: 0 }]).conversion).toBeNull();
  });
  it.each([
    ["date,sessions,purchasing_sessions\n2020-01-01,10,11", "cannot exceed"],
    ["date,sessions,purchasing_sessions\n2020-01-01,-1,0", "nonnegative integer"],
    ["date,sessions,purchasing_sessions\n2020-01-01,1.5,0", "nonnegative integer"],
    ["date,sessions,purchasing_sessions\n2020-01-01,,0", "nonnegative integer"],
    ["date,sessions,purchasing_sessions\n2020-01-01,10,0\n2020-01-01,20,1", "Each date"],
    ["date,sessions,purchasing_sessions\n2099-01-01,10,0", "historical date"],
    ["date,sessions,purchasing_sessions\n2020-02-31,10,0", "Invalid ISO date"],
    ["date,sessions,purchasing_sessions,event_count,events_without_session_key\n2020-01-01,10,1,1,2", "cannot exceed"],
    ["order_id,date,quantity,unit_price\nA,2020-01-01,1,10", "Sales files"],
  ])("rejects malformed or contradictory traffic rows", (csv, message) => {
    expect(() => readTrafficFile(Buffer.from(csv))).toThrow(message);
  });
});
describe("traffic imports through real owner-scoped HTTP routes", () => {
  const resources: { store: ReturnType<typeof openStore>; directory: string }[] = [];
  afterEach(async () => {
    for (const { store, directory } of resources.splice(0)) { await store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  async function setup() {
    const directory = mkdtempSync(join(tmpdir(), "growthpulse-traffic-"));
    const path = join(directory, "test.sqlite");
    const store = openStore(path); resources.push({ store, directory });
    const user = { id: randomUUID(), name: "Traffic test owner", email: `${randomUUID()}@example.test` };
    const session = newSession();
    await store.createAccount(user, "unused", session.tokenHash, session.expiresAt);
    const business = (await store.saveBusiness(user.id, { name: "GA public sample", category: "", description: "", website: "" }))!;
    return { store, path, user, business, cookie: `gp_session=${session.token}`, app: createApp({ store }) };
  }
  it("previews and persists both exact fixtures without turning missing sales dates into zeros or purchases into orders", async () => {
    const { store, path, user, business, cookie, app } = await setup();
    const prefix = `/api/businesses/${business.id}`;
    const sales = await readSalesFile(salesCsv, "csv", "USD");
    const initial = await store.salesData(user.id, business.id);
    const saleDraft = await store.previewSales(user.id, business.id, "purchase-items.csv", salesFileHash(salesCsv), sales);
    const original = await store.commitSales(user.id, business.id, saleDraft.id, initial.version, true);
    const response = await request(app).post(`${prefix}/traffic-imports?filename=daily-traffic.csv&sourceName=Google%20Merchandise%20Store%20sample`)
      .set("Origin", origin).set("Cookie", cookie).set("Content-Type", "text/csv").send(trafficCsv.toString()).expect(201);
    expect((await store.salesData(user.id, business.id)).traffic).toBeNull();
    const draftId: string = response.body.draft.id;
    await request(app).post(`${prefix}/traffic-imports/${draftId}/commit`).set("Origin", origin).set("Cookie", cookie).send({ expectedVersion: original.version, sameBusiness: false }).expect(400);
    const result = await request(app).post(`${prefix}/traffic-imports/${draftId}/commit`).set("Origin", origin).set("Cookie", cookie).send({ expectedVersion: original.version, sameBusiness: true }).expect(200);
    expect(result.body.analytics.days).toEqual(original.days);
    expect(result.body.analytics.days).toHaveLength(81);
    expect(result.body.analytics.traffic.snapshot.days).toHaveLength(92);
    expect(salesMetrics(result.body.analytics.days)).toMatchObject({ orders: 4451, net: 3077740000 });
    expect(trafficMetrics(result.body.analytics.traffic.snapshot.days).purchasingSessions).toBe(4851);
    const retry = await request(app).post(`${prefix}/traffic-imports/${draftId}/commit`).set("Origin", origin).set("Cookie", cookie).send({ expectedVersion: original.version, sameBusiness: true }).expect(200);
    expect(retry.body.analytics.version).toBe(result.body.analytics.version);
    const simulated = await store.saveSalesScenario(user.id, business.id, {
      name: "Separate owner assumption", start: "2020-11-11", end: "2021-01-30", ordersPct: 100, aovPct: 0, costPct: 0,
    }, result.body.analytics.version);
    const reopened = openStore(path);
    try {
      const saved = await reopened.salesData(user.id, business.id);
      expect(saved.traffic?.snapshot.days).toHaveLength(92);
      expect(saved.days).toEqual(original.days);
      expect(saved.scenarios).toEqual(simulated.scenarios);
    }
    finally { await reopened.close(); }
  });
  it("accepts traffic first without inventing revenue, then pairs the sales sample", async () => {
    const { store, user, business } = await setup();
    const initial = await store.salesData(user.id, business.id);
    const draft = await store.previewTraffic(user.id, business.id, "daily-traffic.csv", "GA sample", salesFileHash(trafficCsv), readTrafficFile(trafficCsv));
    const trafficOnly = await store.commitTraffic(user.id, business.id, draft.id, initial.version, true);
    expect(trafficOnly.days).toEqual([]);
    expect(trafficOnly.currency).toBeNull();
    const snapshot = await readSalesFile(salesCsv, "csv", "USD");
    const sales = await store.previewSales(user.id, business.id, "purchase-items.csv", salesFileHash(salesCsv), snapshot);
    const combined = await store.commitSales(user.id, business.id, sales.id, trafficOnly.version, true);
    expect(combined.currency).toBe("USD");
    expect(combined.traffic?.snapshot.days).toHaveLength(92);
  });
  it("rejects stale reviews, unrelated dates and conflicting owner traffic without replacing records", async () => {
    const { store, user, business } = await setup();
    const empty = await store.salesData(user.id, business.id);
    const traffic = await store.previewTraffic(user.id, business.id, "daily-traffic.csv", "GA sample", salesFileHash(trafficCsv), readTrafficFile(trafficCsv));
    const entry = { currency: "GBP", evidence: "Synthetic unrelated owner log", estimated: false, day: {
      date: "2011-01-01", gross: 0, discounts: 0, reversals: 0, orders: 0, units: 0,
      cogs: null, operatingExpenses: null, sessions: null, purchasingSessions: null,
    } };
    const actual = await store.saveManualSales(user.id, business.id, entry, empty.version);
    await expect(store.commitTraffic(user.id, business.id, traffic.id, empty.version, true)).rejects.toThrow("History changed");
    await expect(store.commitTraffic(user.id, business.id, traffic.id, actual.version, true)).rejects.toThrow("no overlapping dates");
    expect((await store.salesData(user.id, business.id)).traffic).toBeNull();
    const other = (await store.saveBusiness(user.id, { name: "Conflicting traffic", category: "", description: "", website: "" }))!;
    const owner = await store.saveManualSales(user.id, other.id, { ...entry, day: { ...entry.day, date: "2020-11-01", sessions: 1, purchasingSessions: 0 } }, (await store.salesData(user.id, other.id)).version);
    const draft = await store.previewTraffic(user.id, other.id, "daily-traffic.csv", "GA sample", salesFileHash(trafficCsv), readTrafficFile(trafficCsv));
    await expect(store.commitTraffic(user.id, other.id, draft.id, owner.version, true)).rejects.toThrow("conflicts");
  });
  it("enforces authentication, business/draft ownership, origin and upload limits", async () => {
    const first = await setup(), other = await setup();
    const draft = await first.store.previewTraffic(first.user.id, first.business.id, "daily-traffic.csv", "GA sample", salesFileHash(trafficCsv), readTrafficFile(trafficCsv));
    const otherUser = { id: randomUUID(), name: "Other owner", email: "other@example.test" };
    const otherSession = newSession(); await first.store.createAccount(otherUser, "unused", otherSession.tokenHash, otherSession.expiresAt);
    const otherBusiness = (await first.store.saveBusiness(otherUser.id, { name: "Other business", category: "", description: "", website: "" }))!;
    const prefix = `/api/businesses/${first.business.id}`;
    await request(first.app).post(`${prefix}/traffic-imports?filename=test.csv&sourceName=Test`).set("Origin", origin).set("Content-Type", "text/csv").send("x").expect(401);
    await request(first.app).post(`${prefix}/traffic-imports/${draft.id}/commit`).set("Cookie", first.cookie).send({}).expect(403);
    await request(first.app).post(`${prefix}/traffic-imports/${draft.id}/commit`).set("Origin", origin).set("Cookie", `gp_session=${otherSession.token}`).send({}).expect(404);
    await request(first.app).post(`/api/businesses/${otherBusiness.id}/traffic-imports/${draft.id}/commit`).set("Origin", origin).set("Cookie", `gp_session=${otherSession.token}`).send({ expectedVersion: (await first.store.salesData(otherUser.id, otherBusiness.id)).version, sameBusiness: true }).expect(404);
    await request(other.app).post(`/api/businesses/${other.business.id}/traffic-imports?filename=test.csv&sourceName=Test`).set("Origin", origin).set("Cookie", other.cookie).set("Content-Type", "text/csv").send("x".repeat(1024 * 1024 + 1)).expect(413);
  });
});
