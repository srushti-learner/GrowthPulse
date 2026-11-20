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
const comparativeCsv = `${csv}${flipkart},Other hair oil,The dispenser makes pouring simple.,5,2026-10-04,\n`;
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
      const payload = name === "plan_marketplace_search" ? { category: "hair oil" }
        : name === "match_marketplace_products" ? { matches: context.listings.map((item: { id: string; title: string }) => ({
          listingId: item.id,
          relation: item.title === context.catalogue.name ? "same_product" : context.catalogue.name.includes("hair oil") ? "alternative" : "unconfirmed",
          productEvidence: item.title === context.catalogue.name ? context.catalogue.name : "hair oil",
          listingEvidence: item.title === context.catalogue.name ? item.title : "hair oil",
          reason: "Captured product identity or shared hair-oil purpose; seller ownership is unknown.",
        })) } : { themes: [{ title: "Possible dispensing issue", sentiment: "negative", scope: "own_product",
          reviewIds: context.reviews.filter((value: { relation: string }) => ["my_listing", "other_seller", "same_product"].includes(value.relation)).map((value: { id: string }) => value.id),
          experiment: "Check packaging with the owner before testing a dispensing improvement." }] };
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "fixture-tool", name, input: payload }] };
    });
    const scan = createWebsiteScanner(async (url) => {
      if (url.pathname === "/robots.txt") return { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /" };
      return { status: 200, headers: { "content-type": "text/html" }, body: `<html><head><script type="application/ld+json">${JSON.stringify({
        "@type": "Product", name: url.hostname.includes("amazon") ? "Fixture hair oil" : "Other hair oil", description: "Published hair oil description.",
        url: url.href, gtin13: url.hostname.includes("amazon") ? "4006381333931" : "", size: "100 ml",
        brand: { name: url.hostname.includes("amazon") ? "Fixture" : "Other" }, model: "Oil100",
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
  function comparisonResult(saved: MarketplaceReport) {
    return { title: "Dispensing experience",
      ownProduct: { summary: "Sampled reviewers describe leaking bottles.", reviewIds: saved.listings[0].reviews.map((value) => value.id) },
      alternatives: { summary: "Comparable-product reviewers praise easy dispensing.", reviewIds: saved.listings[1].reviews.map((value) => value.id) },
      opportunity: "Explore whether a different dispenser addresses the reported pouring problems.",
      experiment: "Test both dispensers with a small group and record leaks and ease of pouring." };
  }
  function analysisWithComparison(saved: MarketplaceReport, comparison = comparisonResult(saved)) {
    const original = complete.getMockImplementation()!;
    complete.mockImplementation(async (input, signal) => {
      if (input.tool_choice?.type !== "tool" || input.tool_choice.name !== "record_marketplace_themes") return original(input, signal);
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "comparison-fixture", name: "record_marketplace_themes",
        input: { themes: [], comparisons: [comparison] } }] };
    });
  }
  it.each([
    ["1 kg", "1000 g", "same_product"],
    ["100 ml", "200 ml", "unconfirmed"],
    ["100 ml", "100 ml; 200 ml", "unconfirmed"],
    ["100 ml red", "100 ml blue", "unconfirmed"],
    ["Pack of 1, 100 ml", "Pack of 2, 100 ml", "unconfirmed"],
  ])("checks GTIN pack/variant compatibility: %s versus %s", async (variant, captured, relation) => {
    const user = await owner();
    const product = await store.saveProduct(user.user.id, user.business.id, {
      ...emptyProduct, name: "Fixture product", gtin: user.product.gtin, variants: variant,
    }, user.product.id);
    const saved = importMarketplaceCsv(product, `product_url,title,review,gtin,variants\n${amazon},Fixture product,The dispenser is easy to use.,${product.gtin},"${captured}"`);
    expect(saved.listings[0]).toMatchObject({ identifierMatch: true, relation });
    expect(complete).not.toHaveBeenCalled();
  });
  it("automatically matches a specific sourced name without a GTIN and keeps owner corrections authoritative", async () => {
    const user = await owner();
    const saved = (await post(user, "/import", { consent: true,
      csv: `product_url,title,review\n${amazon},Fixture hair oil,The bottle leaks during dispensing.\n${amazon},Fixture hair oil,Packaging leaks every time I pour.\n`,
    }).expect(201)).body.report as MarketplaceReport;
    expect(saved.listings[0].relation).toBe("unconfirmed");
    expect(complete).not.toHaveBeenCalled();
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(202);
    const analysed = (await finished(user)).report!;
    expect(analysed.listings[0]).toMatchObject({ relation: "same_product", matching: { method: "ai", productEvidence: user.product.name } });
    expect(analysed.themes).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(2);
    const corrected = (await confirm(user, analysed, 0, "excluded").expect(200)).body.report as MarketplaceReport;
    expect(corrected).toMatchObject({ themes: [], comparisons: [], analysedAt: null, listings: [{ relation: "excluded", matching: { method: "owner" } }] });
    await post(user, "/analyse", { reportId: corrected.id, consent: true }).expect(400);
    await get(user).expect(200);
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it.each(["Fixture", "Other"])("uses captured brand identity for a short product name, without accepting a conflicting %s brand", async (brand) => {
    const user = await owner();
    await store.saveProduct(user.user.id, user.business.id, { ...emptyProduct, name: "Fixture oil", description: "Hair oil." }, user.product.id);
    const saved = (await post(user, "/import", { consent: true, csv: `product_url,title,review,brand
${amazon},Fixture oil,The bottle leaks during dispensing.,${brand}
${amazon},Fixture oil,Packaging leaks every time I pour.,${brand}
` }).expect(201)).body.report as MarketplaceReport;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(202);
    const result = await finished(user);
    if (brand === "Fixture") {
      expect(result.error).toBeNull();
      expect(result.report!.listings[0]).toMatchObject({ relation: "same_product", brand: "Fixture", matching: { method: "ai" } });
      expect(complete).toHaveBeenCalledTimes(2);
    } else {
      expect(result.error).toContain("Automatic matching could not find two relevant");
      expect(result.report!.listings[0].relation).toBe("unconfirmed");
      expect(complete).toHaveBeenCalledOnce();
    }
  });
  it("matches a reordered or expanded product title using captured identifying fragments, not an exact whole-title requirement", async () => {
    const user = await owner();
    const saved = (await post(user, "/import", { consent: true, csv: `product_url,title,review,brand
${amazon},Fixture enriched hair oil,The bottle leaks during dispensing.,Fixture
${amazon},Fixture enriched hair oil,Packaging leaks every time I pour.,Fixture
` }).expect(201)).body.report as MarketplaceReport;
    const original = complete.getMockImplementation()!;
    complete.mockImplementation(async (input, signal) => {
      if (input.tool_choice?.type !== "tool" || input.tool_choice.name !== "match_marketplace_products") return original(input, signal);
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "expanded-name", name: "match_marketplace_products",
        input: { matches: [{ listingId: saved.listings[0].id, relation: "same_product",
          productEvidence: "Fixture hair oil", listingEvidence: "Fixture enriched hair oil", reason: "Matching named product and purpose; seller ownership unknown." }] } }] };
    });
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(202);
    expect((await finished(user)).report!.listings[0]).toMatchObject({ relation: "same_product", matching: { method: "ai" } });
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it.each(["unknown-listing", "duplicate-listing", "invented-quote", "category-only-identity"])(
    "keeps unsupported %s decisions out of automatically matched feedback", async (failure) => {
      const user = await owner(), saved = (await post(user, "/import", { consent: true, csv }).expect(201)).body.report as MarketplaceReport;
      const original = complete.getMockImplementation()!;
      complete.mockImplementation(async (input, signal) => {
        if (input.tool_choice?.type !== "tool" || input.tool_choice.name !== "match_marketplace_products") return original(input, signal);
        const proposal = { listingId: failure === "unknown-listing" ? "m_0000000000000000" : saved.listings[1].id,
          relation: failure === "category-only-identity" ? "same_product" : "alternative",
          productEvidence: failure === "invented-quote" ? "Invented product purpose" : "hair oil", listingEvidence: "hair oil", reason: "Unverified fixture proposal." };
        return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "invalid-match", name: "match_marketplace_products",
          input: { matches: failure === "duplicate-listing" ? [proposal, proposal] : [proposal] } }] };
      });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(202);
      const result = (await finished(user)).report!;
      expect(result.listings[1].relation).toBe("unconfirmed");
      expect(result.limitations.join(" ")).toContain("could not be supported");
      expect(warning).toHaveBeenCalledWith("Marketplace automatic matches omitted:", expect.any(Object));
      expect(result.themes[0].reviewIds).toEqual(saved.listings[0].reviews.map((value) => value.id));
    });
  it("saves a cross-product comparison with original review references and invalidates it after an owner correction", async () => {
    const user = await owner(), saved = (await post(user, "/import", { consent: true, csv: comparativeCsv }).expect(201)).body.report as MarketplaceReport;
    analysisWithComparison(saved);
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(202);
    const result = (await finished(user)).report!;
    expect(result.comparisons).toEqual([comparisonResult(saved)]);
    expect(result).toMatchObject({ analysisVersion: 2, matchingVersion: 1 });
    expect(result.listings.map((value) => value.relation)).toEqual(["same_product", "alternative"]);
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(200);
    expect(complete).toHaveBeenCalledTimes(2);
    expect((await get(user).expect(200)).body.report.comparisons).toEqual(result.comparisons);
    const corrected = (await confirm(user, result, 1, "unconfirmed").expect(200)).body.report as MarketplaceReport;
    expect(corrected).toMatchObject({ comparisons: [], themes: [], analysedAt: null });
    expect(corrected.listings[1].matching?.method).toBe("owner");
    const original = complete.getMockImplementation()!;
    complete.mockImplementation(async (input, signal) => {
      if (input.tool_choice?.type === "tool" && input.tool_choice.name === "record_marketplace_themes") {
        return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "single-sided", name: "record_marketplace_themes", input: { themes: [], comparisons: [] } }] };
      }
      return original(input, signal);
    });
    await post(user, "/analyse", { reportId: corrected.id, consent: true }).expect(202);
    expect((await finished(user)).report!.listings[1].relation).toBe("unconfirmed");
    expect(complete).toHaveBeenCalledTimes(3);
  });
  it.each(["unknown-review", "duplicate-review", "cross-scope", "unsupported-price"])("rejects %s comparison evidence without changing saved sources", async (failure) => {
    const user = await owner(), saved = (await post(user, "/import", { consent: true, csv: comparativeCsv }).expect(201)).body.report as MarketplaceReport;
    const comparison = comparisonResult(saved);
    if (failure === "unknown-review") comparison.ownProduct.reviewIds[0] = "r_0000000000000000";
    if (failure === "duplicate-review") comparison.ownProduct.reviewIds[1] = comparison.ownProduct.reviewIds[0];
    if (failure === "cross-scope") comparison.alternatives.reviewIds = [...comparison.ownProduct.reviewIds];
    if (failure === "unsupported-price") comparison.opportunity = "This product is 50% cheaper and has a price advantage.";
    analysisWithComparison(saved, comparison);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(202);
    const result = await finished(user);
    expect(result.error).toContain("customer comparison");
    expect(result.report).toEqual(saved);
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it.each(["own-product", "alternatives"])("analyses %s-only samples without manufacturing the other side", async (scope) => {
    const user = await owner();
    const saved = (await post(user, "/import", { consent: true, csv: comparativeCsv }).expect(201)).body.report as MarketplaceReport;
    await confirm(user, saved, scope === "own-product" ? 1 : 0, "excluded").expect(200);
    if (scope === "alternatives") await confirm(user, saved, 1, "alternative").expect(200);
    complete.mockResolvedValue({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "one-side", name: "record_marketplace_themes",
      input: { themes: [{ title: "Dispensing feedback", scope: scope === "own-product" ? "own_product" : "alternatives", sentiment: "mixed",
        reviewIds: saved.listings[scope === "own-product" ? 0 : 1].reviews.map((value) => value.id), experiment: "Ask a small group about dispensing." }], comparisons: [] } }] });
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(202);
    const result = (await finished(user)).report!;
    expect(result.comparisons).toEqual([]);
    expect(result.themes[0].scope).toBe(scope === "own-product" ? "own_product" : "alternatives");
    expect(complete).toHaveBeenCalledOnce();
  });
  it("loads and explicitly upgrades legacy analysis without changing owner-selected matches", async () => {
    const user = await owner(), saved = importMarketplaceCsv(user.product, comparativeCsv);
    delete saved.comparisons;
    for (const item of saved.listings) delete item.matching;
    saved.listings[0].relation = "my_listing";
    saved.listings[1].relation = "alternative";
    saved.analysedAt = new Date().toISOString();
    const pending = await store.beginMarketplace(user.user.id, user.business.id, user.product.id, saved.fingerprint, randomUUID(), "legacy-fixture");
    await store.finishMarketplace(user.user.id, user.business.id, user.product.id, pending.id, saved);
    expect((await get(user).expect(200)).body.report.comparisons).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
    analysisWithComparison(saved);
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(202);
    const result = (await finished(user)).report!;
    expect(result.comparisons).toHaveLength(1);
    expect(result.listings.map((item) => item.relation)).toEqual(["my_listing", "alternative"]);
    expect(complete).toHaveBeenCalledOnce();
  });
  it("uses the latest saved customer report, excludes active refreshes and stale products, and keeps failed attempts separate", async () => {
    const user = await owner(), report = importMarketplaceCsv(user.product, csv);
    report.listings[0].relation = "my_listing";
    report.analysedAt = new Date().toISOString();
    report.themes = [{ title: "Possible dispensing issue", scope: "own_product", sentiment: "negative",
      reviewIds: report.listings[0].reviews.map((review) => review.id), experiment: "Check seals before a small packaging test." }];
    async function save(value: MarketplaceReport) {
      const pending = await store.beginMarketplace(user.user.id, user.business.id, user.product.id, value.fingerprint, randomUUID(), "fixture");
      await store.finishMarketplace(user.user.id, user.business.id, user.product.id, pending.id, value);
    }
    const evidence = () => store.customerResearchEvidence(user.user.id, user.business.id);
    await save(report);
    expect((await evidence()).findings).toHaveLength(1);
    const pending = await store.beginMarketplace(user.user.id, user.business.id, user.product.id, report.fingerprint, randomUUID(), "refresh");
    expect(await evidence()).toMatchObject({ findings: [], limitations: expect.arrayContaining([expect.stringContaining("1 being refreshed")]) });
    await store.failMarketplace(user.user.id, user.business.id, user.product.id, pending.id, "Fixture collection failed.");
    expect((await evidence()).findings).toHaveLength(1);
    await save({ ...report, id: randomUUID(), analysedAt: null, themes: [] });
    expect(await evidence()).toMatchObject({ findings: [], limitations: expect.arrayContaining([expect.stringContaining("1 unanalysed")]) });
    await save(report);
    await store.saveProduct(user.user.id, user.business.id, {
      ...emptyProduct, name: "Changed reviewed product", description: user.product.description, gtin: user.product.gtin,
    }, user.product.id);
    expect(await evidence()).toMatchObject({ findings: [], limitations: expect.arrayContaining([expect.stringContaining("1 catalogue-stale")]) });
    expect(complete).not.toHaveBeenCalled(); expect(searchCall).not.toHaveBeenCalled(); expect(scanner).not.toHaveBeenCalled();
  });

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
    expect(saved.listings[0]).toMatchObject({ title: "Fixture hair oil", identifierMatch: true, relation: "same_product", matching: { method: "identifier" }, price: "399", currency: "INR", rating: 4.2, reviewCount: 123 });
    expect(saved.listings[0]).toMatchObject({ brand: "Fixture", model: "Oil100" });
    expect(saved.listings[1]).toMatchObject({ relation: "alternative", matching: { method: "ai", productEvidence: "hair oil", listingEvidence: "hair oil" } });
    expect(saved.listings.flatMap((item) => item.reviews)).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toMatch(/999999|Private reviewer|Unverified search title/);
    expect(saved.themes).toEqual([]);
    await post(user, "", { consent: true, requestKey }).expect(200);
    for (let index = 0; index < 4; index++) await get(user).expect(200);
    expect(searchCall).toHaveBeenCalledTimes(4);
    expect(complete).toHaveBeenCalledTimes(2);
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
  it("collects exact-listing static reviews, redacts them and automatically matches specific product names before explicit analysis", async () => {
    const user = await owner();
    const scan = createWebsiteScanner(async (url) => url.pathname === "/robots.txt"
      ? { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /" }
      : { status: 200, headers: { "content-type": "text/html" }, body: `<html><body>
        <input id="ASIN" value="B000000001"><h1 id="productTitle">Fixture hair oil</h1>
        <div id="cm-cr-dp-review-list">${["The dispenser leaks, contact buyer@example.com.", "The dispenser leaks, contact buyer@example.com.", "I find the bottle difficult to pour."].map((text) =>
          `<article data-hook="review"><span class="a-profile-name">Private buyer</span><div data-hook="review-body">${text}</div></article>`).join("")}</div>
        </body></html>` });
    scanner.mockImplementation(scan);
    await post(user, "", { consent: true, requestKey: randomUUID(), urls: [amazon] }).expect(202);
    const result = await finished(user);
    expect(result.progress).toBeNull();
    const saved = result.report!;
    expect(saved.listings[0]).toMatchObject({ status: "captured", title: "Fixture hair oil", relation: "same_product", matching: { method: "ai" }, rating: null, reviewCount: null });
    expect(saved.listings[0].reviews).toHaveLength(2);
    expect(saved.listings[0].reviews[0]).toMatchObject({ text: "The dispenser leaks, contact [email removed].", rating: null, date: null });
    expect(JSON.stringify(saved)).not.toMatch(/Private buyer|buyer@example/);
    expect(complete).toHaveBeenCalledOnce();
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(202);
    expect((await finished(user)).report!.themes).toHaveLength(1);
  });
  it("persists actual collection progress per product and keeps saved evidence available while work runs", async () => {
    const user = await owner(), other = await owner();
    const previous = (await post(user, "/import", { consent: true, csv }).expect(201)).body.report as MarketplaceReport;
    const original = scanner.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    scanner.mockImplementation(async (...parameters) => { await gate; return original(...parameters); });
    try {
      await post(user, "", { consent: true, requestKey: randomUUID(), urls: [amazon], refresh: true }).expect(202);
      await vi.waitFor(async () => {
        expect((await get(user)).body.progress).toEqual({
          stage: "collecting", completed: 0, total: 1,
          startedAt: expect.any(String), updatedAt: expect.any(String),
        });
      });
      const reopened = openStore(path);
      try {
        const persisted = await reopened.marketplaceState(user.user.id, user.business.id, user.product.id, productFingerprint(user.product));
        expect(persisted).toMatchObject({ running: true, progress: { stage: "collecting", completed: 0, total: 1 }, report: previous });
      } finally { await reopened.close(); }
      expect((await get(other)).body.progress).toBeNull();
    } finally { release(); }
    expect((await finished(user)).progress).toBeNull();
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
    expect(complete).toHaveBeenCalledTimes(2);
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
    expect(complete).toHaveBeenCalledTimes(3);
    expect(searchCall).toHaveBeenCalledTimes(4);
  });
  it("does not substitute a single explicitly different recommended product for the requested listing", async () => {
    const user = await owner();
    const scan = createWebsiteScanner(async (url) => url.pathname === "/robots.txt"
      ? { status: 200, headers: {}, body: "User-agent: *\nAllow: /" }
      : { status: 200, headers: { "content-type": "text/html" }, body: `<html><script type="application/ld+json">${JSON.stringify({
        "@type": "Product", name: "Recommended item", url: "https://www.amazon.in/dp/B000000099",
        review: { reviewBody: "This other item must never be treated as evidence." },
      })}</script><body><input id="ASIN" value="B000000001"><h1 id="productTitle">Fixture hair oil</h1>
      <div id="cm-cr-dp-review-list"><article data-hook="review"><div data-hook="review-body">Visible review must not override contradictory product identity.</div></article></div>
      Recommendations for another item, not the requested product.</body></html>` });
    scanner.mockImplementation(scan);
    await post(user, "", { consent: true, requestKey: randomUUID(), urls: [amazon] }).expect(202);
    const saved = (await finished(user)).report!;
    expect(saved.listings[0]).toMatchObject({ status: "unavailable", reviews: [], sources: [] });
    expect(JSON.stringify(saved)).not.toContain("This other item");
    expect(JSON.stringify(saved)).not.toContain("Visible review");
  });
  it("imports authorized reviews, automatically matches GTINs, preserves scope and saves analysis across restart", async () => {
    const user = await owner();
    const saved = (await post(user, "/import", { consent: true, csv }).expect(201)).body.report as MarketplaceReport;
    expect(saved.listings[0]).toMatchObject({ method: "owner_export", identifierMatch: true, rating: null, reviewCount: null });
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(202);
    const result = await finished(user);
    expect(result.report!.themes[0]).toMatchObject({ scope: "own_product", sentiment: "negative" });
    expect(complete).toHaveBeenCalledTimes(2);
    const context = JSON.parse(String(complete.mock.calls[1][0].messages[0].content));
    expect(context.reviewedCatalogue.description).toBe(user.product.description);
    expect(context.reviews).toHaveLength(3);
    expect(context.reviews.filter((value: { relation: string }) => value.relation === "same_product")).toHaveLength(2);
    expect(result.report).toMatchObject({ analysisVersion: 2, matchingVersion: 1, comparisons: [] });
    await post(user, "/analyse", { reportId: saved.id, consent: true }).expect(200);
    expect(complete).toHaveBeenCalledTimes(2);
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
    await confirm(user, saved, 1, "excluded").expect(200);
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
    expect(complete).toHaveBeenCalledTimes(2);
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
    expect(complete).toHaveBeenCalledTimes(2);
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
