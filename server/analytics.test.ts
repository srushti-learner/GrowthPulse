import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { openStore } from "./database.js";
import { createApp } from "./app.js";
import { readSalesFile, salesFileHash } from "./sales-imports.js";
import { forecastSales, nextDate, percentageChange, salesMetrics, scenarioDays } from "../shared/analytics-math.js";
import { moneyScale as M, type DailySales } from "../shared/analytics.js";
import { newSession } from "./auth.js";

const day = (date: string, gross = 100 * M): DailySales => ({
  date, gross, discounts: 10 * M, reversals: 5 * M, orders: 2, units: 3,
  cogs: null, operatingExpenses: null, sessions: null, purchasingSessions: null,
});
const csv = Buffer.from("order_id,date,sku,product,quantity,unit_price,discount,status\nA1,2025-01-01,T1,Tee,2,10.125,1,paid\nA1,2025-01-01,T2,Shirt,1,20,0,paid\nC1,2025-01-02,T1,Tee,-1,10.125,0,returned\nA2,2025-01-02,T2,Shirt,1,-2,0,paid");
describe("published sales formulas and scenario isolation", () => {
  it("uses booked AOV, separately records reversals and requires complete cost/traffic coverage", () => {
    const first = day("2025-01-01");
    const metrics = salesMetrics([first]);
    expect(metrics).toMatchObject({ net: 85 * M, aov: 45 * M, orders: 2, grossProfit: null, conversion: null });
    expect(salesMetrics([{ ...first, cogs: 40 * M, operatingExpenses: 10 * M, sessions: 100, purchasingSessions: 2 }])).toMatchObject({ grossProfit: 45 * M, operatingProfit: 35 * M, conversion: 2 });
    expect(salesMetrics([first, { ...first, date: "2025-01-02", cogs: 0 }]).grossProfit).toBeNull();
    expect(percentageChange(10, 0)).toBeNull();
    expect(percentageChange(120, 100)).toBe(20);
  });
  it("changes a selected historical copy, keeps fixed expenses and does not invent converted sessions", () => {
    const original = [{ ...day("2025-01-01"), cogs: 20 * M, operatingExpenses: 5 * M, sessions: 10, purchasingSessions: 2 }, day("2025-01-02")];
    const scenario = scenarioDays(original, { name: "Scenario", start: "2025-01-01", end: "2025-01-01", ordersPct: 100, aovPct: 10, costPct: 20 });
    expect(scenario[0]).toMatchObject({ gross: 220 * M, orders: 4, cogs: 48 * M, operatingExpenses: 5 * M, purchasingSessions: null });
    expect(scenario[1]).toEqual(original[1]);
    expect(original[0].gross).toBe(100 * M);
  });
  it("backtests chronological baselines, reproduces weekly structure and declines sparse history", () => {
    const history = Array.from({ length: 84 }, (_, i) => ({ ...day(nextDate("2025-01-01", i)), gross: (i % 7 + 1) * 100 * M, discounts: 0, reversals: 0 }));
    const forecast = forecastSales(history)!;
    expect(forecast.model).toBe("Weekday average");
    expect(forecast.mae).toBe(0);
    expect(forecast.points[0]).toMatchObject({ date: "2025-03-26", sales: 100 * M });
    expect(forecast.points).toHaveLength(30);
    expect(forecastSales(history.slice(0, 27))).toBeNull();
    expect(forecast.scores.find((item) => item.model === "Last observation")!.mae).toBeGreaterThan(0);
  });
});
describe("sales CSV and Excel normalization", () => {
  it("counts unique orders, exact decimal line values, explicit rejects and UCI reversals", async () => {
    const snapshot = await readSalesFile(csv, "csv", "GBP");
    expect(snapshot).toMatchObject({ accepted: 3, rejected: 1 });
    expect(snapshot.days[0]).toMatchObject({ orders: 1, gross: 402500, discounts: 10000 });
    expect(snapshot.days[1].reversals).toBe(101250);
    expect(salesMetrics(snapshot.days).aov).toBe(392500);
    expect(snapshot.errors[0]).toContain("Row 5");
    await expect(readSalesFile(Buffer.from("order_id,date,quantity,unit_price,currency\nA,2025-01-01,1,10,USD"), "csv", "GBP")).rejects.toThrow("mixed currencies");
    await expect(readSalesFile(Buffer.from("order_id,date,quantity,unit_price\nA,02/03/2025,1,10"), "csv", "GBP")).rejects.toThrow("ISO dates");
  });
  it("streams UCI Excel headers/dates and matches a CSV export", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sales");
    sheet.addRow(["InvoiceNo", "StockCode", "Description", "Quantity", "InvoiceDate", "UnitPrice"]);
    sheet.addRow(["100", "SKU", "Fixture", 2, new Date("2025-01-01T10:00:00Z"), 2.55]);
    sheet.getCell("E2").numFmt = "yyyy-mm-dd";
    const snapshot = await readSalesFile(Buffer.from(await workbook.xlsx.writeBuffer()), "xlsx", "GBP");
    expect(snapshot.days[0]).toMatchObject({ date: "2025-01-01", gross: 51000, orders: 1 });
    sheet.getCell("F2").value = { formula: "1+2", result: 3 };
    await expect(readSalesFile(Buffer.from(await workbook.xlsx.writeBuffer()), "xlsx", "GBP")).rejects.toThrow("Formula cells");
  });
  it("counts a sale after its same-day return and does not treat generic C-prefixed order IDs as UCI cancellations", async () => {
    const snapshot = await readSalesFile(Buffer.from("order_id,date,quantity,unit_price\nCUSTOM-1,2025-01-01,-1,10\nCUSTOM-1,2025-01-01,2,10"), "csv", "GBP");
    expect(snapshot.days[0]).toMatchObject({ orders: 1, gross: 20 * M, reversals: 10 * M });
    expect(snapshot.rejected).toBe(0);
  });
});
describe("owner-scoped analytics persistence", () => {
  const stores: ReturnType<typeof openStore>[] = [];
  afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
  async function setup() {
    const store = openStore(":memory:"); stores.push(store);
    const user = { id: randomUUID(), name: "Owner", email: `${randomUUID()}@example.test` };
    await store.createAccount(user, "unused", "token", Date.now() + 100000);
    const business = (await store.saveBusiness(user.id, { name: "Test business", category: "", description: "", website: "" }))!;
    const snapshot = await readSalesFile(csv, "csv", "GBP");
    return { store, user, business, snapshot };
  }
  it("previews without changing actuals, commits idempotently and protects snapshots from scenario edits", async () => {
    const { store, user, business, snapshot } = await setup();
    const baseline = await store.salesData(user.id, business.id);
    const draft = await store.previewSales(user.id, business.id, "fixture.csv", salesFileHash(csv), snapshot);
    expect((await store.previewSales(user.id, business.id, "same-data.csv", salesFileHash(csv), snapshot)).id).toBe(draft.id);
    expect((await store.salesData(user.id, business.id)).days).toEqual([]);
    await expect(store.commitSales(user.id, business.id, draft.id, baseline.version, false)).rejects.toThrow("acknowledge");
    const actual = await store.commitSales(user.id, business.id, draft.id, baseline.version, true);
    expect(actual.days).toHaveLength(2);
    expect((await store.commitSales(user.id, business.id, draft.id, baseline.version, true)).version).toBe(actual.version);
    await expect(store.salesData(randomUUID(), business.id)).rejects.toThrow("Business not found");
    const scenario = await store.saveSalesScenario(user.id, business.id, { name: "Alternative", start: "2025-01-01", end: "2025-01-02", ordersPct: 10, aovPct: 5, costPct: 0 }, actual.version);
    expect(scenario.days).toEqual(actual.days);
    expect(scenario.scenarios[0].days[0].gross).not.toBe(actual.days[0].gross);
    await expect(store.saveManualSales(user.id, business.id, { currency: "GBP", day: day("2025-01-01"), evidence: "Owner log", estimated: false }, actual.version)).rejects.toThrow("already has data");
    const updated = await store.saveManualSales(user.id, business.id, { currency: "GBP", day: day("2025-01-03"), evidence: "Owner log", estimated: true }, actual.version);
    expect(updated.days).toHaveLength(3);
    expect(updated.sources.at(-1)?.kind).toBe("estimate");
    await expect(store.saveSalesScenario(user.id, business.id, { name: "Stale", start: "2025-01-01", end: "2025-01-02", ordersPct: 0, aovPct: 0, costPct: 0 }, actual.version)).rejects.toThrow("History changed");
  });
  it("checks session/ownership before reading large files and preserves exact-origin mutation protection", async () => {
    const { store, business } = await setup();
    const app = createApp({ store });
    await request(app).get(`/api/businesses/${business.id}/analytics`).expect(401);
    await request(app).post(`/api/businesses/${business.id}/sales-imports?currency=GBP&filename=test.csv`).set("Origin", "http://127.0.0.1:5173").set("Content-Type", "text/csv").send(csv.toString()).expect(401);
    await request(app).post(`/api/businesses/${business.id}/analytics/manual`).send({}).expect(403);
  });
  it.each(["", "https://shop.example.test/"])("imports sales and saves isolated scenarios over HTTP with website %j without scanning or paid analysis", async (website) => {
    const { store, user, business: initialBusiness } = await setup();
    const business = (await store.saveBusiness(user.id, { ...initialBusiness, website }, initialBusiness.id))!;
    const session = newSession(); await store.createSession(user.id, session.tokenHash, session.expiresAt);
    const cookie = `gp_session=${session.token}`, origin = "http://127.0.0.1:5174";
    const app = createApp({ store, origin });
    const prefix = `/api/businesses/${business.id}`;
    const empty = await request(app).get(`${prefix}/analytics`).set("Cookie", cookie).expect(200).expect("Cache-Control", "no-store");
    const preview = await request(app).post(`${prefix}/sales-imports?currency=GBP&filename=orders.csv`)
      .set("Cookie", cookie).set("Origin", origin).set("Content-Type", "text/csv").send(csv.toString()).expect(201);
    expect((await store.salesData(user.id, business.id)).days).toEqual([]);
    const actual = await request(app).post(`${prefix}/sales-imports/${preview.body.draft.id}/commit`)
      .set("Cookie", cookie).set("Origin", origin).send({ expectedVersion: empty.body.analytics.version, confirmRejected: true }).expect(200);
    const scenario = await request(app).post(`${prefix}/analytics/scenarios`).set("Cookie", cookie).set("Origin", origin)
      .send({ expectedVersion: actual.body.analytics.version, scenario: {
        name: "Owner assumption", start: "2025-01-01", end: "2025-01-02", ordersPct: 100, aovPct: 0, costPct: 0,
      } }).expect(201);
    expect(scenario.body.analytics.days).toEqual(actual.body.analytics.days);
    expect(scenario.body.analytics.scenarios[0].days[0].orders).toBe(2);
    expect(await store.listScans(user.id, business.id)).toEqual([]);
    expect(await store.latestAnalysisJob(user.id, business.id)).toBeNull();
    await request(app).get(`${prefix}/analytics`).expect(401);
  });
  it("limits uploads per account across its businesses while leaving other accounts and saved reads available", async () => {
    const { store, user, business } = await setup();
    const origin = "http://127.0.0.1:5174", app = createApp({ store, origin });
    const first = newSession(); await store.createSession(user.id, first.tokenHash, first.expiresAt);
    const secondBusiness = (await store.saveBusiness(user.id, { name: "Other channel", category: "", description: "", website: "" }))!;
    const other = { id: randomUUID(), name: "Other owner", email: `${randomUUID()}@example.test` };
    const second = newSession(); await store.createAccount(other, "unused", second.tokenHash, second.expiresAt);
    const otherBusiness = (await store.saveBusiness(other.id, { name: "Separate account", category: "", description: "", website: "" }))!;
    const upload = (businessId: string, token: string) => request(app).post(`/api/businesses/${businessId}/sales-imports?currency=GBP&filename=orders.csv`)
      .set("Cookie", `gp_session=${token}`).set("Origin", origin).set("Content-Type", "text/csv").send(csv.toString());
    for (let index = 0; index < 12; index++) await upload(index % 2 ? business.id : secondBusiness.id, first.token).expect(201);
    await upload(secondBusiness.id, first.token).expect(429);
    await upload(otherBusiness.id, second.token).expect(201);
    await request(app).get(`/api/businesses/${business.id}/analytics`).set("Cookie", `gp_session=${first.token}`).expect(200);
    await request(app).get(`/api/businesses/${business.id}/growth`).set("Cookie", `gp_session=${first.token}`).expect(200);
    const saved = await request(app).get(`/api/businesses/${business.id}/understanding`).set("Cookie", `gp_session=${first.token}`).expect(200);
    expect(saved.body.job).toBeNull();
  });
});
