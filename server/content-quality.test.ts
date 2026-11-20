import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { contentViolations, reviewContent, type ContentField } from "./content-quality.js";
import { createBusinessAgent, type AgentMessage, type AgentModel } from "./business-agent.js";
import { buildAgentEvidence } from "./agent-evidence.js";
import { createGrowthAdvisor } from "./growth-advisor.js";
import { createProductAnalyst, productAnalysisFingerprint, productEvidence, productFingerprint } from "./product-intelligence.js";
import { productDimensions } from "../shared/product-intelligence.js";
import type { GrowthOpportunity } from "../shared/growth.js";
import type { ScanResult } from "../shared/website.js";
import { emptyProduct, type Product } from "../shared/products.js";
import { openStore } from "./database.js";
import { createApp } from "./app.js";
import { newSession } from "./auth.js";

const signal = () => new AbortController().signal;
const reply = (name: string, input: unknown): AgentMessage => ({
  stop_reason: "tool_use", content: [{ type: "tool_use", id: "fixture", name, input }],
});
type ReviewInput = { verificationOnly: boolean; fields: { path: string; text: string; sources: unknown[]; violations: string[] }[] };
const inputFor = (input: Parameters<AgentModel>[0]) => JSON.parse(String(input.messages[0].content));
const approval = (input: ReviewInput) => reply("review_content_quality", {
  fields: input.fields.map(({ path }) => ({ path, verdict: "supported", reason: "supported", replacement: "" })),
});
function field(text: string, policy?: ContentField["policy"]): ContentField {
  return { path: "draft", text, policy, role: "mixed", maximum: 170, sources: [{ id: "e_1111111111111111", quote: "A trail mix in a 30g pack." }],
    replace: vi.fn() };
}
afterEach(() => { vi.restoreAllMocks(); });

describe("bounded evidence-quality review", () => {
  it.each([
    ["seo", "Trail mix for INR 150", "volatile_price"],
    ["seo", "Trail mix: 8.20g protein per 100g", "numeric_nutrition"],
    ["seo", "Trail mix: free shipping", "volatile_fulfilment"],
    ["financial", "Target a 15% uplift", "numeric_financial_estimate"],
    ["financial", "Test a price of 150 rupees", "numeric_financial_estimate"],
  ] as const)("rejects deterministic %s violations even when the auditor approves: %s", async (policy, text, issue) => {
    const target = field(text, policy);
    expect(contentViolations(target)).toContain(issue);
    const complete = vi.fn<AgentModel>(async (input) => approval(inputFor(input)));
    await expect(reviewContent(complete, "fixture", [target], {}, signal())).rejects.toMatchObject({ code: "content_quality_failed" });
    expect(complete).toHaveBeenCalledOnce();
    expect(target.replace).not.toHaveBeenCalled();
  });

  it("corrects only an issued field and verifies against unchanged citations", async () => {
    const target = field("Trail mix for INR 150", "seo");
    const complete = vi.fn<AgentModel>(async (input) => {
      const data = inputFor(input) as ReviewInput;
      expect(data.fields[0].sources).toEqual(target.sources);
      if (data.verificationOnly) {
        expect(data.fields[0].text).toBe("Trail mix in a 30g pack");
        return approval(data);
      }
      return reply("review_content_quality", { fields: [{ path: "draft", verdict: "needs_revision", reason: "volatile_copy",
        replacement: "Trail mix in a 30g pack" }] });
    });
    await reviewContent(complete, "fixture", [target], {}, signal());
    expect(target.replace).toHaveBeenCalledExactlyOnceWith("Trail mix in a 30g pack");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls.every(([input]) => input.max_tokens === 2400)).toBe(true);
  });

  it.each([
    { fields: [] },
    { fields: [{ path: "unissued", verdict: "supported", reason: "supported", replacement: "" }] },
    { fields: [{ path: "draft", verdict: "supported", reason: "supported", replacement: "", references: ["e_changed"] }] },
    { fields: [{ path: "draft", verdict: "supported", reason: "unsupported_fact", replacement: "" }] },
    { fields: [{ path: "draft", verdict: "supported", reason: "supported", replacement: "Changed text" }] },
    { fields: [{ path: "draft", verdict: "needs_revision", reason: "supported", replacement: "Changed text" }] },
  ])("rejects incomplete, unissued or provenance-editing reviewer output", async (output) => {
    const complete = vi.fn<AgentModel>(async () => reply("review_content_quality", output));
    await expect(reviewContent(complete, "fixture", [field("A trail mix")], {}, signal())).rejects.toMatchObject({ code: "content_review_protocol" });
    await expect(reviewContent(complete, "fixture", [field("A trail mix")], {}, signal(), { allowPartial: true }))
      .rejects.toMatchObject({ code: "content_review_protocol" });
  });

  it.each([
    { text: "A gluten-free snack.", quote: "A guilt-free snack.", violation: "uncited_dietary_claim" },
    { text: "A sugar-free snack.", quote: "Made with no refined sugar.", violation: "uncited_dietary_claim" },
    { text: "A light, nutrient-rich snack.", quote: "The publisher calls it nutrient-rich.", violation: "missing_claim_attribution" },
  ])("blocks an approved unsupported dietary interpretation: $text", async ({ text, quote, violation }) => {
    const draft = { ...field(text), role: "factual" as const, sources: [{ id: "e_1111111111111111", quote }] };
    expect(contentViolations(draft)).toContain(violation);
    const complete = vi.fn<AgentModel>(async (input) => approval(inputFor(input)));
    await expect(reviewContent(complete, "fixture", [draft], {}, signal())).rejects.toMatchObject({ code: "content_quality_failed" });
    expect(draft.text).toBe(text);
    expect(complete).toHaveBeenCalledOnce();
  });
  it("allows an attributed captured health claim and a directly supported dietary label without changing its qualifier", () => {
    expect(contentViolations({ ...field("The publisher describes this snack as nutrient-rich."), role: "factual" })).toEqual([]);
    expect(contentViolations({ ...field("A gluten-free snack."), role: "factual",
      sources: [{ id: "e_1111111111111111", quote: "Label: gluten-free." }] })).toEqual([]);
    expect(contentViolations({ ...field("Check whether the next formulation could be gluten-free."), role: "advisory" })).toEqual([]);
  });
  it("rejects duplicate paths even when the response count is correct", async () => {
    const complete = vi.fn<AgentModel>(async () => reply("review_content_quality", {
      fields: [0, 1].map(() => ({ path: "draft", verdict: "supported", reason: "supported", replacement: "" })),
    }));
    await expect(reviewContent(complete, "fixture", [field("A mix"), { ...field("Another mix"), path: "other" }], {}, signal()))
      .rejects.toMatchObject({ code: "content_review_protocol" });
  });
  it("prepares each review field only from its selected structured facts", async () => {
    const first = { ...field("Review the first product."), path: "first", sources: [{
      id: "e_1111111111111111", quote: '{"name":"First product"}', field: "name", truncated: false, structured: true,
    }] };
    const second = { ...field("Review the second product."), path: "second", sources: [{
      id: "e_2222222222222222", quote: '{"name":"Second product"}', field: "name", truncated: false, structured: true,
    }] };
    const complete = vi.fn<AgentModel>(async (input) => {
      const data = inputFor(input);
      expect(data.fields[0].factSheet.facts).toEqual([expect.objectContaining({ reference: first.sources[0].id, value: "First product" })]);
      expect(data.fields[1].factSheet.facts).toEqual([expect.objectContaining({ reference: second.sources[0].id, value: "Second product" })]);
      expect(data.context).toEqual({ completeLiveInventory: false });
      return approval(data);
    });
    await reviewContent(complete, "fixture", [first, second], { completeLiveInventory: false }, signal());
    expect(complete).toHaveBeenCalledOnce();
  });

  it("stops after failed verification and never runs another repair", async () => {
    const complete = vi.fn<AgentModel>(async () => reply("review_content_quality", {
      fields: [{ path: "draft", verdict: "needs_revision", reason: "unsupported_fact", replacement: "A trail mix" }],
    }));
    await expect(reviewContent(complete, "fixture", [field("Invented benefits")], {}, signal())).rejects.toMatchObject({ code: "content_quality_failed" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not confuse pack weight or an uncertain diagnostic quote with SEO nutrition", async () => {
    const diagnostic = field('The captured label says "Black Resin"; ask the owner to confirm this ambiguous ingredient.');
    const seo = { ...field("Trail mix in a 30g pack", "seo"), path: "seo" };
    expect(contentViolations(seo)).toEqual([]);
    const complete = vi.fn<AgentModel>(async (input) => approval(inputFor(input)));
    await reviewContent(complete, "fixture", [diagnostic, seo], {}, signal());
    expect(diagnostic.replace).not.toHaveBeenCalled();
  });

  it("requires attributed leadership and selected-source support for numerical summary claims", () => {
    const target = { ...field("The brand dominates snacks across 11 countries with prices from INR 50."), path: "briefing.summary.text" };
    expect(contentViolations(target)).toEqual(["missing_claim_attribution", "uncited_number"]);
    expect(contentViolations({ ...target, text: "The website claims to be a leading snack brand." })).toEqual([]);
  });

  it("confines unresolved ingredient terms to diagnostics, not consumer copy", () => {
    const diagnostic = field('Confirm what the label means by "Black Resin" with the owner.');
    expect(contentViolations(diagnostic)).toEqual([]);
    expect(contentViolations({ ...field("A mix with black resin."), forbiddenTerms: ["black resin"] })).toEqual(["ambiguous_ingredient"]);
    expect(contentViolations({ ...field("A resin craft material."), forbiddenTerms: [] })).toEqual([]);
  });

  it("does not turn sampled field limits into live ingredient-list repairs", () => {
    const title = { ...field("Complete ingredient list beyond truncation"), path: "recommendations.0.title", sampledEvidence: true };
    const detail = { ...title, path: "recommendations.0.detail", text: "Catalogue description ends with 'Sunflo' (truncated). Verify the full ingredient list and trailing components." };
    expect(contentViolations(title)).toEqual(["capture_limit_not_live_gap"]);
    expect(contentViolations(detail)).toEqual(["capture_limit_not_live_gap"]);
    expect(contentViolations({ ...detail, text: "Verify the captured ingredients against the current pack label." })).toEqual([]);
  });

  it("requires capture attribution for availability assertions without blocking current checks", () => {
    expect(contentViolations(field("The product is out of stock."))).toEqual(["unqualified_availability"]);
    expect(contentViolations(field("The captured listing is out of stock; verify current availability."))).toEqual([]);
    expect(contentViolations(field("Check current availability before launch."))).toEqual([]);
  });

  it("reviews a full-sized briefing without path-dependent provider grammar branches", async () => {
    const targets = Array.from({ length: 23 }, (_, index) => ({ ...field("Check the current pack label with the owner."), path: `text.${index}` }));
    const complete = vi.fn<AgentModel>(async (input) => {
      const schema = JSON.stringify(input.tools![0].input_schema);
      expect(schema).not.toContain('"null"');
      expect(schema).not.toContain("text.22");
      return approval(inputFor(input));
    });
    await reviewContent(complete, "fixture", targets, {}, signal());
    expect(complete).toHaveBeenCalledOnce();
  });

  it("rejects a mandatory correction retaining another deterministic violation", async () => {
    const target = field("Trail mix for INR 150 with 8g protein", "seo");
    const complete = vi.fn<AgentModel>(async () => reply("review_content_quality", {
      fields: [{ path: "draft", verdict: "needs_revision", reason: "volatile_copy", replacement: "Trail mix with 8g protein" }],
    }));
    await expect(reviewContent(complete, "fixture", [target], {}, signal())).rejects.toMatchObject({ code: "content_quality_failed" });
    expect(target.replace).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("rejects semantic repairs exceeding their field limit despite a valid generic grammar", async () => {
    const target = { ...field("Invented benefits"), maximum: 20 };
    const complete = vi.fn<AgentModel>(async () => reply("review_content_quality", {
      fields: [{ path: "draft", verdict: "needs_revision", reason: "unsupported_fact", replacement: "Check the current pack label with the owner." }],
    }));
    await expect(reviewContent(complete, "fixture", [target], {}, signal())).rejects.toMatchObject({ code: "content_quality_failed" });
    expect(target.replace).not.toHaveBeenCalled();
  });

  it("honors cancellation during review and does not apply a late correction", async () => {
    const controller = new AbortController(), target = field("A trail mix");
    const complete = vi.fn<AgentModel>(async (_, active) => {
      expect(active).toBe(controller.signal); controller.abort();
      return reply("review_content_quality", { fields: [{ path: "draft", verdict: "needs_revision", reason: "unsupported_fact", replacement: "Changed" }] });
    });
    await expect(reviewContent(complete, "fixture", [target], {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(target.replace).not.toHaveBeenCalled();
  });
  it("verifies only the changed field and commits no edit when verification fails", async () => {
    const safe = field("Recorded trail mix"), changed = { ...field("Unsupported benefit"), path: "changed" };
    const complete = vi.fn<AgentModel>(async (input) => {
      const data = inputFor(input) as ReviewInput;
      if (data.verificationOnly) {
        expect(data.fields.map((item) => item.path)).toEqual(["changed"]);
        expect(changed.replace).not.toHaveBeenCalled();
        return reply("review_content_quality", { fields: [{ path: "changed", verdict: "needs_revision",
          reason: "unsupported_fact", replacement: "" }] });
      }
      return reply("review_content_quality", { fields: data.fields.map((item) => ({ path: item.path,
        verdict: item.path === "changed" ? "needs_revision" : "supported",
        reason: item.path === "changed" ? "unsupported_fact" : "supported",
        replacement: item.path === "changed" ? "Recorded trail mix" : "" })) });
    });
    expect(await reviewContent(complete, "fixture", [safe, changed], {}, signal(), { allowPartial: true }))
      .toEqual({ rejected: [{ path: "changed", code: "content_quality_failed" }] });
    expect(safe.replace).not.toHaveBeenCalled();
    expect(changed.replace).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

const timestamp = "2026-11-17T12:00:00.000Z", origin = "http://127.0.0.1:5173";
const scan: ScanResult = {
  requestedUrl: "https://shop.example.com/", status: "complete", startedAt: timestamp, completedAt: timestamp,
  pages: [{ url: "https://shop.example.com/", capturedAt: timestamp, title: "Trail mix", description: "We sell trail mix.",
    text: "The website claims to be the leading snack brand. Ingredients: almonds, cranberries and seeds.",
    headings: [], contacts: [], callsToAction: [], links: [], warnings: [], productJson: [] }],
  failures: [], notes: [],
};
function productOutput(id: string) {
  const references = [id];
  return {
    summary: { text: "Review the recorded trail mix details.", references },
    dimensions: productDimensions.map((dimension) => ({ dimension,
      status: ["visuals", "discoverability", "customer_appeal"].includes(dimension) ? "not_assessed" : "needs_review",
      diagnosis: "Review the saved product information before making changes.", references })),
    rewrite: { title: "Trail mix", description: "A trail mix.", seoTitle: "Trail mix", metaDescription: "A trail mix for INR 150.", references },
    recommendations: [{ title: "Review pack information", detail: "Check the current pack label with the owner.", priority: "first" as const, references }],
  };
}

describe("real reviewer integration", () => {
  it.each(["briefing.summary.text", "briefing.insights.0.whyItMatters", "briefing.nextSteps.0.reason", "suggestions.0.value"])(
    "withholds the complete optional section containing %s while preserving supported findings", async (failedPath) => {
      const excerpt = [...buildAgentEvidence(scan).sources][0];
      const complete = vi.fn<AgentModel>(async (input) => {
        const name = input.tool_choice?.type === "tool" ? input.tool_choice.name : "";
        if (name === "scan_website") return reply(name, {});
        if (name === "propose_business") return reply(name, { suggestions: [{ field: "category", value: "Snacks", sources: [excerpt[0]] }],
          briefing: { summary: { text: "The captured page describes trail mix.", sources: [excerpt[0]] },
            insights: [{ area: "offering", text: "The captured page describes trail mix.", whyItMatters: "Check buyer preferences.", sources: [excerpt[0]] }],
            unknowns: [], nextSteps: [{ action: "Check current labels.", reason: "Confirm the current product information." }] } });
        const data = inputFor(input) as ReviewInput;
        return reply(name, { fields: data.fields.map((item) => ({ path: item.path,
          verdict: item.path === failedPath ? "needs_revision" : "supported",
          reason: item.path === failedPath ? "unsupported_fact" : "supported", replacement: "" })) });
      });
      const result = await createBusinessAgent({ complete }).run(scan.requestedUrl, async () => scan, signal());
      expect(result.validationIssues).toContainEqual({ path: failedPath, code: "content_quality_failed" });
      expect(result.briefing).not.toBeNull();
      if (failedPath.includes("summary")) expect(result.briefing?.summary).toBeUndefined();
      if (failedPath.includes("insights")) expect(result.briefing?.insights).toEqual([]);
      if (failedPath.includes("nextSteps")) expect(result.briefing?.nextSteps).toEqual([]);
      if (failedPath.includes("suggestions")) expect(result.suggestions).toEqual([]);
      expect(complete).toHaveBeenCalledTimes(3);
    });
  it("never disguises an invalid reviewer protocol as a partial briefing", async () => {
    const excerpt = [...buildAgentEvidence(scan).sources][0];
    const complete = vi.fn<AgentModel>(async (input) => {
      const name = input.tool_choice?.type === "tool" ? input.tool_choice.name : "";
      if (name === "scan_website") return reply(name, {});
      if (name === "propose_business") return reply(name, { suggestions: [], briefing: {
        summary: { text: "The captured page describes trail mix.", sources: [excerpt[0]] },
        insights: [], unknowns: [], nextSteps: [],
      } });
      return reply(name, { fields: [] });
    });
    await expect(createBusinessAgent({ complete }).run(scan.requestedUrl, async () => scan, signal()))
      .rejects.toMatchObject({ code: "content_review_protocol" });
  });
  it.each(["ingredient", "ingredient-json", "sampling"] as const)("blocks an approved product %s violation using actual evidence metadata", async (mode) => {
    const ingredient = mode !== "sampling";
    const product: Product = { id: randomUUID(), businessId: randomUUID(), name: "Trail mix",
      description: `${mode === "ingredient-json" ? "Small pack. Roasted almonds, Black Resin and seeds." : "Ingredients: almonds, Black Resin and seeds."} ${"Recorded catalogue context. ".repeat(25)}`,
      sku: "", gtin: "", createdAt: timestamp, updatedAt: timestamp, listings: [] };
    const complete = vi.fn<AgentModel>(async (input) => {
      const data = inputFor(input);
      const name = input.tool_choice?.type === "tool" ? input.tool_choice.name : "";
      if (name === "submit_product_analysis") {
        const description = data.evidence.find((item: { field: string }) => item.field === "description");
        const output = productOutput(description.id);
        output.rewrite.metaDescription = "Trail mix";
        output.rewrite.description = ingredient ? "A mix with Black Resin." : "A trail mix.";
        if (mode === "sampling") output.recommendations[0].title = "Complete ingredient list beyond truncation";
        return reply(name, output);
      }
      const target = data.fields.find((item: { path: string }) => item.path === (ingredient ? "rewrite.description" : "recommendations.0.title"));
      expect(target.violations).toContain(ingredient ? "ambiguous_ingredient" : "capture_limit_not_live_gap");
      return approval(data);
    });
    await expect(createProductAnalyst({ complete }).run(product, signal())).rejects.toMatchObject({ code: "content_quality_failed" });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(product.description).toContain("Black Resin");
  });

  it("reviews business claims and captured-field gaps before resolving unchanged citations", async () => {
    const excerpt = [...buildAgentEvidence(scan).sources].find(([, source]) => source.quote.includes("leading"))!;
    const complete = vi.fn<AgentModel>(async (input) => {
      const name = input.tool_choice?.type === "tool" ? input.tool_choice.name : "";
      if (name === "scan_website") return reply(name, {});
      if (name === "propose_business") return reply(name, { suggestions: [], briefing: {
        summary: { text: "This brand dominates snacks.", sources: [excerpt[0]] },
        insights: [{ area: "offering", text: "The site lists almonds and seeds.", whyItMatters: "Check suitability with customers.", sources: [excerpt[0]] }],
        unknowns: [], nextSteps: [{ action: "Complete the missing ingredient list.", reason: "The website lacks ingredients." }],
      } });
      const data = inputFor(input) as ReviewInput;
      if (data.verificationOnly) return approval(data);
      return reply(name, {
        fields: data.fields.map((item) => item.path === "briefing.summary.text"
        ? { path: item.path, verdict: "needs_revision", reason: "missing_attribution", replacement: "The website claims to be a leading snack brand." }
        : item.path.startsWith("briefing.nextSteps.")
          ? { path: item.path, verdict: "needs_revision", reason: "already_captured", replacement: "Verify the captured ingredient list against the current pack label." }
          : { path: item.path, verdict: "supported", reason: "supported", replacement: "" }) });
    });
    const result = await createBusinessAgent({ complete }).run(scan.requestedUrl, async () => scan, signal());
    expect(result.briefing?.summary?.text).toContain("website claims");
    expect(result.briefing?.summary?.sources).toEqual([excerpt[1]]);
    expect(result.briefing?.nextSteps[0].action).toContain("captured ingredient list");
    expect(complete).toHaveBeenCalledTimes(4);
    const shortened = structuredClone(scan); shortened.pages[0].text = "Recorded ingredients. ".repeat(1000);
    expect(buildAgentEvidence(shortened).payload.pages[0].excerpts.some((item) => item.field === "text" && item.truncated)).toBe(true);
    expect(buildAgentEvidence(scan).payload.pages[0].excerpts.some((item) => item.field === "text" && !item.truncated)).toBe(true);
  });

  it.each([false, true])("does not save failed review and invalidates only old analysis cache (reject=%s)", async (reject) => {
    const directory = mkdtempSync(join(tmpdir(), "gp-quality-")), store = openStore(join(directory, "test.sqlite"));
    try {
      const user = { id: randomUUID(), name: "Fixture", email: `${randomUUID()}@example.test` }, session = newSession();
      await store.createAccount(user, "fixture hash", session.tokenHash, session.expiresAt);
      const business = (await store.saveBusiness(user.id, { name: "Fixture", website: "", category: "", description: "" }))!;
      const product = (await store.saveProduct(user.id, business.id, { ...emptyProduct, name: "Trail mix", description: "A trail mix." }))!;
      const evidence = productEvidence(product), legacy = {
        id: randomUUID(), productId: product.id, fingerprint: productFingerprint(product), createdAt: timestamp,
        result: { ...productOutput(evidence[0].id), dimensions: productOutput(evidence[0].id).dimensions.map((item) => ({
          ...item, status: "not_assessed" as const,
        })) }, evidence,
      };
      const lease = await store.beginProductAnalysis(user.id, business.id, product.id, legacy.fingerprint);
      await store.finishProductAnalysis(user.id, business.id, legacy, lease);
      const complete = vi.fn<AgentModel>(async (input) => {
        const data = inputFor(input);
        const name = input.tool_choice?.type === "tool" ? input.tool_choice.name : "";
        if (name === "submit_product_analysis") return reply(name, productOutput(data.evidence[0].id));
        if (reject) return reply(name, { fields: [] });
        if (data.verificationOnly) return approval(data);
        return reply(name, { fields: (data as ReviewInput).fields.map((item) => ({
          path: item.path, verdict: item.path === "rewrite.metaDescription" ? "needs_revision" : "supported",
          reason: item.path === "rewrite.metaDescription" ? "volatile_copy" : "supported",
          replacement: item.path === "rewrite.metaDescription" ? "A trail mix." : "",
        })) });
      });
      const scanner = vi.fn(async () => { throw new Error("No scan allowed."); });
      const app = createApp({ store, scanner, productAnalyst: createProductAnalyst({ complete }) });
      const endpoint = `/api/businesses/${business.id}/products/${product.id}/intelligence`, cookie = `gp_session=${session.token}`;
      const before = await request(app).get(endpoint).set("Cookie", cookie).expect(200);
      expect(before.body).toMatchObject({ stale: true, analysis: { id: legacy.id } });
      await request(app).post(endpoint).set("Cookie", cookie).set("Origin", origin).send({ consent: true }).expect(reject ? 502 : 200);
      const current = (await request(app).get(endpoint).set("Cookie", cookie).expect(200)).body;
      expect(current).toMatchObject(reject ? { running: false, stale: true, analysis: { id: legacy.id }, error: expect.stringContaining("review") }
        : { running: false, stale: false, analysis: { fingerprint: productAnalysisFingerprint(product), result: { rewrite: { metaDescription: "A trail mix." } } } });
      expect(await store.listProducts(user.id, business.id)).toEqual([product]);
      expect(productFingerprint(product)).toBe(legacy.fingerprint);
      expect(scanner).not.toHaveBeenCalled();
    } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("reviews one canonical target per product without changing scope or target ownership", async () => {
    const product: Product = { id: randomUUID(), businessId: randomUUID(), name: "Trail mix", description: "Recorded mix", sku: "", gtin: "",
      createdAt: timestamp, updatedAt: timestamp, listings: [] };
    const action: GrowthOpportunity = { id: "a".repeat(64), title: "Review a trail mix pack", detail: "Check pack information before testing.",
      agents: ["growth"], sources: [{ id: "e_1111111111111111", quote: "Recorded pack information.", url: scan.requestedUrl, capturedAt: timestamp }],
      reviewReason: "Owner review", strategy: { objective: "Clearer information", actions: ["Review the pack"], metric: "Feedback",
        hypothesis: "Information may help.", measurement: "Record feedback." } };
    const complete = vi.fn<AgentModel>(async (input) => {
      const data = inputFor(input);
      const name = input.tool_choice?.type === "tool" ? input.tool_choice.name : "";
      if (name === "review_content_quality") return approval(data);
      expect(data.catalogue).toHaveLength(1);
      return reply(name, { scope: "product", reason: "Review the named pack.", references: [data.evidence[0].id],
        candidates: [{ catalogueReference: data.catalogue[0].matchReference, reason: "Tentative match by recorded name; confirm suitability." }] });
    });
    const decision = await createGrowthAdvisor({ complete }).decide(action, product.businessId, [product], origin, signal());
    expect(decision.scope).toBe("product");
    expect(decision.candidates[0].productId).toBe(product.id);
    expect(decision.candidates[0].sources[0].url).toContain(`product=${product.id}`);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
