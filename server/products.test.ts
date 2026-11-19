import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { openStore, type Store } from "./database.js";
import { migrations } from "./migrations.js";
import { csvProducts, websiteProducts } from "./product-imports.js";
import { emptyProduct, productDescriptionLimit, productInputSchema, type ProductInput } from "../shared/products.js";
import { createWebsiteScanner } from "./website-scanner.js";
import type { ScanResult } from "../shared/website.js";

const origin = "http://127.0.0.1:5173";
const product: ProductInput = { ...emptyProduct, name: "Synthetic blue tee", sku: "TEE-1", price: "499.00", currency: "INR", variants: "size: M" };
const timestamp = "2026-11-16T12:00:00.000Z";
describe("product imports and identity", () => {
  it("parses quoted CSV, preserves decimal strings and provides row-specific errors without importing", () => {
    const rows = csvProducts('\uFEFFlisting_id,name,sku,price,currency,gtin,variants\none,"Tee, blue",T1,0,INR,,size: M\ntwo,Invalid,T2,-9,INR,123,large\nthree,Unknown,,,USD,,');
    expect(rows[0].data).toMatchObject({ name: "Tee, blue", price: "0", currency: "INR", variants: "size: M" });
    expect(rows[1]).toMatchObject({ row: 3, data: null });
    expect(rows[1].errors.join(" ")).toContain("price");
    expect(rows[1].errors.join(" ")).toContain("GTIN");
    expect(rows[2].data?.price).toBe("");
    expect(csvProducts("name\nUnidentified")[0].errors.join(" ")).toContain("stable listing_id");
    expect(csvProducts("listing_id,name\nsame,A\nsame,B").every((row) => row.errors.some((error) => error.includes("Duplicate")))).toBe(true);
    expect(() => csvProducts("name,unknown\nOne,two")).toThrow("Supported headers");
    expect(() => csvProducts('name\n"unclosed')).toThrow("line");
    expect(() => csvProducts(`name,sku\n${"A".repeat(49_152)}`)).toThrow("48 KiB");
    expect(() => csvProducts("name,sku\n" + Array.from({ length: 101 }, (_, index) => `Test,T${index}`).join("\n"))).toThrow("100");
  });

  it("extracts inert Product JSON-LD from bounded scan evidence and preserves multiple offers", async () => {
    const structured = { "@context": "https://schema.org", "@graph": [
      { "@type": "Product", name: "Fixture tee", sku: "TEE-1", color: "blue", size: "M", offers: [
        { "@type": "Offer", price: "499.00", priceCurrency: "INR", availability: "https://schema.org/InStock" },
        { "@type": "Offer", price: "6.00", priceCurrency: "USD", availability: "https://schema.org/PreOrder" },
      ] },
      { "@type": "Product", name: "Broken offer", sku: "BAD", offers: { price: 99 } },
      { "@type": "Organization", name: "Not a product" },
    ] };
    const scan = await createWebsiteScanner(async (url) => url.pathname === "/robots.txt"
      ? { status: 404, headers: {}, body: "" }
      : { status: 200, headers: { "content-type": "text/html" }, body: `<title>Fixture</title><script type="application/ld+json">${JSON.stringify(structured)}</script><h1>Public fixture</h1>` })("https://shop.example.com/");
    expect(scan.pages[0].productJson).toHaveLength(2);
    expect(scan.pages[0].text).not.toContain("priceCurrency");
    const rows = websiteProducts({ ...scan, id: randomUUID(), businessId: randomUUID() });
    expect(rows[0].data).toMatchObject({ name: "Fixture tee", price: "", currency: "", offers: [
      { price: "499.00", currency: "INR", availability: "https://schema.org/InStock" },
      { price: "6.00", currency: "USD", availability: "https://schema.org/PreOrder" },
    ] });
    expect(rows[0].data?.variants).toContain("blue");
    expect(rows[1].errors.join(" ")).toContain("Currency");
    expect(() => websiteProducts({ ...scan, pages: [{ ...scan.pages[0], productJson: undefined }], id: randomUUID(), businessId: randomUUID() })).toThrow("No supported");
  });

  it("extracts published image URLs and ImageObjects without rejecting products with unsupported images", () => {
    const records = [
      { image: "/images/tee.jpg?v=2", expected: "https://shop.example.com/images/tee.jpg?v=2" },
      { image: { "@type": "ImageObject", contentUrl: "//cdn.example.com/tee.webp" }, expected: "https://cdn.example.com/tee.webp" },
      { image: ["javascript:alert(1)", { url: "../images/other.png" }], expected: "https://shop.example.com/images/other.png" },
      { image: { "@id": "https://cdn.example.com/image.jpg" }, expected: "https://cdn.example.com/image.jpg" },
      { image: { contentUrl: "data:image/svg+xml,bad", url: "https://cdn.example.com/fallback.jpg" }, expected: "https://cdn.example.com/fallback.jpg" },
      { image: { unexpected: "https://cdn.example.com/not-an-image-field.jpg" }, expected: undefined },
      { image: undefined, expected: undefined },
    ];
    const rows = websiteProducts({ pages: [{
      url: "https://shop.example.com/products/tee", capturedAt: timestamp, title: "", description: "", headings: [], text: "", contacts: [], callsToAction: [], links: [], warnings: [],
      productJson: records.map(({ image }, index) => JSON.stringify({ "@type": "Product", name: `Tee ${index}`, sku: `TEE-${index}`, image })),
    }] });
    expect(rows.map((row) => row.data?.imageUrl)).toEqual(records.map((record) => record.expected));
    expect(rows.every((row) => row.data && !row.errors.length)).toBe(true);
    expect(rows[5].notes.join(" ")).toContain("placeholder");
    expect(rows[6].notes).toEqual([]);
  });

  it("normalizes clearly grouped website prices without relaxing CSV or guessing ambiguous prices", () => {
    const prices = ["2,899.00", "1,234,567.8900", "2,89.00", "1.234,56", "1,234", "INR 2,899.00", "-2,899.00"];
    const rows = websiteProducts({ pages: [{
      url: "https://shop.example.com/products/tee", capturedAt: timestamp, title: "", description: "", headings: [], text: "", contacts: [], callsToAction: [], links: [], warnings: [],
      productJson: prices.map((price, index) => JSON.stringify({ "@type": "Product", name: `Tee ${index}`, sku: `TEE-${index}`, offers: { price, priceCurrency: "INR" } })),
    }] });
    expect(rows[0].data).toMatchObject({ price: "2899.00", offers: [{ price: "2899.00" }] });
    expect(rows[0].notes).toEqual(['Normalized published price "2,899.00" to "2899.00" by removing thousands separators.']);
    expect(rows[1].data?.price).toBe("1234567.8900");
    expect(rows.slice(2).every((row) => row.data === null && row.errors.some((message) => message.startsWith("price:")))).toBe(true);
    expect(csvProducts('name,sku,price,currency\nTee,TEE,"2,899.00",INR')[0].data).toBeNull();
    expect(productInputSchema.safeParse({ ...product, price: "2,899.00" }).success).toBe(false);
  });

  it("retains individually valid fields for rejected records while keeping them non-importable", () => {
    const rows = websiteProducts({ pages: [{
      url: "https://shop.example.com/products/tee", capturedAt: timestamp, title: "", description: "", headings: [], text: "", contacts: [], callsToAction: [], links: [], warnings: [],
      productJson: [
        { name: "Recognizable tee", description: "Published description", sku: "TEE-1", image: "/tee.jpg", offers: { price: "-1", priceCurrency: "INR" } },
        { name: "Broken types", sku: { bad: "not a SKU" }, image: "/other.jpg", offers: [42] },
        { name: "", sku: " ", gtin: " ", image: "/unnamed.jpg" },
        { name: "Published URL", sku: " ", url: "/products/published-url" },
        { name: "First rejected alternative", sku: "DUPLICATE", offers: { price: "-1", priceCurrency: "INR" } },
        { name: "Second rejected alternative", sku: "DUPLICATE", offers: { price: "-1", priceCurrency: "INR" } },
      ].map((value) => JSON.stringify({ "@type": "Product", ...value })),
    }] });
    expect(rows[0].data).toBeNull();
    expect(rows[0].preview).toMatchObject({ name: "Recognizable tee", description: "Published description", sku: "TEE-1", currency: "INR", imageUrl: "https://shop.example.com/tee.jpg" });
    expect(rows[0].preview?.price).toBeUndefined();
    expect(rows[0].errors.some((error) => error.startsWith("price:"))).toBe(true);
    expect(rows[1].data).toBeNull();
    expect(rows[1].preview).toMatchObject({ name: "Broken types", imageUrl: "https://shop.example.com/other.jpg" });
    expect(rows[1].preview?.sku).toBeUndefined();
    expect(rows[1].errors.join(" ")).toContain("offers.0");
    expect(rows[2].preview?.name).toBeUndefined();
    expect(rows[2].sourceKey).toBe("");
    expect(rows[2].errors.join(" ")).toContain("identity:");
    expect(rows[3].data?.name).toBe("Published URL");
    expect(rows[3].errors).toEqual([]);
    expect(rows.slice(4).map((row) => row.preview?.name)).toEqual(["First rejected alternative", "Second rejected alternative"]);
    expect(rows.slice(4).every((row) => row.data === null && row.errors.some((error) => error.startsWith("Duplicate listing identity")))).toBe(true);
  });

  it("bounds long website descriptions without rejecting products or relaxing owner and CSV validation", () => {
    const description = "Published product details. ".repeat(200);
    const rows = websiteProducts({ pages: [{
      url: "https://shop.example.com/products/tee", capturedAt: timestamp, title: "", description: "", headings: [], text: "", contacts: [], callsToAction: [], links: [], warnings: [],
      productJson: [
        { name: "Long description", sku: "LONG", description: `  ${description}  ` },
        { name: "Boundary description", sku: "BOUNDARY", description: "x".repeat(productDescriptionLimit) },
        { name: "Invalid description", sku: "INVALID", description: { text: description } },
        { name: "No identity", description },
      ].map((value) => JSON.stringify({ "@type": "Product", ...value })),
    }] });
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].data?.description).toBe(description.trim().slice(0, productDescriptionLimit));
    expect(rows[0].notes.join(" ")).toContain("The full description remains in the saved website evidence");
    expect(rows[1].errors).toEqual([]);
    expect(rows[1].data?.description).toHaveLength(productDescriptionLimit);
    expect(rows[1].notes).toEqual([]);
    expect(rows[2].data).toBeNull();
    expect(rows[2].errors.join(" ")).toContain("description:");
    expect(rows[3].errors.join(" ")).toContain("identity:");
    expect(productInputSchema.safeParse({ ...product, description }).success).toBe(false);
    expect(csvProducts(`name,sku,description\nTee,LONG,${description}`)[0].data).toBeNull();
  });

  it.each([
    "javascript:alert(1)", "data:image/svg+xml,bad", "file:///image.png", "http://cdn.example.com/image.png",
    "https://user:password@cdn.example.com/image.png", "https://127.0.0.1/image.png",
    "https://[::1]/image.png", "https://store.local/image.png", "https://localhost/image.png",
    "https://cdn.example.com:8443/image.png",
  ])("rejects unsafe thumbnail URL %s without losing otherwise valid website data", (image) => {
    expect(productInputSchema.safeParse({ ...product, imageUrl: image }).success).toBe(false);
    const [row] = websiteProducts({ pages: [{
      url: "https://shop.example.com/products/tee", capturedAt: timestamp, title: "", description: "", headings: [], text: "", contacts: [], callsToAction: [], links: [], warnings: [],
      productJson: [JSON.stringify({ "@type": "Product", name: "Tee", sku: "TEE-1", image })],
    }] });
    expect(row.data?.name).toBe("Tee");
    expect(row.data?.imageUrl).toBeUndefined();
    expect(row.errors).toEqual([]);
    expect(row.notes.join(" ")).toContain("placeholder");
  });
});

describe("owner catalogue API and transactions", () => {
  let directory: string, path: string, store: Store, app: ReturnType<typeof createApp>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "growthpulse-products-")); path = join(directory, "test.sqlite");
    store = openStore(path); app = createApp({ store, origin });
  });
  afterEach(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });
  async function owner(email = "owner@example.test") {
    const account = await request(app).post("/api/auth/register").set("Origin", origin).send({ name: "Test Owner", email, password: "a test-only long passphrase" }).expect(201);
    const cookie = String(account.headers["set-cookie"][0]).split(";")[0];
    const response = await request(app).post("/api/businesses").set("Origin", origin).set("Cookie", cookie).send({ name: "Synthetic shop", website: "", category: "", description: "" }).expect(201);
    return { cookie, userId: account.body.user.id as string, id: response.body.business.id as string };
  }
  async function preview(user: { cookie: string; id: string }, csv: string, sourceName = "Channel") {
    return (await request(app).post(`/api/businesses/${user.id}/product-imports/csv`).set("Origin", origin).set("Cookie", user.cookie).send({ csv, sourceName }).expect(201)).body.draft;
  }
  const post = (user: { cookie: string; id: string }, suffix: string, body: unknown) => request(app).post(`/api/businesses/${user.id}/${suffix}`).set("Origin", origin).set("Cookie", user.cookie).send(body);
  function captured(records: unknown[], capturedAt = timestamp): ScanResult {
    return {
      requestedUrl: "https://shop.example.com/", status: "complete", startedAt: capturedAt, completedAt: capturedAt, failures: [], notes: [],
      pages: Array.from({ length: Math.ceil(records.length / 50) }, (_, index) => ({
        url: `https://shop.example.com/collection-${index}`, capturedAt, title: "", description: "", headings: [], text: "", contacts: [], callsToAction: [], links: [], warnings: [],
        productJson: records.slice(index * 50, (index + 1) * 50).map((record) => JSON.stringify(record)),
      })),
    };
  }

  it("adds scanned products before any import confirmation and preserves owner edits through fresh, repeated and stale observations", async () => {
    const user = await owner();
    const record = { "@type": "Product", name: "Website tee", sku: "TEE-1", offers: { price: "499", priceCurrency: "INR" }, image: "/tee.jpg" };
    const first = (await store.saveScan(user.userId, user.id, { ...captured([record]), catalogue: { created: 999, updated: 0, unchanged: 0, skipped: 0, issues: [] } }))!;
    expect(first.catalogue).toEqual({ created: 1, updated: 0, unchanged: 0, skipped: 0, issues: [] });
    const [saved] = (await request(app).get(`/api/businesses/${user.id}/products`).set("Cookie", user.cookie).expect(200)).body.products;
    expect(saved.listings[0].data).toMatchObject({ price: "499", imageUrl: "https://shop.example.com/tee.jpg" });
    await store.saveProduct(user.userId, user.id, { ...product, name: "Owner title", price: "600" }, saved.id);
    const fresh = captured([{ ...record, name: "New website title", offers: { price: "550", priceCurrency: "INR" } }], "2026-11-17T12:00:00.000Z");
    expect((await store.saveScan(user.userId, user.id, fresh))?.catalogue).toMatchObject({ created: 0, updated: 1 });
    expect((await store.saveScan(user.userId, user.id, fresh))?.catalogue).toMatchObject({ unchanged: 1 });
    expect((await store.saveScan(user.userId, user.id, captured([record])))?.catalogue).toMatchObject({ skipped: 1 });
    const sameTimeConflict = (await store.saveScan(user.userId, user.id, { ...fresh, pages: [{ ...fresh.pages[0], productJson: [JSON.stringify(record)] }] }))!;
    expect(sameTimeConflict.catalogue?.issues[0].message).toContain("same capture time");
    const products = await store.listProducts(user.userId, user.id);
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe("Owner title");
    expect(products[0].listings.find((listing) => listing.source === "manual")?.data.price).toBe("600");
    expect(products[0].listings.find((listing) => listing.source === "website")?.data.price).toBe("550");
  });

  it("reports invalid identities, uncertain names and conflicting identifiers without dropping other scanned products", async () => {
    const user = await owner();
    await store.saveProduct(user.userId, user.id, { ...product, name: "Existing", gtin: "4006381333931" });
    const result = await store.saveScan(user.userId, user.id, captured([
      { "@type": "Product", name: "Ready", sku: "READY" },
      { "@type": "Product", name: "Existing", url: "/other" },
      { "@type": "Product", name: "Conflicting GTIN", sku: "TEE-1", gtin: "9780140328721" },
      { "@type": "Product", name: "No identity" },
      { "@type": "Product", name: "Invalid price", sku: "BAD", offers: { price: "-1", priceCurrency: "INR" } },
      { "@type": "Product", name: "Duplicate one", sku: "DUP" },
      { "@type": "Product", name: "Duplicate two", sku: "DUP" },
    ]));
    expect(result?.catalogue).toMatchObject({ created: 1, skipped: 6 });
    expect(result?.catalogue?.issues).toHaveLength(6);
    expect(result?.catalogue?.issues.every((issue) => issue.message.length > 0)).toBe(true);
    expect((await store.listProducts(user.userId, user.id)).map((item) => item.name)).toEqual(["Existing", "Ready"]);
  });

  it("considers more than 100 captured records and reports the exact catalogue cap without losing the scan", async () => {
    const user = await owner();
    const result = await store.saveScan(user.userId, user.id, captured(Array.from({ length: 203 }, (_, index) => ({
      "@type": "Product", name: `Item ${index}`, sku: `SKU-${index}`,
    }))));
    expect(result?.catalogue).toMatchObject({ created: 200, skipped: 3 });
    expect(result?.catalogue?.issues.every((issue) => issue.message.includes("limit of 200"))).toBe(true);
    expect(await store.listProducts(user.userId, user.id)).toHaveLength(200);
    expect(await store.listScans(user.userId, user.id)).toHaveLength(1);
  });

  it("synchronizes retained legacy scans idempotently with ownership and origin checks and no network calls", async () => {
    const alice = await owner(), bob = await owner("bob@example.test");
    const description = "Published website product details. ".repeat(200);
    const evidence = captured([{ "@type": "Product", name: "Legacy tee", sku: "LEGACY", description }]), scanId = randomUUID();
    const database = new Database(path);
    try {
      database.prepare("INSERT INTO website_scans (id,business_id,requested_url,status,started_at,completed_at,page_count,result_json) VALUES (?,?,?,?,?,?,?,?)")
        .run(scanId, alice.id, evidence.requestedUrl, evidence.status, timestamp, timestamp, evidence.pages.length, JSON.stringify(evidence));
    } finally { database.close(); }
    const scanner = vi.fn(async () => { throw new Error("Synchronization must not scan."); });
    app = createApp({ store, origin, scanner });
    const suffix = `scans/${scanId}/catalogue`;
    await request(app).post(`/api/businesses/${alice.id}/${suffix}`).set("Origin", origin).send({}).expect(401);
    await request(app).post(`/api/businesses/${alice.id}/${suffix}`).set("Origin", origin).set("Cookie", bob.cookie).send({}).expect(404);
    await request(app).post(`/api/businesses/${alice.id}/${suffix}`).set("Cookie", alice.cookie).send({}).expect(403);
    await post(bob, suffix, {}).expect(404);
    await post(alice, suffix, { products: [] }).expect(400);
    const first = (await post(alice, suffix, {}).expect(200)).body;
    expect(first.catalogue.created).toBe(1);
    expect(first.products[0].description).toBe(description.trim().slice(0, productDescriptionLimit));
    expect(first.products[0].listings[0].data.description).toBe(first.products[0].description);
    expect((await store.getScan(alice.userId, alice.id, scanId))?.pages[0].productJson).toEqual(evidence.pages[0].productJson);
    const repeat = (await post(alice, suffix, {}).expect(200)).body;
    expect(repeat.catalogue).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(repeat.products).toEqual(first.products);
    expect(await store.listProducts(bob.userId, bob.id)).toHaveLength(0);
    expect(scanner).not.toHaveBeenCalled();
  });

  it("creates and edits manual products with evidence, without erasing imported listings", async () => {
    const user = await owner();
    const saved = await post(user, "products", product).expect(201);
    const draft = await preview(user, "name,sku,price,currency\nSource tee,TEE-1,450.00,INR");
    expect(draft.matches[0]).toMatchObject({ kind: "identifier", productId: saved.body.product.id });
    await post(user, `product-imports/${draft.id}/commit`, { decisions: [{ row: 2, action: "link", productId: saved.body.product.id }] }).expect(200);
    const edited = await request(app).put(`/api/businesses/${user.id}/products/${saved.body.product.id}`).set("Origin", origin).set("Cookie", user.cookie).send({ ...product, name: "Owner edited", price: "525" }).expect(200);
    expect(edited.body.product.listings).toHaveLength(2);
    expect(edited.body.product.listings.find((item: { source: string }) => item.source === "csv").data.price).toBe("450.00");
    expect(edited.body.product.listings.find((item: { source: string }) => item.source === "manual").data.price).toBe("525");
    expect((await store.listActivity(user.userId, user.id)).filter((item) => item.action === "product.saved")).toHaveLength(2);
    expect((await store.listEvidence(user.userId, user.id)).filter((item) => item.source === "product")).toHaveLength(3);
    await post(user, "products", { ...product, price: "-1" }).expect(400);
    await post(user, "products", { ...product, currency: "" }).expect(400);
    await post(user, "products", { ...product, sku: "tee-1" }).expect(409);
    await store.close(); store = openStore(path);
    expect((await store.listProducts(user.userId, user.id))[0].listings).toHaveLength(2);
  });

  it("requires explicit review of names, normalizes identifiers, prevents repeated imports and reuses a new batch identity", async () => {
    const user = await owner();
    const first = await post(user, "products", { ...product, sku: "", gtin: "4006381333931" }).expect(201);
    const uncertain = await preview(user, "listing_id,name\nsecond,Synthetic blue tee");
    expect(uncertain.matches[0]).toMatchObject({ kind: "review", productId: null });
    const identified = await preview(user, "listing_id,name,gtin\nsource-one,Imported tee,04006381333931\nsource-two,Same item another listing,4006381333931");
    expect(identified.matches.every((match: { productId: string }) => match.productId === first.body.product.id)).toBe(true);
    const decisions = identified.rows.map((row: { row: number }) => ({ row: row.row, action: "link", productId: first.body.product.id }));
    const imported = await post(user, `product-imports/${identified.id}/commit`, { decisions }).expect(200);
    await post(user, `product-imports/${identified.id}/commit`, { decisions }).expect(200, imported.body);
    const repeat = await preview(user, "listing_id,name,gtin\nsource-one,Refreshed title,04006381333931");
    expect(repeat.matches[0].kind).toBe("repeat");
    await post(user, `product-imports/${repeat.id}/commit`, { decisions: [{ row: 2, action: "link", productId: first.body.product.id }] }).expect(200);
    expect(await store.listProducts(user.userId, user.id)).toHaveLength(1);
    expect((await store.listProducts(user.userId, user.id))[0].name).toBe(product.name);
    expect((await store.listProducts(user.userId, user.id))[0].listings).toHaveLength(3);
    const batch = await preview(user, "listing_id,name,sku\nnew-one,Other tee,OTHER\nnew-two,Other source listing,other");
    const result = await post(user, `product-imports/${batch.id}/commit`, { decisions: [{ row: 2, action: "new" }, { row: 3, action: "new" }] }).expect(200);
    expect(result.body.result).toMatchObject({ created: 1, imported: 2 });
  });

  it("isolates every private route and rejects forged ownership, source and cross-business targets", async () => {
    const alice = await owner(), bob = await owner("bob@example.test");
    const saved = await post(alice, "products", product).expect(201);
    const draft = await preview(alice, "listing_id,name\none,Imported");
    const root = `/api/businesses/${alice.id}`;
    for (const suffix of ["/products", `/product-imports/${draft.id}`]) {
      await request(app).get(root + suffix).expect(401);
      await request(app).get(root + suffix).set("Cookie", bob.cookie).expect(404);
    }
    await request(app).post(root + "/products").set("Cookie", alice.cookie).send(product).expect(403);
    await post(alice, "products", { ...product, ownerId: bob.userId }).expect(400);
    await post(bob, `product-imports/${draft.id}/commit`, { decisions: [{ row: 2, action: "new" }] }).expect(404);
    const bobDraft = await preview(bob, "listing_id,name\none,Bob product");
    await post(bob, `product-imports/${bobDraft.id}/commit`, { decisions: [{ row: 2, action: "link", productId: saved.body.product.id }] }).expect(404);
    await post(bob, "product-imports/website", { scanId: randomUUID(), rows: [] }).expect(400);
    await post(bob, "product-imports/website", { scanId: randomUUID() }).expect(404);
    expect(await store.listProducts(bob.userId, bob.id)).toHaveLength(0);
  });

  it("saves website listings from existing owned evidence without another network request", async () => {
    const user = await owner();
    const scan = (await store.saveScan(user.userId, user.id, { requestedUrl: "https://shop.example.com/", status: "complete", startedAt: timestamp, completedAt: timestamp, failures: [], notes: [], pages: [
      { url: "https://shop.example.com/product", capturedAt: timestamp, title: "", description: "", headings: [], text: "", contacts: [], callsToAction: [], links: [], warnings: [], productJson: [JSON.stringify({ "@type": "Product", name: "Observed tee", sku: "TEE-1", image: "/images/tee.jpg?v=1", offers: { price: "499", priceCurrency: "INR" } })] },
    ] }))!;
    const secondPage = { ...scan.pages[0], url: "https://shop.example.com/another-listing" };
    const multiple = (await store.saveScan(user.userId, user.id, { ...scan, pages: [...scan.pages, secondPage] }))!;
    const draft = (await post(user, "product-imports/website", { scanId: multiple.id }).expect(201)).body.draft;
    expect(draft.rows[0].data.imageUrl).toBe("https://shop.example.com/images/tee.jpg?v=1");
    expect(scan.catalogue).toMatchObject({ created: 1, skipped: 0 });
    expect(multiple.catalogue).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    const result = await post(user, `product-imports/${draft.id}/commit`, { decisions: draft.matches.map((match: { row: number; productId: string }) => ({ row: match.row, action: "link", productId: match.productId })) }).expect(200);
    expect(result.body.result).toMatchObject({ imported: 2, created: 0 });
    expect((await store.listProducts(user.userId, user.id))[0].listings).toHaveLength(2);
    const listing = (await store.listProducts(user.userId, user.id))[0].listings[0];
    expect(listing).toMatchObject({ source: "website", sourceName: "shop.example.com", reference: "https://shop.example.com/product", capturedAt: timestamp });
    expect(listing.data.imageUrl).toBe("https://shop.example.com/images/tee.jpg?v=1");
    const again = (await post(user, "product-imports/website", { scanId: scan.id }).expect(201)).body.draft;
    expect(again.matches[0].kind).toBe("repeat");
    await store.close(); store = openStore(path);
    expect((await store.listProducts(user.userId, user.id))[0].listings[0].data.imageUrl).toBe("https://shop.example.com/images/tee.jpg?v=1");
  });

  it("refreshes a legacy draft from its exact retained evidence, then imports only validated records", async () => {
    const user = await owner(), other = await owner("other@example.test");
    const scanner = vi.fn(async () => { throw new Error("Refresh must not scan the website."); });
    app = createApp({ store, origin, scanner });
    const scan = (await store.saveScan(user.userId, user.id, { requestedUrl: "https://shop.example.com/", status: "complete", startedAt: timestamp, completedAt: timestamp, failures: [], notes: [], pages: [
      { url: "https://shop.example.com/product", capturedAt: timestamp, title: "", description: "", headings: [], text: "", contacts: [], callsToAction: [], links: [], warnings: [], productJson: [
        JSON.stringify({ "@type": "Product", name: "Recoverable tee", sku: "TEE-1", image: "/tee.jpg", offers: { price: "2,899.00", priceCurrency: "INR" } }),
        JSON.stringify({ "@type": "Product", name: "Still needs review", sku: "BAD", image: "/bad.jpg", offers: { price: "-1", priceCurrency: "INR" } }),
      ] },
    ] }))!;
    const legacy = await store.createProductImport(user.userId, user.id, "website", "shop.example.com", websiteProducts(scan).map((row) => ({
      ...row, data: null, preview: undefined, notes: [], errors: ["price: Invalid legacy price."],
    })));
    await post(other, `product-imports/${legacy.id}/refresh`, {}).expect(404);
    await request(app).post(`/api/businesses/${user.id}/product-imports/${legacy.id}/refresh`).set("Origin", origin).send({}).expect(401);
    await post(user, `product-imports/${legacy.id}/refresh`, { scanId: randomUUID() }).expect(400);
    const refreshed = (await post(user, `product-imports/${legacy.id}/refresh`, {}).expect(201)).body.draft;
    expect(refreshed.id).not.toBe(legacy.id);
    expect(refreshed.rows[0].data).toMatchObject({ name: "Recoverable tee", price: "2899.00", imageUrl: "https://shop.example.com/tee.jpg" });
    expect(refreshed.rows[1]).toMatchObject({ data: null, preview: { name: "Still needs review", imageUrl: "https://shop.example.com/bad.jpg" } });
    expect((await store.getProductImport(user.userId, user.id, legacy.id)).rows.every((row) => row.data === null && !row.preview)).toBe(true);
    const automaticallySaved = await store.listProducts(user.userId, user.id);
    expect(automaticallySaved).toHaveLength(1);
    expect(scan.catalogue).toMatchObject({ created: 1, skipped: 1 });
    await post(user, `product-imports/${refreshed.id}/commit`, { decisions: [{ row: 1, action: "link", productId: automaticallySaved[0].id }, { row: 2, action: "new" }] }).expect(400);
    expect(await store.listProducts(user.userId, user.id)).toEqual(automaticallySaved);
    const imported = (await post(user, `product-imports/${refreshed.id}/commit`, { decisions: [{ row: 1, action: "link", productId: automaticallySaved[0].id }, { row: 2, action: "skip" }] }).expect(200)).body;
    expect(imported.result).toMatchObject({ imported: 1, skipped: 1, created: 0 });
    expect((await store.listProducts(user.userId, user.id))[0].listings[0].data).toMatchObject({ price: "2899.00", imageUrl: "https://shop.example.com/tee.jpg" });
    expect(scanner).not.toHaveBeenCalled();
    const csv = await preview(user, "name,sku\nCSV tee,CSV-1");
    await post(user, `product-imports/${csv.id}/refresh`, {}).expect(400);
    const repeated = (await post(user, `product-imports/${legacy.id}/refresh`, {}).expect(201)).body.draft;
    expect(repeated.matches[0].kind).toBe("repeat");
    const repeat = await post(user, `product-imports/${repeated.id}/commit`, { decisions: [{ row: 1, action: "link", productId: repeated.matches[0].productId }, { row: 2, action: "skip" }] }).expect(200);
    expect(repeat.body.result).toMatchObject({ imported: 1, created: 0, updated: 1 });
    await store.close(); store = openStore(path);
    const saved = await store.listProducts(user.userId, user.id);
    expect(saved).toHaveLength(1);
    expect(saved[0].listings).toHaveLength(1);
    expect(saved[0].listings[0].data.imageUrl).toBe("https://shop.example.com/tee.jpg");
  });

  it("requires every original product page and capture time rather than substituting a newer partial scan", async () => {
    const user = await owner();
    const first = { url: "https://shop.example.com/first", capturedAt: timestamp, title: "", description: "", headings: [], text: "", contacts: [], callsToAction: [], links: [], warnings: [], productJson: [JSON.stringify({ "@type": "Product", name: "First", sku: "FIRST" })] };
    const second = { ...first, url: "https://shop.example.com/second", productJson: [JSON.stringify({ "@type": "Product", name: "Original second", sku: "SECOND" })] };
    const evidence = { requestedUrl: "https://shop.example.com/", status: "complete" as const, startedAt: timestamp, completedAt: timestamp, failures: [], notes: [], pages: [first, second] };
    const draft = await store.createProductImport(user.userId, user.id, "website", "shop.example.com", websiteProducts(evidence));
    await store.saveScan(user.userId, user.id, { ...evidence, pages: [first, { ...second, capturedAt: "2026-11-18T12:00:00.000Z" }] });
    await post(user, `product-imports/${draft.id}/refresh`, {}).expect(409);
    await store.saveScan(user.userId, user.id, evidence);
    const refreshed = await post(user, `product-imports/${draft.id}/refresh`, {}).expect(201);
    expect(refreshed.body.draft.rows).toHaveLength(2);
    expect(refreshed.body.draft.rows[1]).toMatchObject({ capturedAt: timestamp, data: { name: "Original second" } });
  });

  it("does not substitute another owner's evidence or guess when the original scan is ambiguous", async () => {
    const alice = await owner(), bob = await owner("bob@example.test");
    const evidence = { requestedUrl: "https://shop.example.com/", status: "complete" as const, startedAt: timestamp, completedAt: timestamp, failures: [], notes: [], pages: [
      { url: "https://shop.example.com/product", capturedAt: timestamp, title: "", description: "", headings: [], text: "", contacts: [], callsToAction: [], links: [], warnings: [], productJson: [JSON.stringify({ "@type": "Product", name: "Tee", sku: "TEE-1" })] },
    ] };
    const draft = await store.createProductImport(alice.userId, alice.id, "website", "shop.example.com", websiteProducts(evidence));
    await store.saveScan(bob.userId, bob.id, evidence);
    await post(alice, `product-imports/${draft.id}/refresh`, {}).expect(409);
    await store.saveScan(alice.userId, alice.id, evidence);
    await store.saveScan(alice.userId, alice.id, evidence);
    await post(alice, `product-imports/${draft.id}/refresh`, {}).expect(409);
    expect(await store.listProducts(alice.userId, alice.id)).toHaveLength(1);
  });

  it("uses newly learned batch identifiers, but requires review for contradictory GTINs", async () => {
    const user = await owner();
    const draft = await preview(user, "listing_id,name,sku,gtin\none,First,TEE,\ntwo,Second,TEE,4006381333931\nthree,Third,,4006381333931");
    const result = await post(user, `product-imports/${draft.id}/commit`, { decisions: [2, 3, 4].map((row) => ({ row, action: "new" })) }).expect(200);
    expect(result.body.result).toMatchObject({ imported: 3, created: 1 });
    const conflict = await preview(user, "listing_id,name,sku,gtin\ntwo,Contradiction,TEE,9780140328721");
    expect(conflict.matches[0]).toMatchObject({ kind: "review", productId: null });
    const otherSource = await preview(user, "listing_id,name,sku,gtin\nother,Conflicting source,TEE,9780140328721", "Other");
    expect(otherSource.matches[0].kind).toBe("review");
    expect((await store.listProducts(user.userId, user.id))[0].listings).toHaveLength(3);
  });

  it("rejects older observations and leaves newer listings unchanged atomically", async () => {
    const user = await owner();
    const sourceRow = (capturedAt: string, price: string) => ({ row: 2, sourceKey: "id:one", reference: "CSV row 2", capturedAt, data: { ...product, price }, errors: [], notes: [] });
    const old = await store.createProductImport(user.userId, user.id, "csv", "channel", [sourceRow(timestamp, "450")]);
    const newer = await store.createProductImport(user.userId, user.id, "csv", "channel", [sourceRow("2026-11-17T12:00:00.000Z", "499")]);
    await store.commitProductImport(user.userId, user.id, newer.id, { decisions: [{ row: 2, action: "new" }] });
    const saved = (await store.listProducts(user.userId, user.id))[0];
    await post(user, `product-imports/${old.id}/commit`, { decisions: [{ row: 2, action: "link", productId: saved.id }] }).expect(409);
    expect((await store.listProducts(user.userId, user.id))[0].listings[0].data.price).toBe("499");
    expect((await store.getProductImport(user.userId, user.id, old.id)).committed).toBe(false);
  });

  it("skips invalid rows only explicitly and rolls back every write on a later failure", async () => {
    const user = await owner();
    const draft = await preview(user, "listing_id,name,price,currency\none,Valid,10,INR\ntwo,,10,INR");
    await post(user, `product-imports/${draft.id}/commit`, { decisions: [{ row: 2, action: "new" }, { row: 3, action: "new" }] }).expect(400);
    expect(await store.listProducts(user.userId, user.id)).toEqual([]);
    await post(user, `product-imports/${draft.id}/commit`, { decisions: [{ row: 2, action: "new" }, { row: 2, action: "skip" }] }).expect(400);
    const database = new Database(path);
    database.exec("CREATE TRIGGER reject_product_activity BEFORE INSERT ON activities WHEN NEW.action='products.imported' BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END;");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await post(user, `product-imports/${draft.id}/commit`, { decisions: [{ row: 2, action: "new" }, { row: 3, action: "skip" }] }).expect(500);
    expect(log).toHaveBeenCalled();
    expect(await store.listProducts(user.userId, user.id)).toEqual([]);
    expect(await store.listEvidence(user.userId, user.id)).toHaveLength(1);
    database.exec("DROP TRIGGER reject_product_activity"); database.close();
    const result = await post(user, `product-imports/${draft.id}/commit`, { decisions: [{ row: 2, action: "new" }, { row: 3, action: "skip" }] }).expect(200);
    expect(result.body.result).toMatchObject({ imported: 1, skipped: 1 });
  });

  it("upgrades a populated v2 database without losing previous scans or activities", async () => {
    await store.close();
    const legacy = join(directory, "legacy.sqlite");
    const database = new Database(legacy);
    database.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)");
    for (const migration of migrations.slice(0, 2)) { database.exec(migration.sql); database.prepare("INSERT INTO schema_migrations VALUES (?)").run(migration.version); }
    const user = randomUUID(), business = randomUUID(), evidence = randomUUID(), scan = randomUUID();
    database.prepare("INSERT INTO users VALUES (?,'Fixture','fixture@example.test','unused')").run(user);
    database.prepare("INSERT INTO businesses VALUES (?,?,'Fixture','','','',?,?)").run(business, user, timestamp, timestamp);
    database.prepare("INSERT INTO evidence VALUES (?,?,'website','https://shop.example.com/','Legacy content',?)").run(evidence, business, timestamp);
    database.prepare("INSERT INTO activities VALUES (?,?,?,'website.scanned',?)").run(randomUUID(), business, evidence, timestamp);
    database.prepare("INSERT INTO website_scans VALUES (?,?,'https://shop.example.com/','complete',?,?,0,?)").run(scan, business, timestamp, timestamp, JSON.stringify({ requestedUrl: "https://shop.example.com/", status: "complete", startedAt: timestamp, completedAt: timestamp, pages: [], failures: [], notes: [] }));
    database.close();
    store = openStore(legacy);
    expect((await store.listActivity(user, business))[0].action).toBe("website.scanned");
    expect((await store.getScan(user, business, scan))?.id).toBe(scan);
    expect(await store.listProducts(user, business)).toEqual([]);
  });
});
