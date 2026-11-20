import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { SalesMapping } from "../shared/sales-mapping.js";
import { createApp } from "./app.js";
import { newSession } from "./auth.js";
import { openStore } from "./database.js";
import { readSalesFile, readSalesHeaders, salesFileHash } from "./sales-imports.js";

const custom = Buffer.from("Ticket,Booked on,Count,Each,Adjustment,Customer email,Other price\nA,2025-01-01,2,10,1,private@example.test,20\nA,2025-01-01,-1,10,0,private@example.test,20\nB,2025-01-01,1,5,0,private@example.test,30");
const mapping: SalesMapping = ["order", "date", "quantity", "price", "discount", null, null];
describe("owner-approved sales column mapping", () => {
  it("suggests unambiguous aliases only and returns headings, never private rows", async () => {
    const result = await readSalesHeaders(Buffer.from("Order number,Order date,Qty,Unit selling price,Line total,Net sales,Customer ID,constructor\nA,2025-01-01,2,10,20,20,PRIVATE,PRIVATE"), "csv");
    expect(result).toEqual({
      headers: ["Order number", "Order date", "Qty", "Unit selling price", "Line total", "Net sales", "Customer ID", "constructor"],
      suggestions: ["order", "date", "quantity", "price", null, null, null, null],
      issues: [],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect((await readSalesHeaders(Buffer.from("order_id,date,quantity,price,unit_price\nA,2025-01-01,1,10,20"), "csv")).suggestions).toEqual(["order", "date", "quantity", null, null]);
  });
  it("flags generic prices, discount semantics and duplicates without exposing row examples", async () => {
    const result = await readSalesHeaders(Buffer.from("order_id,date,quantity,Price,Discount,Email\nA,2025-01-01,2,10,5,PRIVATE"), "csv");
    expect(result.suggestions).toEqual(["order", "date", "quantity", null, null, null]);
    expect(result.issues).toEqual([
      { column: 3, field: "price", reason: "unit_price" },
      { column: 4, field: "discount", reason: "discount_amount" },
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    const duplicate = await readSalesHeaders(Buffer.from("order_id,InvoiceNo,date,quantity,unit_price\nA,A,2025-01-01,2,10"), "csv");
    expect(duplicate.issues).toEqual([
      { column: 0, field: "order", reason: "duplicate" },
      { column: 1, field: "order", reason: "duplicate" },
    ]);
    expect((await readSalesHeaders(Buffer.from("order_id,date,quantity,unit_price,line_discount_amount\nA,2025-01-01,2,10,1"), "csv")).issues).toEqual([]);
  });
  it("applies positional mapping and skips private columns without altering order/reversal arithmetic", async () => {
    const snapshot = await readSalesFile(custom, "csv", "GBP", mapping);
    expect(snapshot).toMatchObject({ accepted: 3, rejected: 0, excluded: 0 });
    expect(snapshot.days[0]).toMatchObject({ orders: 2, gross: 250000, discounts: 10000, reversals: 100000, units: 2 });
    expect(JSON.stringify(snapshot)).not.toContain("private@example.test");
    expect(snapshot.products).toEqual([{ sku: "(unassigned)", name: "(unassigned)", netSales: 140000, units: 2 }]);
  });
  it.each([
    { columns: ["order", "date", "quantity", null, null, null, null], message: "Required mappings" },
    { columns: ["order", "date", "quantity", "price", "price", null, null], message: "Duplicate mapped" },
    { columns: ["order", "date", "quantity", "price"], message: "every source column" },
    { columns: ["order", "date", "quantity", "price", "total", null, null], message: "Invalid option" },
  ])("rejects incomplete, repeated, misaligned or unknown field mappings: $message", async ({ columns, message }) => {
    await expect(readSalesFile(custom, "csv", "GBP", columns as SalesMapping)).rejects.toThrow(message);
  });
  it("does not derive quantity or prices from totals, parse slash dates, or convert currency", async () => {
    const totals = Buffer.from("Order ID,Date,Revenue\nA,2025-01-01,100");
    expect((await readSalesHeaders(totals, "csv")).suggestions).toEqual(["order", "date", null]);
    await expect(readSalesFile(totals, "csv", "GBP")).rejects.toThrow("Required mappings");
    await expect(readSalesFile(Buffer.from("Ticket,When,Count,Each\nA,01/02/2025,2,10"), "csv", "GBP", mapping.slice(0, 4))).rejects.toThrow("ISO dates");
    await expect(readSalesFile(Buffer.from("Ticket,When,Count,Each\nA,2025-01-01,,10"), "csv", "GBP", mapping.slice(0, 4))).rejects.toThrow("nonzero integer");
    await expect(readSalesFile(Buffer.from("Ticket,When,Count,Each,Money\nA,2025-01-01,2,10,USD"), "csv", "GBP", [...mapping.slice(0, 4), "currency"])).rejects.toThrow("mixed currencies");
  });
  it("retains UCI reversal rules only when the invoice column is actually the order mapping", async () => {
    const csv = Buffer.from("InvoiceNo,Ticket,Date,Quantity,UnitPrice\nC1,CUSTOM-1,2025-01-01,1,10");
    expect((await readSalesFile(csv, "csv", "GBP", ["order", null, "date", "quantity", "price"])).days[0]).toMatchObject({ orders: 0, reversals: 100000 });
    expect((await readSalesFile(csv, "csv", "GBP", [null, "order", "date", "quantity", "price"])).days[0]).toMatchObject({ orders: 1, gross: 100000, reversals: 0 });
    const legacy = Buffer.from("InvoiceNo,InvoiceDate,Quantity,UnitPrice\nC1,2025-01-01,1,10");
    expect((await readSalesFile(legacy, "csv", "GBP")).days[0].reversals).toBe(100000);
  });
  it("validates the full CSV during header inspection and enforces existing file/row/cell bounds", async () => {
    await expect(readSalesHeaders(Buffer.from("Ticket,Date\nA,\"PRIVATE"), "csv")).rejects.toThrow("CSV syntax error near row");
    await expect(readSalesHeaders(Buffer.from("Ticket,Date\nA,B,PRIVATE"), "csv")).rejects.toThrow("column counts");
    await expect(readSalesHeaders(Buffer.from([0xff]), "csv")).rejects.toThrow("UTF-8");
    await expect(readSalesHeaders(Buffer.alloc(0), "csv")).rejects.toThrow("nonempty");
    await expect(readSalesHeaders(Buffer.alloc(32 * 1024 * 1024 + 1), "csv")).rejects.toThrow("32 MiB");
    await expect(readSalesHeaders(Buffer.from(Array(41).fill("Heading").join(",")), "csv")).rejects.toThrow("40 columns");
    await expect(readSalesHeaders(Buffer.from("Heading\n" + "x".repeat(4001)), "csv")).rejects.toThrow("4,000");
    await expect(readSalesHeaders(Buffer.from("Heading\n" + "x\n".repeat(600001)), "csv")).rejects.toThrow("600,000 rows");
  });
  it("supports mapped values-only Excel, rejecting formulas and multiple sheets even during inspection", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Sales");
    sheet.addRow(["Ticket", "When", "Count", "Each"]);
    sheet.addRow(["A", new Date("2025-01-01T00:00:00Z"), 2, 10]);
    sheet.getCell("B2").numFmt = "yyyy-mm-dd";
    let bytes = Buffer.from(await book.xlsx.writeBuffer());
    expect((await readSalesHeaders(bytes, "xlsx")).headers).toEqual(["Ticket", "When", "Count", "Each"]);
    expect((await readSalesFile(bytes, "xlsx", "GBP", mapping.slice(0, 4))).days[0].gross).toBe(200000);
    sheet.getCell("D2").value = { formula: "1+2", result: 3 };
    bytes = Buffer.from(await book.xlsx.writeBuffer());
    await expect(readSalesHeaders(bytes, "xlsx")).rejects.toThrow("Formula cells");
    sheet.getCell("D2").value = 10;
    book.addWorksheet("Other").addRow(["Extra"]);
    await expect(readSalesHeaders(Buffer.from(await book.xlsx.writeBuffer()), "xlsx")).rejects.toThrow("one worksheet");
  });
  it("separates draft identities by approved parse configuration", () => {
    const base = { format: "csv" as const, currency: "GBP", mapping };
    expect(salesFileHash(custom, base)).toBe(salesFileHash(custom, { ...base, mapping: [...mapping] }));
    expect(salesFileHash(custom, base)).not.toBe(salesFileHash(custom, { ...base, mapping: ["order", "date", "quantity", null, "discount", null, "price"] }));
    expect(salesFileHash(custom, base)).not.toBe(salesFileHash(custom, { ...base, currency: "USD" }));
    expect(salesFileHash(custom, base)).not.toBe(salesFileHash(custom, { ...base, format: "xlsx" }));
  });
});

describe("sales mapping upload API", () => {
  const stores: ReturnType<typeof openStore>[] = [];
  afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
  async function setup() {
    const store = openStore(":memory:"); stores.push(store);
    const session = newSession(), user = { id: randomUUID(), name: "Owner", email: `${randomUUID()}@example.test` };
    await store.createAccount(user, "unused", session.tokenHash, session.expiresAt);
    const business = (await store.saveBusiness(user.id, { name: "Mapping fixture", category: "", description: "", website: "" }))!;
    const origin = "http://127.0.0.1:5174", app = createApp({ store, origin });
    const cookie = `gp_session=${session.token}`, path = `/api/businesses/${business.id}/sales-imports`;
    const upload = (query: Record<string, string>, content = custom) => request(app).post(path).query({ currency: "GBP", filename: "fixture.csv", ...query })
      .set("Cookie", cookie).set("Origin", origin).set("Content-Type", "text/csv").send(content.toString());
    return { store, user, business, app, origin, cookie, path, upload };
  }
  it("returns only headers, persists no inspection draft, and never reuses a differently mapped draft", async () => {
    const { store, user, business, upload } = await setup();
    const headers = await upload({ mode: "headers" }).expect(200);
    expect(Object.keys(headers.body).sort()).toEqual(["headers", "issues", "suggestions"]);
    expect(JSON.stringify(headers.body)).not.toContain("private@example.test");
    expect((await store.salesData(user.id, business.id)).imports).toEqual([]);
    const first = await upload({ mapping: JSON.stringify(mapping) }).expect(201);
    const again = await upload({ mapping: JSON.stringify(mapping) }).expect(201);
    expect(again.body.draft.id).toBe(first.body.draft.id);
    const changed = await upload({ mapping: JSON.stringify(["order", "date", "quantity", null, "discount", null, "price"]) }).expect(201);
    expect(changed.body.draft.id).not.toBe(first.body.draft.id);
    expect(changed.body.draft.snapshot.days[0].gross).toBe(700000);
    expect((await store.salesData(user.id, business.id)).days).toEqual([]);
    expect(JSON.stringify(changed.body.draft)).not.toContain("private@example.test");
    await upload({ mapping: "not-json" }).expect(400).expect(({ body }) => expect(body.error).toContain("Column mapping"));
    await upload({ mapping: '["customer_id"]' }).expect(400);
    await upload({ mapping: JSON.stringify(mapping.slice(0, 4)) }).expect(400);
  });
  it("protects header inspection with existing auth, ownership and origin checks", async () => {
    const { app, origin, cookie, path } = await setup();
    const query = { currency: "GBP", filename: "fixture.csv", mode: "headers" };
    await request(app).post(path).query(query).set("Origin", origin).set("Content-Type", "text/csv").send(custom.toString()).expect(401);
    await request(app).post(path).query(query).set("Cookie", cookie).set("Origin", "https://foreign.example.test").set("Content-Type", "text/csv").send(custom.toString()).expect(403);
    await request(app).post(`/api/businesses/${randomUUID()}/sales-imports`).query(query).set("Cookie", cookie).set("Origin", origin).set("Content-Type", "text/csv").send(custom.toString()).expect(404);
  });
});
