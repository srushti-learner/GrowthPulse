import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type Store } from "./database.js";
import { newSession } from "./auth.js";
import { createApp } from "./app.js";
import { createResearchAgent } from "./research-agent.js";
import { createTavilySearch } from "./tavily-mcp.js";
import { createWebsiteScanner, type WebsiteScanner } from "./website-scanner.js";
import { importMarketplaceCsv, marketplaceUrl } from "./marketplace-research.js";
import { marketplaceResponseSchema, type MarketplaceReport } from "../shared/marketplace.js";
import { emptyProduct } from "../shared/products.js";
import { productFingerprint } from "./product-intelligence.js";
import { AgentError, type AgentModel } from "./business-agent.js";

const origin = "http://127.0.0.1:5173";
const amazon = "https://www.amazon.in/dp/B000000001";
const flipkart = "https://www.flipkart.com/hair-oil/p/itmfixture1";
const csv = `product_url,title,review,rating,review_date,gtin
${amazon},Fixture hair oil,The bottle leaks during dispensing.,2,2026-10-01,4006381333931
${amazon},Fixture hair oil,Packaging leaks every time I pour.,1,2026-10-02,4006381333931
${flipkart},Other hair oil,The bottle is easy to dispense.,5,2026-10-03,
`;
describe("bounded marketplace research in the existing Market Intelligence agent", () => {
  let directory: string, path: string, store: Store, app: ReturnType<typeof createApp>;
  const searchCall = vi.fn();
  const complete = vi.fn<AgentModel>();
  const scanner = vi.fn<WebsiteScanner>();
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "gp-marketplace-")); path = join(directory, "test.sqlite"); store = openStore(path);
    searchCall.mockReset(); complete.mockReset(); scanner.mockReset();
    searchCall.mockImplementation(async (input: Record<string, unknown>) => ({ results: [
      { title: "Unverified search title", url: String(input.query).includes("amazon.in") ? `${amazon}?tag=tracking` : flipkart,
        content: "Search snippet claims 999999 orders. This is not accepted evidence." },
    ] }));
    complete.mockImplementation(async (input) => {
      const name = input.tool_choice?.type === "tool" ? input.tool_choice.name : "";
      const context = JSON.parse(String(input.messages[0].content));
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "fixture-tool", name, input: name === "plan_marketplace_search"
        ? { category: "hair oil" } : { themes: [{ title: "Possible dispensing issue", sentiment: "negative", scope: "own_product",
          reviewIds: context.reviews.filter((value: { relation: string }) => value.relation === "my_listing").map((value: { id: string }) => value.id),
          experiment: "Check packaging with the owner before testing a dispensing improvement." }] } }] };
    });
    const scan = createWebsiteScanner(async (url) => {
      if (url.pathname === "/robots.txt") return { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /" };
      return { status: 200, headers: { "content-type": "text/html" }, body: `<html><head><script type="application/ld+json">${JSON.stringify({
        "@type": "Product", name: url.hostname.includes("amazon") ? "Fixture hair oil" : "Other hair oil", description: "Published hair oil description.",
        url: url.href, gtin13: url.hostname.includes("amazon") ? "4006381333931" : "", size: "100 ml",
        offers: { price: "399", priceCurrency: "INR", seller: { name: "Published fixture seller" } },
        aggregateRating: { ratingValue: "4.2", reviewCount: 123 },
        review: [{ reviewBody: "The bottle leaks during dispensing.", datePublished: "2026-10-01", author: { name: "Private reviewer" }, reviewRating: { ratingValue: 2 } }],
      })}</script></head><body>Fixture product page for deterministic marketplace research. <a href="/recommendations">Other products</a></body></html>` };
    });
    scanner.mockImplementation(scan);
    app = createApp({ store, agent: createResearchAgent({ complete, scanner, search: createTavilySearch({ call: searchCall }) }) });
  });
  afterEach(async () => { await app.stopMarketplace(); await store.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });
  async function owner() {
    const user = { id: randomUUID(), name: "Fixture", email: `${randomUUID()}@example.test` }, session = newSession();
    await store.createAccount(user, "test fixture hash", session.tokenHash, session.expiresAt);
    const business = await store.saveBusiness(user.id, { name: "Fixture", category: "hair oil", description: "", website: "" });
    const product = await store.saveProduct(user.id, business.id, { ...emptyProduct, name: "Fixture hair oil", description: "An owner-described hair oil.", gtin: "4006381333931" });
    return { user, business, product, cookie: `gp_session=${session.token}`, endpoint: `/api/businesses/${business.id}/products/${product.id}/marketplace` };
  }
  function get(user: Awaited<ReturnType<typeof owner>>) { return request(app).get(user.endpoint).set("Cookie", user.cookie); }
  function post(user: Awaited<ReturnType<typeof owner>>, path: string, body: object) {
    return request(app).post(`${user.endpoint}${path}`).set("Cookie", user.cookie).set("Origin", origin).send(body);
  }
  async function finished(user: Awaited<ReturnType<typeof owner>>) {
    let result: ReturnType<typeof marketplaceResponseSchema.parse>;
    await vi.waitFor(async () => { result = marketplaceResponseSchema.parse((await get(user).expect(200)).body); expect(result.running).toBe(false); }, { timeout: 5000 });
    return result!;
  }
  function confirm(user: Awaited<ReturnType<typeof owner>>, saved: MarketplaceReport, index = 0, relation = "my_listing") {
    return request(app).patch(`${user.endpoint}/match`).set("Cookie", user.cookie).set("Origin", origin)
      .send({ reportId: saved.id, listingId: saved.listings[index].id, relation });
  }
  it("discovers both marketplaces with bounded search, reads one page per listing and never accepts snippets as evidence", async () => {
    const user = await owner(), requestKey = randomUUID();
    const pending = await post(user, "", { consent: true, requestKey }).expect(202);
    expect(pending.body.running).toBe(true);
    const saved = (await finished(user)).report!;
    expect(searchCall).toHaveBeenCalledTimes(4);
    expect(searchCall.mock.calls.every(([input]) => input.search_depth === "basic" && input.max_results === 5 && !input.include_raw_content)).toBe(true);
    expect(scanner).toHaveBeenCalledTimes(2);
    expect(scanner.mock.calls.every((call) => call[2]?.singlePage)).toBe(true);
    expect(saved.listings).toHaveLength(2);
    expect(saved.listings[0]).toMatchObject({ title: "Fixture hair oil", identifierMatch: true, relation: "unconfirmed", price: "399", currency: "INR", rating: 4.2, reviewCount: 123 });
    expect(saved.listings.flatMap((item) => item.reviews)).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toMatch(/999999|Private reviewer|Unverified search title/);
    expect(saved.themes).toEqual([]);
    await post(user, "", { consent: true, requestKey }).expect(200);
    for (let index = 0; index < 4; index++) await get(user).expect(200);
    expect(searchCall).toHaveBeenCalledTimes(4);
    expect(complete).toHaveBeenCalledOnce();
    expect((await store.listProducts(user.user.id, user.business.id))[0]).toEqual(user.product);
  });
  it("retains explicit coverage failures without fabricating review sentiment or silently broadening access", async () => {
    const user = await owner();
    scanner.mockResolvedValue({
      requestedUrl: amazon, status: "failed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      pages: [], failures: [{ url: amazon, message: "robots.txt does not allow GrowthPulseBot to read this page." }], notes: [],
    });
    await post(user, "", { consent: true, requestKey: randomUUID(), urls: [amazon] }).expect(202);
    const saved = (await finished(user)).report!;
    expect(saved.listings[0]).toMatchObject({ status: "unavailable", reviews: [], sources: [], reviewCount: null });
    expect(saved.listings[0].limitation).toContain("robots.txt");
    await confirm(user, saved).expect(400);
    expect(complete).not.toHaveBeenCalled(); expect(searchCall).not.toHaveBeenCalled();
  });
  it.each(["savoury snacks", "---"])("still searches the saved product when category %s cannot be grounded", async (category) => {
    const user = await owner();
    const product = await store.saveProduct(user.user.id, user.business.id, {
      ...emptyProduct, name: "Millet Bhujia - Pudina Masti - 100 gms",
    }, user.product.id);
    complete.mockResolvedValueOnce({ stop_reason: "tool_use", content: [{
      type: "tool_use", id: "category-fixture", name: "plan_marketplace_search", input: { category },
    }] });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await post(user, "", { consent: true, requestKey: randomUUID() }).expect(202);
    const result = await finished(user);
    expect(result.error).toBeNull();
    expect(searchCall.mock.calls.map(([input]) => input.query)).toEqual([
      `site:amazon.in ${product.name}`, `site:flipkart.com ${product.name}`,
    ]);
    expect(result.report!.limitations).toContain(
      "Comparable-product category searches were skipped because the proposed category was not supported by saved product details. Product-name searches still ran on both marketplaces.",
    );
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("category queries skipped"));
    expect(scanner).toHaveBeenCalledTimes(2);
    expect(result.report!.listings.every((item) => item.relation === "unconfirmed")).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
  });
  it("retries a saved failed attempt explicitly while retaining previous evidence until success", async () => {
    const user = await owner();
    const previous = (await post(user, "/import", { consent: true, csv }).expect(201)).body.report as MarketplaceReport;
    const requestKey = randomUUID();
    complete.mockRejectedValueOnce(new AgentError(502, "The marketplace search category was not grounded in your saved product. No search was made."));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await post(user, "", { consent: true, requestKey, refresh: true }).expect(202);
    const failed = await finished(user);
    expect(failed.error).toContain("category was not grounded");
    expect(failed.report).toEqual(previous);
    await get(user).expect(200);
    await post(user, "", { consent: true, requestKey, refresh: true }).expect(200);
    expect(complete).toHaveBeenCalledOnce();
    expect(searchCall).not.toHaveBeenCalled();
    await post(user, "", { consent: true, requestKey: randomUUID(), refresh: true }).expect(202);
    const recovered = await finished(user);
    expect(recovered.error).toBeNull();
    expect(recovered.report!.id).not.toBe(previous.id);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(searchCall).toHaveBeenCalledTimes(4);
  });
  it("does not substitute a single explicitly different recommended product for the requested listing", async () => {
    const user = await owner();
    const scan = createWebsiteScanner(async (url) => url.pathname === "/robots.txt"
      ? { status: 200, headers: {}, body: "User-agent: *\nAllow: /" }
      : { status: 200, headers: { "content-type": "text/html" }, body: `<html><script type="application/ld+json">${JSON.stringify({
        "@type": "Product", name: "Recommended item", url: "https://www.amazon.in/dp/B000000099",
        review: { reviewBody: "This other item must never be treated as evidence." },
      })}</script><body>Recommendations for another item, not the requested product.</body></html>` });
    scanner.mockImplementation(scan);
    await post(user, "", { consent: true, requestKey: randomUUID(), urls: [amazon] }).expect(202);
    const saved = (await finished(user)).report!;
    expect(saved.listings[0]).toMatchObject({ status: "unavailable", reviews: [], sources: [] });
    expect(JSON.stringify(saved)).not.toContain("This other item");
  });
  it("imports authorized reviews, requires confirmation, preserves own-product scope and saves analysis across restart", async () => {
    const user = await owner();
    const saved = (await post(user, "/import", { consent: true, csv }).expect(201)).body.report as MarketplaceReport;
    expect(saved.listings[0]).toMatchObject({ method: "owner_export", identifierMatch: true, rating: null, reviewCount: null });
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(400);
    await confirm(user, saved).expect(200);
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(202);
    const result = await finished(user);
    expect(result.report!.themes[0]).toMatchObject({ scope: "own_product", sentiment: "negative" });
    expect(complete).toHaveBeenCalledOnce();
    const context = JSON.parse(String(complete.mock.calls[0][0].messages[0].content));
    expect(context.reviewedCatalogue.description).toBe(user.product.description);
    expect(context.reviews).toHaveLength(2);
    expect(context.reviews.every((value: { relation: string }) => value.relation === "my_listing")).toBe(true);
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(200);
    expect(complete).toHaveBeenCalledOnce();
    await store.close(); store = openStore(path); app = createApp({ store });
    const reopened = marketplaceResponseSchema.parse((await get(user).expect(200)).body);
    expect(reopened).toMatchObject({ configured: false, report: result.report });
    expect((await store.listProducts(user.user.id, user.business.id))[0]).toEqual(user.product);
    expect(searchCall).not.toHaveBeenCalled(); expect(scanner).not.toHaveBeenCalled();
  });
  it("rejects invented or cross-scope review citations and retains the last accepted evidence on failure", async () => {
    const user = await owner();
    const saved = (await post(user, "/import", { consent: true, csv }).expect(201)).body.report as MarketplaceReport;
    await confirm(user, saved).expect(200);
    complete.mockResolvedValue({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "bad-fixture", name: "record_marketplace_themes",
      input: { themes: [{ title: "Unsupported", sentiment: "negative", scope: "alternatives", reviewIds: saved.listings[0].reviews.map((value) => value.id), experiment: "Do not accept this cross-scope claim." }] } }] });
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(202);
    const result = await finished(user);
    expect(result.error).toContain("distinct captured reviews");
    expect(result.report!.listings[0].relation).toBe("my_listing");
    expect(result.report!.themes).toEqual([]);
    await get(user).expect(200);
    expect(complete).toHaveBeenCalledOnce();
  });
  it("checks ownership, exact origin, consent, canonical product URLs and stale evidence", async () => {
    const alice = await owner(), bob = await owner();
    await request(app).get(alice.endpoint).expect(401);
    await request(app).get(alice.endpoint).set("Cookie", bob.cookie).expect(404);
    await request(app).get(`/api/businesses/${bob.business.id}/products/${alice.product.id}/marketplace`).set("Cookie", bob.cookie).expect(404);
    await request(app).post(alice.endpoint).set("Cookie", alice.cookie).send({ consent: true, requestKey: randomUUID() }).expect(403);
    await post(alice, "", { consent: false, requestKey: randomUUID() }).expect(400);
    for (const url of ["https://127.0.0.1/private", "https://amazon.in.evil.org/dp/B000000001", "https://user:pass@amazon.in/dp/B000000001", "https://www.amazon.in/ap/signin"]) {
      await post(alice, "", { consent: true, requestKey: randomUUID(), urls: [url] }).expect(400);
    }
    const saved = (await post(alice, "/import", { consent: true, csv }).expect(201)).body.report as MarketplaceReport;
    await store.saveProduct(alice.user.id, alice.business.id, { ...emptyProduct, name: "Changed evidence" }, alice.product.id);
    expect((await get(alice).expect(200)).body.stale).toBe(true);
    await confirm(alice, saved).expect(409);
    await post(alice, "/analyse", { consent: true, reportId: saved.id }).expect(409);
    expect(complete).not.toHaveBeenCalled(); expect(searchCall).not.toHaveBeenCalled();
  });
  it("deduplicates retries of background discovery while paid work is still running", async () => {
    const user = await owner(), requestKey = randomUUID();
    let resolve!: (value: Awaited<ReturnType<AgentModel>>) => void;
    complete.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await post(user, "", { consent: true, requestKey }).expect(202);
    await post(user, "", { consent: true, requestKey }).expect(200);
    await post(user, "", { consent: true, requestKey, refresh: true }).expect(409);
    expect(complete).toHaveBeenCalledOnce();
    resolve({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "plan-fixture", name: "plan_marketplace_search", input: { category: "hair oil" } }] });
    expect((await finished(user)).report).not.toBeNull();
    expect(complete).toHaveBeenCalledOnce();
  });
  it("starts paid work only once when equivalent requests overlap during async admission", async () => {
    const user = await owner(), requestKey = randomUUID();
    const original = store.beginMarketplace;
    let arrivals = 0, releaseAdmissions!: () => void;
    const admitted = new Promise<void>((resolve) => { releaseAdmissions = resolve; });
    vi.spyOn(store, "beginMarketplace").mockImplementation(async (...parameters) => {
      if (++arrivals === 2) releaseAdmissions();
      await admitted;
      return original(...parameters);
    });
    let finish!: (value: Awaited<ReturnType<AgentModel>>) => void;
    complete.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await Promise.all([
      post(user, "", { consent: true, requestKey }).expect(202),
      post(user, "", { consent: true, requestKey }).expect(202),
    ]);
    expect(complete).toHaveBeenCalledOnce();
    finish({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "plan-fixture", name: "plan_marketplace_search", input: { category: "hair oil" } }] });
    expect((await finished(user)).report).not.toBeNull();
    expect(complete).toHaveBeenCalledOnce();
  });
  it("keeps CSV normalization bounded, explicit, deduplicated and free of reviewer contact fields", async () => {
    const user = await owner();
    const imported = importMarketplaceCsv(user.product, `product_url,title,review\n${amazon},Fixture,"Email buyer@example.com about the bottle."\n${amazon},Fixture,"Email buyer@example.com about the bottle."\n`);
    expect(imported.listings[0].reviews).toHaveLength(1);
    expect(imported.listings[0].reviews[0].text).toContain("[email removed]");
    expect(JSON.stringify(imported)).not.toContain("buyer@example.com");
    expect(() => importMarketplaceCsv(user.product, `product_url,title,review,rating\n${amazon},Fixture,Review with enough text,8`)).toThrow("0 to 5");
    expect(() => importMarketplaceCsv(user.product, `product_url,title,review\n${amazon},Fixture,Review with enough text\n${amazon},Different,Another long review`)).toThrow("conflict");
    expect(() => importMarketplaceCsv(user.product, `product_url,title,review,author\n${amazon},Fixture,Review with enough text,Private name`)).toThrow("CSV");
    expect(() => importMarketplaceCsv(user.product, `product_url,title,review,review\n${amazon},Fixture,First review text,Second review text`)).toThrow("Duplicate");
    expect(imported.fingerprint).toBe(productFingerprint(user.product));
  });
  it("cancels in-flight provider work and persists its interruption before shutdown", async () => {
    const user = await owner();
    complete.mockImplementationOnce(async (_input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
    }));
    await post(user, "", { consent: true, requestKey: randomUUID() }).expect(202);
    await app.stopMarketplace();
    expect((await get(user).expect(200)).body).toMatchObject({ running: false, error: expect.stringContaining("interrupted") });
    expect(searchCall).not.toHaveBeenCalled();
  });
  it("canonicalizes supported listing paths without allowing tracking URLs to widen the public reader", () => {
    expect(marketplaceUrl("https://amazon.in/brand/gp/product/b000000001/ref=abc?tag=secret#reviews")).toBe(amazon);
    expect(marketplaceUrl(`${flipkart}?pid=VARIANT&tracking=secret`)).toBe(flipkart);
    expect(marketplaceUrl("https://www.amazon.in/s?k=oil")).toBeNull();
    expect(marketplaceUrl("http://www.amazon.in/dp/B000000001")).toBeNull();
    expect(marketplaceUrl("https://evil.amazon.in/dp/B000000001")).toBeNull();
  });
});
