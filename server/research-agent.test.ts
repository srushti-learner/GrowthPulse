import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { openStore, type Store } from "./database.js";
import { createAnalysisWorker } from "./analysis-worker.js";
import { createResearchAgent } from "./research-agent.js";
import { assessBrand, categoryEvidenceMatches, planDiscovery, validateDiscoveryPlan } from "./competitor-research.js";
import { createTavilySearch } from "./tavily-mcp.js";
import { ResearchLimit, ResearchStopped } from "./research-store.js";
import { researchEvidence, researchProducts, compareResearchProducts } from "./research-products.js";
import { researchLimits, type ResearchStep } from "../shared/research.js";
import type { ScanResult } from "../shared/website.js";
import type { AgentMessage, AgentModel } from "./business-agent.js";
import { createApp } from "./app.js";
import { newSession } from "./auth.js";
import { claimWorkSlot } from "./work-slots.js";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";

const url = "https://shop.example.com/";
const timestamp = "2026-11-16T12:00:00.000Z";
const quote = "We make cotton clothing for everyday wear.";
function scanAt(destination = url, price = "20.00", brandName?: string): ScanResult {
  const brand = brandName ?? (destination === url ? "Fixture shop" : new URL(destination).hostname.split(".")[0]);
  return {
    requestedUrl: destination, status: "complete", startedAt: timestamp, completedAt: timestamp,
    pages: [{
      url: destination, capturedAt: timestamp, title: `${brand} | Cotton clothing store`, description: quote,
      text: `${quote} ${brand} is an independent cotton clothing brand shipping across India.`,
      headings: [], contacts: [], callsToAction: [], links: [], warnings: [],
      productJson: [JSON.stringify({ "@type": "Product", name: "Cotton everyday tee", brand, sku: "TEE-1", gtin13: "4006381333931",
        offers: { "@type": "Offer", price, priceCurrency: "USD" } })],
    }],
    failures: [], notes: [],
  };
}
function tool(name: string, input: unknown): AgentMessage {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `tool_${name}`, name, input }] };
}

describe("durable specialist research orchestration", () => {
  let directory: string, path: string, store: Store;
  let worker: ReturnType<typeof createAnalysisWorker>;
  let failStore: boolean, failFirstRival: boolean, invalidFinding: boolean, overlongAction: boolean;
  let complete: ReturnType<typeof vi.fn<AgentModel>>;
  const searchCall = vi.fn();
  const scanner = vi.fn(async (destination: string) => {
    if (failFirstRival && destination === "https://rival.example.org/") return { ...scanAt(destination), status: "failed" as const, pages: [] };
    return scanAt(destination, destination === url ? "20.00" : "25.00");
  });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "gp-research-")); path = join(directory, "test.sqlite");
    store = openStore(path); failStore = false; failFirstRival = false; invalidFinding = false; overlongAction = false;
    scanner.mockClear(); searchCall.mockReset();
    searchCall.mockResolvedValue({ results: [
      { url: "https://rival.example.org/", title: "Cotton clothing rival" },
      { url: "https://second.example.org/", title: "Another cotton clothing rival" },
    ] });
    complete = vi.fn<AgentModel>().mockImplementation(async (input) => {
      const name = input.tool_choice?.type === "tool" ? input.tool_choice.name : "";
      if (name === "scan_website") return tool(name, {});
      if (name === "plan_market_search") {
        type Evidence = { sources: { id: string; quote: string }[] };
        const context = JSON.parse(String(input.messages[0].content)) as Evidence | { evidence: Evidence };
        const { sources } = "sources" in context ? context : context.evidence;
        return tool(name, { categories: [{ term: "cotton clothing", sourceId: sources.find((source) => source.quote === quote)!.id }],
          market: { term: "India", sourceId: sources.find((source) => source.quote.includes("shipping across India"))!.id } });
      }
      if (name === "select_candidates") return tool(name, { indices: [0, 1] });
      if (name === "shorten_business_fields") return tool(name, { fields: [{ path: "briefing.nextSteps.0.action", text: "Verify the current product details." }] });
      if (name === "verify_brand") {
        const { candidate: context } = JSON.parse(String(input.messages[0].content)) as { candidate: { url: string; sources: { id: string; quote: string }[] } };
        const brand = context.sources.find((source) => source.quote.endsWith(" | Cotton clothing store"))!.quote.split(" | ")[0];
        const source = context.sources.find((source) => source.quote === quote)!;
        return tool(name, {
          candidateOwnBrandStore: true, sameBrandAsMerchant: false, name: brand,
          brandSourceId: context.sources.find((source) => source.quote.startsWith(`${brand} |`))!.id,
          categorySourceId: source.id,
          marketSourceId: context.sources.find((source) => source.quote.includes("shipping across India"))!.id,
          facts: [{ dimension: "products", text: quote, sourceId: source.id }], limitations: [],
        });
      }
      if (name === "propose_business") {
        if (failStore) return tool(name, { briefing: {}, suggestions: [] });
        const content = input.messages.at(-1)?.content;
        const result = Array.isArray(content) ? content.find((block) => block.type === "tool_result") : undefined;
        if (result?.type !== "tool_result" || typeof result.content !== "string") throw new Error("Missing scanner evidence in test model.");
        const captured = JSON.parse(result.content) as { pages: { excerpts: { id: string; quote: string }[] }[] };
        const sources = [captured.pages.flatMap((page) => page.excerpts).find((source) => source.quote === quote)!.id];
        return tool(name, {
          briefing: {
            summary: { text: "This store presents cotton clothing.", sources },
            insights: [{ area: "offering", text: "The public range includes cotton clothing.", whyItMatters: "The fabric is part of the stated offer.", sources }],
            unknowns: [{ question: "What do shoppers actually buy?", whyItMatters: "Private sales evidence is unavailable." }],
            nextSteps: [{ action: overlongAction ? "Verify the current product details before planning a new campaign. ".repeat(6) : "Verify the current product details.", reason: "Published information can change." }],
          }, suggestions: [],
        });
      }
      const context = JSON.parse(String(input.messages[0].content)) as { sources: { id: string; url: string }[] };
      const competitor = typeof input.system === "string" && input.system.includes("Study captured");
      const source = context.sources.find((source) => !competitor || source.url !== url)!;
      const finding = { kind: "suggestion", title: competitor ? "Compare the captured product descriptions" : "Test clearer material descriptions",
        detail: "Verify the published cotton details before running a small merchandising test.", sourceIds: [source.id] };
      return tool("record_findings", {
        findings: invalidFinding ? [finding, { ...finding, title: "Unsupported finding", sourceIds: ["e_0000000000000000"] }] : [finding],
        limitations: ["The captured pages do not establish demand or sales."],
      });
    });
    worker = createAnalysisWorker({ store, scanner, agent: createResearchAgent({ complete, scanner, search: createTavilySearch({ call: searchCall }) }) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    await worker.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks();
  });
  function owner() {
    const user = { id: randomUUID(), name: "Research owner", email: `${randomUUID()}@example.test` };
    const session = newSession();
    store.createAccount(user, "test-only hash", session.tokenHash, session.expiresAt);
    const business = store.saveBusiness(user.id, { name: "Owner supplied name", website: url, category: "", description: "Private profile notes must not be sent" })!;
    return { id: user.id, business, cookie: `gp_session=${session.token}` };
  }
  function enqueue(user: ReturnType<typeof owner>, research = true, scanId?: string, resumeJobId?: string) {
    return store.enqueueAnalysis(user.id, user.business.id, randomUUID(), url, scanId, research, resumeJobId);
  }
  function job(user: ReturnType<typeof owner>, id: string) { return store.getAnalysisJob(user.id, user.business.id, id)!; }

  it("runs the graph, studies competitor products, checkpoints and saves each role without applying owner changes", async () => {
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const result = job(user, first.id), report = result.research!;
    expect(result.status).toBe("completed");
    expect(report.steps.map((step) => step.key)).toEqual(expect.arrayContaining([
      "store", "discovery", "competitor-site-0", "competitor-site-1", "competitor", "customer", "pricing", "opportunity", "growth",
    ]));
    expect(report.usage).toEqual({ searches: 3, competitorScans: 2, modelCalls: 9 });
    expect(report.steps.filter((step) => step.profile).map((step) => step.profile!.name)).toEqual(["rival", "second"]);
    expect(report.steps.find((step) => step.key === "competitor-site-0")!.capture).toEqual({ url: "https://rival.example.org/", pages: 1 });
    expect(report.steps.find((step) => step.key === "competitor")!.findings[0].sources[0].url).not.toBe(url);
    expect(report.steps.find((step) => step.agent === "customer")).toMatchObject({ status: "limited", findings: [] });
    expect(report.steps.find((step) => step.key === "pricing")!.findings[0].detail).toContain("share a GTIN");
    expect(result.understanding!.research).toEqual(report);
    expect(store.getBusiness(user.id, user.business.id)).toEqual(user.business);
    expect(store.listProducts(user.id, user.business.id)).toEqual([]);
    expect(JSON.stringify(complete.mock.calls)).not.toContain(user.business.description);
    expect(JSON.stringify(searchCall.mock.calls)).not.toContain(user.business.description);
    expect(complete.mock.calls.filter(([input]) => input.tool_choice?.type === "tool" && input.tool_choice.name === "record_findings")
      .every(([input]) => String(input.messages[0].content).length <= researchLimits.contextCharacters)).toBe(true);
    const checkpoint = await store.researchCheckpointer.getTuple({ configurable: { thread_id: first.id } });
    expect(checkpoint!.checkpoint.channel_values.done).toEqual(expect.arrayContaining(["coordinate", "growth", "store"]));
    expect(JSON.stringify(checkpoint)).not.toContain(quote);
  });

  it.each([
    ["Ayurvedic Hair & Skin Care", "Ayurvedic hair care", true],
    ["Hair care with Ayurvedic oils", "Ayurvedic hair care", true],
    ["ANTI–HAIR FALL OIL & SHAMPOO", "anti-hair fall oil and shampoo", true],
    ["Cotton clothing", "cotton clothing", true],
    ["Ayurvedic skin care", "Ayurvedic hair care", false],
    ["Boiled ingredients for clothing", "oil clothing", false],
    ["Hair styling products", "Ayurvedic hair care", false],
    ["The store", "and or the", false],
  ])("matches complete category words without requiring identical phrasing: %s", (quote, category, expected) => {
    expect(categoryEvidenceMatches(quote, category)).toBe(expected);
  });

  it.each([
    ["Ayurvedic Hair & Skin Care", "Ayurvedic hair care"],
    ["Hair care with Ayurvedic oils", "Ayurvedic hair care"],
    ["ANTI–HAIR FALL OIL & SHAMPOO", "anti-hair fall oil and shampoo"],
  ])("grounds discovery words despite harmless phrasing differences: %s", (quote, term) => {
    const source = { id: "e_1111111111111111", url, quote, capturedAt: timestamp };
    const plan = { categories: [{ term, sourceId: source.id }], market: null };
    expect(validateDiscoveryPlan(plan, [source])).toEqual({ plan, omittedPaths: [] });
  });

  it.each([
    { term: "silk clothing", sourceId: "e_1111111111111111", path: "categories.1.term" },
    { term: "cotton clothing", sourceId: "e_0000000000000000", path: "categories.1.sourceId" },
    { term: "cotton site:clothing", sourceId: "e_1111111111111111", path: "categories.1.term" },
    { term: "and or the", sourceId: "e_1111111111111111", path: "categories.1.term" },
  ])("retains a grounded category while omitting $term with its diagnostic", ({ term, sourceId, path }) => {
    const source = { id: "e_1111111111111111", url, quote: `${quote} cotton site:clothing`, capturedAt: timestamp };
    const category = { term: "cotton clothing", sourceId: source.id };
    expect(validateDiscoveryPlan({ categories: [category, { term, sourceId }], market: null }, [source]))
      .toEqual({ plan: { categories: [category], market: null }, omittedPaths: [path] });
  });

  it.each([
    { quote: "Cotton clothing shipping across India.", term: "India", valid: true },
    { quote: "Cotton clothing shipping across North India.", term: "North India", valid: true },
    { quote: "Cotton clothing shipping across North India.", term: "India North", valid: false },
    { quote: "Indian cotton clothing.", term: "India", valid: false },
    { quote: "Cotton clothing priced in INR.", term: "INR", valid: false },
    { quote: "Cotton clothing priced in ＩＮＲ.", term: "ＩＮＲ", valid: false },
    { quote: "Cotton clothing priced in USD.", term: "USD", valid: false },
    { quote: "Cotton clothing priced in INR.", term: "India", valid: false },
    { quote: "Cotton clothing at example.in.", term: "India", valid: false },
  ])("does not confuse unsupported geography with a failed category: $quote / $term", ({ quote, term, valid }) => {
    const source = { id: "e_1111111111111111", url, quote, capturedAt: timestamp };
    const categories = [{ term: "cotton clothing", sourceId: source.id }], market = { term, sourceId: source.id };
    expect(validateDiscoveryPlan({ categories, market }, [source]))
      .toEqual({ plan: { categories, market: valid ? market : null }, omittedPaths: valid ? [] : ["market.term"] });
  });

  it("fails closed with field paths when every proposed category is unsupported", async () => {
    const source = { id: "e_1111111111111111", url, quote, capturedAt: timestamp };
    complete.mockResolvedValue(tool("plan_market_search", {
      categories: [{ term: "silk clothing", sourceId: source.id }], market: null,
    }));
    await expect(planDiscovery(complete, "test-model", { sources: [source] }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: "search_plan_evidence", paths: ["categories.0.term"] });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(complete.mock.calls[1][0].messages[0].content)).invalidPaths).toEqual(["categories.0.term"]);
    expect(searchCall).not.toHaveBeenCalled();
  });

  it.each([
    { patch: { candidateOwnBrandStore: false }, path: "candidateOwnBrandStore" },
    { patch: { sameBrandAsMerchant: true }, path: "sameBrandAsMerchant" },
    { patch: { name: "A name absent from the source" }, path: "brandSourceId" },
    { patch: { brandSourceId: "e_0000000000000000" }, path: "brandSourceId" },
    { patch: { categorySourceId: "e_0000000000000000" }, path: "categorySourceId" },
    { patch: { facts: [] }, path: "facts.products" },
  ])("records the actual failed brand check: $path", async ({ patch, path }) => {
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => {
      const response = await respond(...args);
      const block = response.content[0];
      if (block.type !== "tool_use") throw new Error("Missing test brand proposal.");
      return tool("verify_brand", { ...block.input as object, ...patch });
    });
    const merchant = scanAt(), candidate = scanAt("https://rival.example.org/");
    const result = await assessBrand(complete, "test-model", merchant, candidate, {
      categories: [{ term: "cotton clothing", sourceId: researchEvidence(merchant).sources[0].id }], market: null,
    }, new AbortController().signal);
    expect(result).toMatchObject({ profile: null, diagnostic: { code: "brand_validation", paths: [path] } });
    expect(result.limitations).toHaveLength(1);
    expect(result.limitations[0]).not.toContain("Captured pages did not verify");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("preserves visible scan coverage and specific rejection reasons when no brand is verified", async () => {
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => {
      const response = await respond(...args);
      if (args[0].tool_choice?.type !== "tool" || args[0].tool_choice.name !== "verify_brand") return response;
      const block = response.content[0];
      if (block.type !== "tool_use") throw new Error("Missing test brand proposal.");
      return tool("verify_brand", { ...block.input as object, candidateOwnBrandStore: false });
    });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const report = job(user, first.id).research!;
    expect(report.steps.filter((step) => step.profile)).toHaveLength(0);
    expect(report.steps.filter((step) => step.capture).map((step) => step.capture)).toEqual([
      { url: "https://rival.example.org/", pages: 1 }, { url: "https://second.example.org/", pages: 1 },
    ]);
    expect(report.steps.find((step) => step.key === "competitor-brand-0")).toMatchObject({
      status: "limited", diagnostic: { code: "brand_validation", paths: ["candidateOwnBrandStore"] },
      limitations: ["The model could not establish that this is the candidate brand's own store."],
    });
    const database = new Database(path, { readonly: true });
    const stored = database.prepare<[string], { result_json: string }>(
      "SELECT result_json FROM research_steps WHERE job_id = ? AND step_key = 'competitor-site-0'",
    ).get(first.id)!;
    expect(JSON.parse(stored.result_json).capture).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("productJson");
    database.close();
  });

  it("retains a failed candidate's URL and zero captured pages without a saved scan artifact", async () => {
    failFirstRival = true;
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const site = job(user, first.id).research!.steps.find((step) => step.key === "competitor-site-0")!;
    expect(site).toMatchObject({
      status: "failed", capture: { url: "https://rival.example.org/", pages: 0 },
      diagnostic: { code: "competitor_unreadable", paths: [] },
    });
    expect(scanner.mock.calls.filter(([destination]) => destination === "https://rival.example.org/")).toHaveLength(1);
  });

  it("rechecks legacy rejected brands on explicit resume without repeating saved searches or scans", async () => {
    const respond = complete.getMockImplementation()!;
    let accept = false;
    complete.mockImplementation(async (...args) => {
      const response = await respond(...args);
      if (accept || args[0].tool_choice?.type !== "tool" || args[0].tool_choice.name !== "verify_brand") return response;
      const block = response.content[0];
      if (block.type !== "tool_use") throw new Error("Missing test brand proposal.");
      return tool("verify_brand", { ...block.input as object, candidateOwnBrandStore: false });
    });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const saved = job(user, first.id);
    expect(saved.research!.steps.filter((step) => step.profile)).toHaveLength(0);
    const database = new Database(path);
    const read = (key: string) => JSON.parse(database.prepare<[string, string], { artifact_json: string }>(
      "SELECT artifact_json FROM research_steps WHERE job_id = ? AND step_key = ?",
    ).get(first.id, key)!.artifact_json);
    const plan = read("discovery-plan");
    for (let index = 0; index < 2; index++) {
      const key = `competitor-brand-${index}`;
      const input = { scan: read(`competitor-site-${index}`), plan, merchant: researchEvidence(scanAt()).sources };
      const legacyVersion = createHash("sha256").update(JSON.stringify([researchLimits.version, key, input])).digest("hex");
      database.prepare("UPDATE research_steps SET result_json = json_set(result_json, '$.inputVersion', ?) WHERE job_id = ? AND step_key = ?")
        .run(legacyVersion, first.id, key);
    }
    database.close();
    accept = true; scanner.mockClear(); searchCall.mockClear(); complete.mockClear();
    const retry = enqueue(user, true, saved.scanId!, first.id);
    await worker.tick();
    const report = job(user, retry.id).research!;
    expect(report.steps.filter((step) => step.profile).map((step) => step.profile!.name)).toEqual(["rival", "second"]);
    expect(complete.mock.calls.filter(([input]) => input.tool_choice?.type === "tool" && input.tool_choice.name === "verify_brand")).toHaveLength(2);
    expect(report.usage.searches).toBe(0);
    expect(report.usage.competitorScans).toBe(0);
    expect(scanner).not.toHaveBeenCalled();
    expect(searchCall).not.toHaveBeenCalled();
  });

  it.each([
    { indices: [0, 1, 999], expected: 2 },
    { indices: [0, "1", 1.5, -1, 999], expected: 1 },
    { indices: [0, 0, 1], expected: 2 },
    { indices: [999, "1", -1], expected: 0 },
  ])("retains independently valid candidate choices from $indices without a retry", async ({ indices, expected }) => {
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => args[0].tool_choice?.type === "tool" && args[0].tool_choice.name === "select_candidates"
      ? tool("select_candidates", { indices }) : respond(...args));
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const report = job(user, first.id).research!;
    expect(report.steps.find((step) => step.key === "discovery")).toMatchObject({
      status: "limited", diagnostic: { code: "candidate_validation" },
      limitations: expect.arrayContaining([expect.stringContaining("remaining valid leads were retained")]),
    });
    expect(report.usage.competitorScans).toBe(expected);
    expect(report.steps.filter((step) => step.profile)).toHaveLength(expected);
    const selections = complete.mock.calls.filter(([input]) => input.tool_choice?.type === "tool" && input.tool_choice.name === "select_candidates");
    expect(selections).toHaveLength(1);
    const wireSchema = JSON.stringify(selections[0][0].tools);
    expect(wireSchema).toContain('"const":0');
    expect(wireSchema).toContain('"const":1');
    expect(wireSchema).not.toContain('"const":999');
  });

  it("keeps a Store request rejection distinct from credentials and preserves other research", async () => {
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => {
      if (args[0].tool_choice?.type === "tool" && args[0].tool_choice.name === "propose_business") {
        throw Anthropic.APIError.generate(400, { error: {
          type: "invalid_request_error", message: "private-provider-body",
          details: { error_code: "schema_invalid" },
        } }, undefined, new Headers({ "request-id": "req_fixture123" }));
      }
      return respond(...args);
    });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const report = job(user, first.id).research!;
    expect(report.steps.find((step) => step.key === "store")).toMatchObject({
      status: "failed", diagnostic: { code: "model_request_rejected" },
      limitations: [expect.stringContaining("rejected the analysis request (HTTP 400)")],
    });
    expect(report.steps.filter((step) => step.profile)).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain("private-provider-body");
    expect(JSON.stringify(report)).not.toContain("Check the server");
    expect(console.error).toHaveBeenCalledWith("Business agent provider request failed:", {
      tool: "propose_business", status: 400, code: "model_request_rejected", requestId: "req_fixture123", providerCode: "schema_invalid",
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private-provider-body");
  });

  it("uses multiple category-led web searches and verifies six distinct brands within the persisted budgets", async () => {
    let round = 0;
    searchCall.mockImplementation(async () => {
      const results = Array.from({ length: 5 }, (_, index) => ({
        url: `https://brand${round + index}.example.org/`, title: `Independent cotton clothing brand ${round + index}`,
      }));
      round++; return { results };
    });
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => {
      const input = args[0];
      if (input.tool_choice?.type === "tool" && input.tool_choice.name === "select_candidates") {
        return tool("select_candidates", { indices: [0, 1, 2, 3, 4, 5] });
      }
      return respond(...args);
    });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const report = job(user, first.id).research!;
    expect(report.usage).toEqual({ searches: 6, competitorScans: 6, modelCalls: 13 });
    const queries = searchCall.mock.calls.map(([arguments_]) => arguments_.query as string);
    expect(new Set(queries).size).toBe(6);
    expect(queries.every((query) => query.includes("cotton clothing") && query.includes("India") && !query.includes("TEE-1"))).toBe(true);
    expect(report.steps.filter((step) => step.profile)).toHaveLength(6);
    expect(report.steps.filter((step) => step.search).map((step) => step.search!.query)).toEqual(queries);
    const synthesis = complete.mock.calls.find(([input]) => String(input.system).includes("Study captured"))![0];
    expect(JSON.parse(String(synthesis.messages[0].content)).verifiedBrands).toHaveLength(6);
    expect(report.steps.length).toBeLessThanOrEqual(researchLimits.steps);
  });

  it("excludes marketplaces before selection and rejects an own-brand reseller even if the model accepts it", async () => {
    worker.stop();
    const resellerScanner = vi.fn(async (destination: string) =>
      scanAt(destination, "25.00", destination.includes("reseller") ? "Fixture shop" : undefined));
    worker = createAnalysisWorker({ store, scanner: resellerScanner,
      agent: createResearchAgent({ complete, scanner: resellerScanner, search: createTavilySearch({ call: searchCall }) }) });
    searchCall.mockResolvedValue({ results: [
      { url: "https://www.flipkart.com/superyou", title: "Marketplace listing" },
      { url: "https://www.amazon.in/merchant", title: "Marketplace listing" },
      { url, title: "The merchant itself" },
      { url: "https://reseller.example.org/", title: "Own-brand reseller" },
      { url: "https://rival.example.org/", title: "Independent cotton brand" },
    ] });
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => {
      const input = args[0];
      const response = await respond(...args);
      if (input.tool_choice?.type === "tool" && input.tool_choice.name === "verify_brand"
        && String(input.messages[0].content).includes("https://reseller.example.org/")) {
        const block = response.content[0];
        if (block.type === "tool_use") return tool("verify_brand", { ...block.input as object, name: "Fixture shop", sameBrandAsMerchant: false });
      }
      return response;
    });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    expect(resellerScanner.mock.calls.map(([url]) => url)).not.toContain("https://www.flipkart.com/superyou");
    expect(resellerScanner.mock.calls.map(([url]) => url)).not.toContain("https://www.amazon.in/merchant");
    const report = job(user, first.id).research!;
    expect(report.steps.filter((step) => step.profile).map((step) => step.profile!.name)).toEqual(["rival"]);
    expect(report.steps.find((step) => step.key === "competitor-brand-0")).toMatchObject({ status: "limited" });
    expect(report.steps.find((step) => step.key === "competitor-brand-0")!.profile).toBeUndefined();
    const synthesis = complete.mock.calls.find(([input]) => String(input.system).includes("Study captured"))![0];
    const context = JSON.parse(String(synthesis.messages[0].content));
    expect(context.sources.some((source: { url: string }) => source.url.includes("reseller"))).toBe(false);
    expect(context.verifiedBrands.map((brand: { name: string }) => brand.name)).toEqual(["rival"]);
  });

  it("counts the same independent brand on two domains only once, including on an explicit retry", async () => {
    worker.stop();
    const sameBrandScanner = vi.fn(async (destination: string) =>
      scanAt(destination, "25.00", destination === url ? undefined : "IndependentCo"));
    worker = createAnalysisWorker({ store, scanner: sameBrandScanner,
      agent: createResearchAgent({ complete, scanner: sameBrandScanner, search: createTavilySearch({ call: searchCall }) }) });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const profiles = job(user, first.id).research!.steps.filter((step) => step.profile);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].profile!.name).toBe("IndependentCo");
    const pricing = job(user, first.id).research!.steps.find((step) => step.key === "pricing")!;
    expect(pricing.findings.flatMap((finding) => finding.sources).some((source) => source.url.includes("second"))).toBe(false);
    complete.mockClear(); sameBrandScanner.mockClear(); searchCall.mockClear();
    const retry = enqueue(user, true, job(user, first.id).scanId!, first.id);
    await worker.tick();
    expect(job(user, retry.id).research!.steps.filter((step) => step.profile)).toHaveLength(1);
    expect(complete).not.toHaveBeenCalled();
    expect(searchCall).not.toHaveBeenCalled();
    expect(sameBrandScanner).not.toHaveBeenCalled();
  });
  it("corrects an ungrounded search plan once before searching and charges the extra model call", async () => {
    const respond = complete.getMockImplementation()!;
    let planningCalls = 0;
    complete.mockImplementation(async (...args) => {
      const input = args[0];
      if (input.tool_choice?.type === "tool" && input.tool_choice.name === "plan_market_search" && ++planningCalls === 1) {
        return tool("plan_market_search", { categories: [{ term: "everyday cotton clothing", sourceId: researchEvidence(scanAt()).sources[0].id }],
          market: { term: "Invented private market", sourceId: researchEvidence(scanAt()).sources[0].id } });
      }
      return respond(...args);
    });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const report = job(user, first.id).research!;
    expect(planningCalls).toBe(2);
    expect(report.steps.find((step) => step.key === "discovery-plan")).toMatchObject({ status: "completed", diagnostic: null });
    expect(report.usage.modelCalls).toBe(10);
    expect(searchCall).toHaveBeenCalled();
    expect(JSON.stringify(searchCall.mock.calls)).not.toContain("Invented private market");
    expect(JSON.stringify(searchCall.mock.calls)).not.toContain("everyday cotton clothing");
    const correction = complete.mock.calls.filter(([input]) => input.tool_choice?.type === "tool" && input.tool_choice.name === "plan_market_search")[1][0];
    expect(JSON.parse(String(correction.messages[0].content))).toMatchObject({ rejectedPlan: { categories: [{ term: "everyday cotton clothing" }] } });
    expect(JSON.stringify(correction.messages)).not.toContain("Private profile notes");
  });

  it("omits a market source outside the supplied context without spending another model call", async () => {
    const sources = researchEvidence(scanAt()).sources;
    const categorySource = sources.find((source) => source.quote === quote)!;
    const omittedSource = sources.find((source) => source.quote.includes("shipping across India"))!;
    const corrected = { categories: [{ term: "cotton clothing", sourceId: categorySource.id }], market: null };
    complete.mockResolvedValueOnce(tool("plan_market_search", { ...corrected,
      market: { term: "India", sourceId: omittedSource.id },
    }));
    const result = await planDiscovery(complete, "test-model", { sources: [categorySource] }, AbortSignal.timeout(1000));
    expect(result).toEqual({ plan: corrected, omittedPaths: ["market.sourceId"] });
    expect(complete).toHaveBeenCalledOnce();
    expect(JSON.stringify(complete.mock.calls[0][0].messages)).not.toContain(omittedSource.quote);
    expect(searchCall).not.toHaveBeenCalled();
  });

  it("does not make a search-plan correction after cancellation", async () => {
    const controller = new AbortController();
    complete.mockImplementationOnce(async () => {
      controller.abort();
      return tool("plan_market_search", { categories: [], market: null });
    });
    await expect(planDiscovery(complete, "test-model", { sources: researchEvidence(scanAt()).sources }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(complete).toHaveBeenCalledOnce();
    expect(searchCall).not.toHaveBeenCalled();
  });

  it("does not spend a model call when no merchant quotes are supplied", async () => {
    await expect(planDiscovery(complete, "test-model", { sources: [] }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: "search_plan_evidence", paths: ["sources"] });
    expect(complete).not.toHaveBeenCalled();
    expect(searchCall).not.toHaveBeenCalled();
  });

  it("honors cancellation before checking for missing evidence", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(planDiscovery(complete, "test-model", { sources: [] }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(complete).not.toHaveBeenCalled();
    expect(searchCall).not.toHaveBeenCalled();
  });

  it("persists failed anchor paths after the single bounded correction is exhausted", async () => {
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => {
      if (args[0].tool_choice?.type === "tool" && args[0].tool_choice.name === "plan_market_search")
        return tool("plan_market_search", { categories: [{ term: "cotton clothing", sourceId: "e_0000000000000000" }], market: null });
      return respond(...args);
    });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    expect(job(user, first.id).research!.steps.find((step) => step.key === "discovery-plan")).toMatchObject({
      status: "failed", diagnostic: { code: "search_plan_evidence", paths: ["categories.0.sourceId"] },
    });
    expect(complete.mock.calls.filter(([input]) => input.tool_choice?.type === "tool" && input.tool_choice.name === "plan_market_search")).toHaveLength(2);
    expect(searchCall).not.toHaveBeenCalled();
  });

  it("does not bypass an exhausted durable model budget to correct a search plan", async () => {
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => {
      const input = args[0];
      if (input.tool_choice?.type === "tool" && input.tool_choice.name === "plan_market_search") {
        return tool("plan_market_search", { categories: [{ term: "An invented category", sourceId: researchEvidence(scanAt()).sources[0].id }], market: null });
      }
      return respond(...args);
    });
    const user = owner(), first = enqueue(user);
    const database = new Database(path);
    try {
      database.prepare("INSERT INTO research_usage (job_id, model_calls) VALUES (?, ?)").run(first.id, researchLimits.modelCalls - 3);
    } finally { database.close(); }
    await worker.tick();
    const report = job(user, first.id).research!;
    expect(report.usage.modelCalls).toBe(researchLimits.modelCalls);
    expect(report.steps.find((step) => step.key === "discovery-plan")).toMatchObject({ status: "failed", diagnostic: { code: "run_limit" } });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(searchCall).not.toHaveBeenCalled();
    expect(scanner).toHaveBeenCalledOnce();
  });

  it("does not search an invented market and does not attach unsupported quote fragments to brand profiles", async () => {
    const respond = complete.getMockImplementation()!;
    let inventMarket = true;
    complete.mockImplementation(async (...args) => {
      const response = await respond(...args), input = args[0], block = response.content[0];
      if (block.type !== "tool_use") return response;
      if (inventMarket && input.tool_choice?.type === "tool" && input.tool_choice.name === "plan_market_search") {
        const value = block.input as { categories: unknown[]; market: { term: string; sourceId: string } };
        return tool("plan_market_search", { ...value, market: { ...value.market, term: "Invented private market" } });
      }
      if (!inventMarket && input.tool_choice?.type === "tool" && input.tool_choice.name === "verify_brand") {
        const value = block.input as { facts: { dimension: string; text: string; sourceId: string }[] };
        return tool("verify_brand", { ...value, marketSourceId: null, facts: [...value.facts,
          { dimension: "positioning", text: "An invented market-leading positioning claim.", sourceId: value.facts[0].sourceId }] });
      }
      return response;
    });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    expect(searchCall).toHaveBeenCalled();
    expect(JSON.stringify(searchCall.mock.calls)).not.toContain("Invented private market");
    expect(complete.mock.calls.filter(([input]) => input.tool_choice?.type === "tool" && input.tool_choice.name === "plan_market_search")).toHaveLength(1);
    expect(job(user, first.id).research!.steps.find((step) => step.key === "discovery-plan"))
      .toMatchObject({ status: "limited", diagnostic: { code: "search_plan_evidence", paths: ["market.term"] } });
    expect(job(user, first.id).research!.steps.filter((step) => step.profile).every((step) => !step.profile!.marketVerified)).toBe(true);
    inventMarket = false;
    const second = enqueue(user);
    await worker.tick();
    const profiles = job(user, second.id).research!.steps.filter((step) => step.profile).map((step) => step.profile!);
    expect(profiles).toHaveLength(2);
    expect(profiles.every((profile) => !profile.marketVerified && profile.facts.every((fact) => fact.dimension === "products"))).toBe(true);
    expect(profiles.every((profile) => profile.limitations.some((gap) => gap.includes("Unsupported")))).toBe(true);
  });

  it("persists partial planning diagnostics and searches only the retained category without a correction call", async () => {
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => {
      const response = await respond(...args);
      if (args[0].tool_choice?.type !== "tool" || args[0].tool_choice.name !== "plan_market_search") return response;
      const source = researchEvidence(scanAt()).sources.find((source) => source.quote === quote)!;
      return tool("plan_market_search", {
        categories: [{ term: "clothing and cotton", sourceId: source.id }, { term: "silk clothing", sourceId: source.id }],
        market: null,
      });
    });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const report = job(user, first.id).research!;
    expect(report.steps.find((step) => step.key === "discovery-plan")).toMatchObject({
      status: "limited", diagnostic: { code: "search_plan_evidence", paths: ["categories.1.term"] },
    });
    expect(report.steps.filter((step) => step.profile)).toHaveLength(2);
    expect(report.usage.modelCalls).toBe(9);
    expect(complete.mock.calls.filter(([input]) => input.tool_choice?.type === "tool" && input.tool_choice.name === "plan_market_search")).toHaveLength(1);
    expect(searchCall).toHaveBeenCalled();
    expect(JSON.stringify(searchCall.mock.calls)).not.toContain("silk");
    expect(JSON.stringify(searchCall.mock.calls)).toContain("clothing and cotton");
    const database = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const saved = database.prepare<[string], { artifact_json: string }>(
        "SELECT artifact_json FROM research_steps WHERE job_id = ? AND step_key = 'discovery-plan'",
      ).get(first.id)!;
      expect(JSON.parse(saved.artifact_json)).toEqual({
        categories: [{ term: "clothing and cotton", sourceId: researchEvidence(scanAt()).sources.find((source) => source.quote === quote)!.id }],
        market: null,
      });
    } finally { database.close(); }
  });

  it("rejects price undercutting, speculative margins and uncited paraphrases even when their source IDs exist", async () => {
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => {
      const input = args[0];
      if (String(input.system).includes("Study captured")) {
        const context = JSON.parse(String(input.messages[0].content));
        const source = context.sources.find((source: { url: string }) => source.url !== url);
        const finding = { kind: "observation", title: "Unsafe comparison", detail: "This brand undercuts the merchant by 25%.", sourceIds: [source.id] };
        return tool("record_findings", { findings: [
          finding,
          { ...finding, kind: "hypothesis", title: "Margin speculation", detail: "Repeat buyers will migrate and cannibalize direct margins." },
          { ...finding, title: "Fabricated interpretation", detail: "This brand definitively serves the same affluent customers." },
          { ...finding, kind: "suggestion", title: "Verify the product descriptions", detail: "Check the captured cotton descriptions before a merchandising test." },
        ], limitations: ["Private performance and shopper evidence are not connected."] });
      }
      return respond(...args);
    });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const step = job(user, first.id).research!.steps.find((step) => step.key === "competitor")!;
    expect(step.findings.map((finding) => finding.title)).toEqual(["Verify the product descriptions"]);
    expect(step.diagnostic).toMatchObject({ code: "finding_validation",
      paths: ["findings.0.unsupportedClaim", "findings.1.unsupportedClaim", "findings.2.detail"] });
  });

  it("does not silently expand the budget of jobs created before the new research consent", async () => {
    const user = owner(), first = enqueue(user);
    const database = new Database(path);
    database.prepare("UPDATE analysis_jobs SET research_version = 1 WHERE id = ?").run(first.id);
    database.close();
    await worker.tick();
    expect(searchCall).not.toHaveBeenCalled();
    expect(scanner).toHaveBeenCalledOnce();
    expect(job(user, first.id).research!.steps.find((step) => step.key === "discovery")!.limitations.join(" ")).toContain("updated research permission");
  });

  it("reports missing competitors rather than synthesizing a marketplace or own-brand comparison", async () => {
    worker.stop();
    const ownBrandScanner = vi.fn(async (destination: string) => scanAt(destination, "25.00", "Fixture shop"));
    worker = createAnalysisWorker({ store, scanner: ownBrandScanner,
      agent: createResearchAgent({ complete, scanner: ownBrandScanner, search: createTavilySearch({ call: searchCall }) }) });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const report = job(user, first.id).research!;
    expect(report.steps.filter((step) => step.profile)).toHaveLength(0);
    expect(report.steps.find((step) => step.key === "competitor")).toMatchObject({ status: "limited", findings: [] });
    expect(complete.mock.calls.some(([input]) => String(input.system).includes("Study captured"))).toBe(false);
    const downstream = complete.mock.calls.filter(([input]) => input.tool_choice?.type === "tool" && input.tool_choice.name === "record_findings");
    for (const [input] of downstream) {
      const context = JSON.parse(String(input.messages[0].content));
      expect(context.verifiedBrands).toEqual([]);
      expect(context.sources.every((source: { url: string }) => source.url === url)).toBe(true);
    }
  });

  it("preserves independently validated specialist findings when store output and other individual citations fail", async () => {
    failStore = true; invalidFinding = true;
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const result = job(user, first.id);
    expect(result.status).toBe("completed");
    expect(result.understanding!.briefing).toBeNull();
    expect(result.research!.status).toBe("partial");
    expect(result.research!.steps.find((step) => step.key === "store")!.status).toBe("failed");
    for (const key of ["competitor", "opportunity", "growth"]) {
      expect(result.research!.steps.find((step) => step.key === key)).toMatchObject({
        status: "limited", findings: [{ title: expect.not.stringContaining("Unsupported") }],
        diagnostic: { code: "finding_validation", paths: ["findings.1.sourceIds"] },
      });

    }
    await worker.stop(); store.close(); store = openStore(path);
    expect(job(user, first.id).research).toEqual(result.research);
    expect(job(user, first.id).scanId).not.toBeNull();
  });

  it.each(["overlong", "not-an-array", "too-many"])("keeps checked brand facts and specialist findings when limitations are %s", async (problem) => {
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => {
      const response = await respond(...args), block = response.content[0];
      if (block.type !== "tool_use" || !["verify_brand", "record_findings"].includes(block.name)) return response;
      const value = block.input as { facts?: unknown[] };
      return tool(block.name, { ...value,
        ...(value.facts ? { facts: [...value.facts, { dimension: "positioning", text: "x", sourceId: "malformed" }] } : {}),
        limitations: problem === "overlong" ? ["x".repeat(501)] : problem === "too-many" ? Array(6).fill("An evidence gap.") : null,
      });
    });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const report = job(user, first.id).research!;
    const profiles = report.steps.flatMap((step) => step.profile ? [step.profile] : []);
    expect(profiles).toHaveLength(2);
    expect(profiles.every((profile) => profile.facts.length === 1 && profile.facts[0].dimension === "products")).toBe(true);
    expect(profiles.every((profile) => profile.limitations.some((gap) => gap.includes("omitted")))).toBe(true);
    for (const key of ["competitor", "opportunity", "growth"]) {
      expect(report.steps.find((step) => step.key === key)).toMatchObject({
        status: "limited", findings: [expect.objectContaining({ kind: "suggestion" })],
        diagnostic: { code: "finding_validation", paths: [problem === "overlong" ? "limitations.0" : "limitations"] },
      });
    }
    expect(complete).toHaveBeenCalledTimes(9);
  });

  it("persists summary-less Store findings, omission diagnostics and the last accepted snapshot after a wholly failed refresh", async () => {
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => {
      const response = await respond(...args), block = response.content[0];
      if (!failStore && block.type === "tool_use" && block.name === "propose_business") {
        const value = block.input as { briefing: { summary: { text: string } } };
        return tool(block.name, { ...value, briefing: { ...value.briefing, summary: { ...value.briefing.summary, sources: ["e_0000000000000000"] } } });
      }
      return response;
    });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const saved = job(user, first.id).understanding!;
    expect(saved.briefing?.summary).toBeUndefined();
    expect(saved.briefing?.insights).toHaveLength(1);
    expect(saved.validationIssues).toContainEqual({ path: "briefing.summary.sources", code: "invalid_reference" });
    expect(saved.research!.steps.find((step) => step.key === "store")).toMatchObject({
      status: "limited", findings: [{ title: "offering" }],
      diagnostic: { code: "finding_validation", paths: ["briefing.summary.sources"] },
    });
    expect(saved.warnings.some((warning) => warning.includes("omitted"))).toBe(true);
    expect(complete).toHaveBeenCalledTimes(9);
    failStore = true;
    const second = enqueue(user);
    await worker.tick();
    const failed = job(user, second.id).understanding!;
    expect(failed.briefing).toBeNull();
    expect(failed.research!.steps.find((step) => step.key === "store")!.status).toBe("failed");
    await worker.stop(); store.close(); store = openStore(path);
    const response = await request(createApp({ store })).get(`/api/businesses/${user.business.id}/understanding`).set("Cookie", user.cookie).expect(200);
    expect(response.body.understanding.id).toBe(failed.id);
    expect(response.body.lastSuccessfulUnderstanding).toEqual(saved);
  });

  it.each([false, true])("charges text shortening to the durable model budget and respects exhaustion (%s)", async (exhausted) => {
    overlongAction = true;
    const user = owner(), first = enqueue(user, false);
    if (exhausted) {
      const database = new Database(path);
      try {
        database.prepare("INSERT INTO research_usage (job_id, model_calls) VALUES (?, ?)").run(first.id, researchLimits.modelCalls - 2);
      } finally { database.close(); }
    }
    await worker.tick();
    const result = job(user, first.id), report = result.research!;
    expect(result.status).toBe("completed");
    expect(report.usage.modelCalls).toBe(exhausted ? researchLimits.modelCalls : 5);
    expect(complete).toHaveBeenCalledTimes(exhausted ? 2 : 5);
    const repairs = complete.mock.calls.filter(([input]) => input.tool_choice?.type === "tool" && input.tool_choice.name === "shorten_business_fields");
    expect(repairs).toHaveLength(exhausted ? 0 : 1);
    expect(report.steps.find((step) => step.key === "store")).toMatchObject(exhausted
      ? { status: "limited", diagnostic: { code: "finding_validation" } }
      : { status: "completed" });
    if (!exhausted) {
      expect(result.understanding!.briefing!.nextSteps).toEqual([{ action: "Verify the current product details.", reason: "Published information can change." }]);
      await worker.stop(); store.close(); store = openStore(path);
      expect(job(user, first.id).understanding).toEqual(result.understanding);
    } else {
      expect(result.understanding!.briefing?.summary).toBeDefined();
      expect(result.understanding!.briefing?.nextSteps).toEqual([]);
      expect(result.understanding!.validationIssues).toContainEqual({ path: "briefing", code: "text_rewrite_failed" });
    }
    expect(searchCall).not.toHaveBeenCalled();
    expect(scanner).toHaveBeenCalledOnce();
  });

  it("waits for Store Intelligence and hands cited findings and unanswered questions to competitor selection and analysis", async () => {
    const respond = complete.getMockImplementation()!;
    let releaseStore!: () => void, enteredStore!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseStore = resolve; });
    const entered = new Promise<void>((resolve) => { enteredStore = resolve; });
    complete.mockImplementation(async (...args) => {
      const input = args[0];
      if (input.tool_choice?.type === "tool" && input.tool_choice.name === "propose_business") {
        enteredStore(); await blocked;
      }
      return respond(...args);
    });
    const user = owner(), first = enqueue(user);
    const running = worker.tick();
    try {
      await entered;
      expect(searchCall).not.toHaveBeenCalled();
      expect(scanner).toHaveBeenCalledOnce();
    } finally { releaseStore(); await running; }
    const inputs = complete.mock.calls.map(([input]) => input);
    const selection = inputs.find((input) => input.tool_choice?.type === "tool" && input.tool_choice.name === "select_candidates")!;
    const competitor = inputs.find((input) => typeof input.system === "string" && input.system.includes("Study captured"))!;
    const selectionContext = JSON.parse(String(selection.messages[0].content)).merchant;
    const competitorContext = JSON.parse(String(competitor.messages[0].content));
    for (const context of [selectionContext, competitorContext]) {
      expect(context.storeIntelligence).toMatchObject({
        status: "completed", inputVersion: expect.stringMatching(/^[a-f0-9]{64}$/),
        unknowns: [{ question: "What do shoppers actually buy?", whyItMatters: "Private sales evidence is unavailable." }],
      });
      expect(context.acceptedFindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: "Your public storefront", detail: "This store presents cotton clothing." }),
        expect.objectContaining({ title: "offering", detail: expect.stringContaining("The fabric is part") }),
      ]));
      for (const finding of context.acceptedFindings) {
        expect(finding.sourceIds.length).toBeGreaterThan(0);
        expect(finding.sourceIds.every((id: string) => context.sources.some((source: { id: string }) => source.id === id))).toBe(true);
      }
      expect(JSON.stringify(context).length).toBeLessThanOrEqual(researchLimits.contextCharacters);
    }
    expect(competitorContext.dependencies).toContainEqual(expect.objectContaining({ key: "store", status: "completed" }));
    expect(JSON.stringify(searchCall.mock.calls)).not.toContain("What do shoppers actually buy?");
    expect(job(user, first.id).status).toBe("completed");
  });

  it("identifies a failed store handoff and recomputes dependent competitor work when Store Intelligence recovers", async () => {
    failStore = true;
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const previous = job(user, first.id);
    const competitorInput = complete.mock.calls.find(([input]) => typeof input.system === "string" && input.system.includes("Study captured"))![0];
    expect(JSON.parse(String(competitorInput.messages[0].content))).toMatchObject({
      storeIntelligence: { status: "failed", unknowns: [], limitations: [expect.any(String)] }, acceptedFindings: [],
    });
    failStore = false; complete.mockClear(); scanner.mockClear(); searchCall.mockClear();
    const second = enqueue(user, true, previous.scanId!, first.id);
    await worker.tick();
    const report = job(user, second.id).research!;
    expect(report.steps.find((step) => step.key === "store")!.status).toBe("completed");
    for (const key of ["discovery", "competitor"]) {
      expect(report.steps.find((step) => step.key === key)!.inputVersion)
        .not.toBe(previous.research!.steps.find((step) => step.key === key)!.inputVersion);
      expect(report.steps.find((step) => step.key === key)!.reused).toBe(false);
    }
    expect(searchCall).not.toHaveBeenCalled();
    expect(scanner).not.toHaveBeenCalled();
    expect(report.steps.find((step) => step.key === "competitor-site-0")!.reused).toBe(true);
    expect(job(user, first.id)).toEqual(previous);
  });

  it("requires separate research consent and never invents customer evidence or relative price claims", async () => {
    const user = owner(), first = enqueue(user, false);
    await worker.tick();
    const report = job(user, first.id).research!;
    expect(searchCall).not.toHaveBeenCalled();
    expect(scanner).toHaveBeenCalledOnce();
    expect(report.usage).toEqual({ searches: 0, competitorScans: 0, modelCalls: 4 });
    expect(report.steps.find((step) => step.key === "competitor")!.findings).toEqual([]);
    expect(report.steps.find((step) => step.key === "customer")!.limitations.join(" ")).toContain("Aggregate ratings");
    const own = researchProducts(scanAt(), "merchant"), other = researchProducts(scanAt("https://rival.example.org/", "1.00"), "competitor");
    const comparison = compareResearchProducts(own, other);
    expect(comparison.findings[0].detail).not.toMatch(/cheaper|%|advantage of/i);
    expect(comparison.limitations.join(" ")).toContain("No price delta");
    other[0].data.gtin = "";
    expect(compareResearchProducts(own, other).findings).toEqual([]);
  });

  it.each([false, true])("shares the global scan budget when another foreground scan is active: %s", async (foregroundActive) => {
    let active = 0, peak = 0;
    let round = 0;
    searchCall.mockImplementation(async () => ({ results: Array.from({ length: 5 }, (_, index) => ({
      url: `https://brand${round++ + index}.example.org/`, title: "Independent cotton clothing brand",
    })) }));
    const respond = complete.getMockImplementation()!;
    complete.mockImplementation(async (...args) => {
      const input = args[0];
      return input.tool_choice?.type === "tool" && input.tool_choice.name === "select_candidates"
        ? tool("select_candidates", { indices: [0, 1, 2, 3, 4, 5] }) : respond(...args);
    });
    const boundedScanner = vi.fn(async (destination: string) => {
      active++; peak = Math.max(peak, active);
      try { await Promise.resolve(); return scanAt(destination); } finally { active--; }
    });
    await worker.stop();
    worker = createAnalysisWorker({ store, scanner: boundedScanner,
      agent: createResearchAgent({ complete, scanner: boundedScanner, search: createTavilySearch({ call: searchCall }) }) });
    const release = foregroundActive ? claimWorkSlot() : null;
    try {
      const user = owner(), first = enqueue(user);
      await worker.tick();
      expect(job(user, first.id).status).toBe("completed");
      expect(peak).toBe(foregroundActive ? 1 : 2);
      expect(boundedScanner).toHaveBeenCalledTimes(7);
    } finally { release?.(); }
  });

  it("only presents GTINs and offer values supported by the retained product quotes", () => {
    const own = scanAt(), other = researchProducts(scanAt("https://rival.example.org/"), "competitor");
    const product = { "@type": "Product", name: "Cotton everyday tee", gtin13: "4006381333931" };
    const offers = { "@type": "Offer", price: "20.00", priceCurrency: "USD" };
    own.pages[0].productJson = [JSON.stringify({ ...product, description: "Long captured description. ".repeat(50), offers })];
    const comparison = compareResearchProducts(researchProducts(own, "merchant"), other);
    expect(comparison.findings).toHaveLength(1);
    expect(comparison.findings[0].detail).toContain("Merchant offer: not established in the retained quote");
    expect(comparison.findings[0].detail).toContain("Competitor offer: 20.00 USD");
    own.pages[0].productJson = [JSON.stringify({
      "@type": "Product", name: product.name, description: "Long captured description. ".repeat(50), gtin13: product.gtin13, offers,
    })];
    expect(researchProducts(own, "merchant")).toHaveLength(1);
    expect(compareResearchProducts(researchProducts(own, "merchant"), other).findings).toEqual([]);
  });

  it("surfaces missing Tavily configuration without failing the other specialists", async () => {
    await worker.stop();
    worker = createAnalysisWorker({ store, scanner, agent: createResearchAgent({ complete, scanner }) });
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const report = job(user, first.id).research!;
    expect(report.steps.find((step) => step.key === "discovery")).toMatchObject({
      status: "failed", diagnostic: { code: "search_not_configured" }, limitations: [expect.stringContaining("TAVILY_API_KEY")],
    });
    expect(report.steps.find((step) => step.key === "growth")!.findings).toHaveLength(1);
    expect(report.usage.searches).toBe(0);
    expect(searchCall).not.toHaveBeenCalled();
  });

  it("explicitly resumes failed work, reuses successful calls and scans, and refreshes downstream input versions", async () => {
    failFirstRival = true;
    const user = owner(), first = enqueue(user);
    await worker.tick();
    const previous = job(user, first.id);
    const oldOpportunity = previous.research!.steps.find((step) => step.key === "opportunity")!.inputVersion;
    failFirstRival = false; complete.mockClear(); scanner.mockClear(); searchCall.mockClear();
    const second = enqueue(user, true, previous.scanId!, first.id);
    await worker.tick();
    const result = job(user, second.id), report = result.research!;
    expect(report.usage).toEqual({ searches: 0, competitorScans: 1, modelCalls: 4 });
    expect(searchCall).not.toHaveBeenCalled();
    expect(scanner).toHaveBeenCalledOnce();
    expect(scanner.mock.calls[0][0]).toBe("https://rival.example.org/");
    expect(report.steps.find((step) => step.key === "store")!.reused).toBe(true);
    expect(report.steps.find((step) => step.key === "competitor-site-1")!.reused).toBe(true);
    expect(report.steps.find((step) => step.key === "opportunity")!.inputVersion).not.toBe(oldOpportunity);
    expect(job(user, first.id)).toEqual(previous);
    complete.mockClear(); scanner.mockClear();
    const third = enqueue(user, true, result.scanId!, second.id);
    await worker.tick();
    expect(job(user, third.id).research!.usage).toEqual({ searches: 0, competitorScans: 0, modelCalls: 0 });
    expect(complete).not.toHaveBeenCalled(); expect(scanner).not.toHaveBeenCalled();
  });

  it.each([1, 2])("fences journal writes after cancellation and enforces persisted version %s provider budgets", (version) => {
    const user = owner(), first = enqueue(user);
    const database = new Database(path);
    database.prepare("UPDATE analysis_jobs SET research_version = ? WHERE id = ?").run(version, first.id);
    database.close();
    const claim = store.claimAnalysis()!;
    const journal = store.researchJournal(first.id, claim.lease);
    const modelCap = version === 1 ? 7 : researchLimits.modelCalls;
    for (let i = 0; i < modelCap; i++) journal.consume("modelCalls");
    expect(() => journal.consume("modelCalls")).toThrow(ResearchLimit);
    const step: ResearchStep = { key: "store", agent: "store", status: "completed", findings: [], limitations: [], diagnostic: null,
      startedAt: timestamp, completedAt: timestamp, reused: false };
    journal.write(step, { accepted: true });
    store.cancelAnalysis(user.id, user.business.id, first.id);
    expect(() => journal.write({ ...step, findings: [] })).toThrow(ResearchStopped);
    expect(() => journal.consume("searches")).toThrow(ResearchStopped);
    expect(job(user, first.id).research!.usage.modelCalls).toBe(modelCap);
    expect(job(user, first.id).research!.steps[0].status).toBe("completed");
    expect(store.getAnalysisJob(owner().id, user.business.id, first.id)).toBeNull();
  });

  it("binds idempotency and resume to consent, owner, website and saved evidence, and requires queued wider research", async () => {
    const user = owner(), other = owner(), key = randomUUID();
    const agent = createResearchAgent({ complete });
    const app = createApp({ store, agent, scanner });
    await request(app).post(`/api/businesses/${user.business.id}/understanding`).set("Origin", "http://127.0.0.1:5173")
      .set("Cookie", user.cookie).send({ permission: true, research: true }).expect(400);
    const outdated = await request(app).post(`/api/businesses/${user.business.id}/understanding`)
      .set("Origin", "http://127.0.0.1:5173").set("Prefer", "respond-async").set("Idempotency-Key", randomUUID())
      .set("Cookie", user.cookie).send({ permission: true, research: true }).expect(400);
    expect(outdated.body.error).toContain("updated research");
    expect(store.latestAnalysisJob(user.id, user.business.id)).toBeNull();
    const first = store.enqueueAnalysis(user.id, user.business.id, key, url, undefined, true);
    expect(() => store.matchingAnalysisJob(user.id, user.business.id, key, url, undefined, false)).toThrow("different analysis");
    await worker.tick();
    const saved = job(user, first.id);
    expect(() => enqueue(other, true, undefined, first.id)).toThrow("same website");
    expect(() => enqueue(user, false, saved.scanId!, first.id)).toThrow("same website");
    const changedScan = store.saveScan(user.id, user.business.id, scanAt())!;
    expect(() => enqueue(user, true, changedScan.id, first.id)).toThrow("same website");
    expect(() => store.researchJournal(first.id, "wrong-lease").consume("modelCalls")).toThrow(ResearchStopped);
  });

  it("keeps worst-case research snapshots below the NDJSON frame ceiling while retaining private artifacts", () => {
    const user = owner(), first = enqueue(user), claim = store.claimAnalysis()!;
    const journal = store.researchJournal(first.id, claim.lease);
    const source = { id: "e_1111111111111111", url: `https://rival.example.org/${"x".repeat(1500)}`, quote: "x".repeat(500), capturedAt: timestamp };
    for (let i = 0; i < researchLimits.steps; i++) {
      const findings = Array.from({ length: 4 }, () => ({ kind: "observation" as const, title: "t".repeat(150), detail: "d".repeat(600), sources: [source, source, source] }));
      journal.write({ key: `step-${i}`, agent: "store", status: "completed", startedAt: timestamp, completedAt: timestamp,
        reused: false, findings, diagnostic: null, limitations: [] }, { findings });
    }
    const report = journal.report()!;
    const snapshot = { type: "job", job: { ...job(user, first.id), understanding: { research: report, extra: "x".repeat(65_000) } } };
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(researchLimits.frameBytes);
    expect(report.steps.every((step) => Buffer.byteLength(JSON.stringify(step)) > 7 * 1024
      && Buffer.byteLength(JSON.stringify(step)) <= researchLimits.stepBytes)).toBe(true);
    expect(report.steps[0].diagnostic!.code).toBe("report_size");
    expect(journal.read("step-0")!.artifact).toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ detail: "d".repeat(600) })]) });
  });
});
