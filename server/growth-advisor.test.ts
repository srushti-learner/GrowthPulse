import { describe, expect, it, vi } from "vitest";
import type { AgentModel } from "./business-agent.js";
import { catalogueFingerprint, createGrowthAdvisor, knownProductDecision, selectionIsStale } from "./growth-advisor.js";
import { productFingerprint } from "./product-intelligence.js";
import type { GrowthOpportunity } from "../shared/growth.js";
import { emptyProduct, type Product } from "../shared/products.js";

const businessId = "02a221ee-41f1-46c9-bc96-12401d8dcf73", origin = "https://growth.example.com";
const timestamp = "2026-11-17T12:00:00.000Z";
const products: Product[] = ["509e12ce-3028-4ed1-bdf7-329a26d470d8", "63243bee-1f3a-40db-a516-93b04d40f797"].map((id, index) => ({
  id, businessId, name: index ? "Lip colour" : "Eye palette", description: "Recorded colours for owner review.", sku: "", gtin: "",
  createdAt: timestamp, updatedAt: timestamp, listings: [{
    id, source: "manual", sourceName: "Fixture", reference: "CSV row 1", sourceKey: id, capturedAt: timestamp,
    data: { ...emptyProduct, name: index ? "Lip colour" : "Eye palette", availability: "in_stock", variants: "Colour: blue" },
  }],
}));
const action: GrowthOpportunity = {
  id: "a".repeat(64), title: "Test a seasonal eye and lip bundle", detail: "Review a two-category bundle before launching.",
  agents: ["growth"], sources: [{ id: "e_1111111111111111", url: "https://shop.example.com/", quote: "Eye and lip products are listed.", capturedAt: timestamp }],
  reviewReason: "Owner validation required.", strategy: { objective: "Test simpler choice", actions: ["Validate a bundle."], metric: "Conversion",
    hypothesis: "Choice may be simpler.", measurement: "Record a baseline." },
};
type Input = { action: { title: string }; scope?: string; evidence: { id: string }[]; catalogue: { productId: string; evidence: { id: string; quote: string }[] }[] };
const inputFor = (input: Parameters<AgentModel>[0]) => JSON.parse(String(input.messages[0].content)) as Input;
const reply = (input: unknown) => ({ stop_reason: "tool_use" as const, content: [{ type: "tool_use" as const, id: "fixture", name: "submit_action_guidance", input }] });
const signal = () => new AbortController().signal;

describe("scope-aware growth advisor", () => {
  it("keeps multiple products and their own evidence, without guessing bundle suitability", async () => {
    const complete = vi.fn<AgentModel>(async (input) => {
      const data = inputFor(input);
      expect(data.catalogue).toHaveLength(2);
      expect(data.catalogue[0].evidence.some((item) => item.quote.includes('"variants"'))).toBe(true);
      const firstIds = new Set(data.catalogue[0].evidence.map((item) => item.id));
      expect(data.catalogue[1].evidence.some((item) => firstIds.has(item.id))).toBe(false);
      return reply({ scope: "products", reason: "Two categories are explicitly proposed; compatibility still needs owner review.",
        references: [data.evidence[0].id], candidates: data.catalogue.map((product) => ({
          productId: product.productId, reason: "Its recorded category supports a candidate role, not verified bundle suitability.", references: [product.evidence[0].id],
        })) });
    });
    const result = await createGrowthAdvisor({ complete }).decide(action, businessId, products, origin, signal());
    expect(result.candidates.map((candidate) => candidate.productId)).toEqual(products.map((product) => product.id));
    expect(result.candidates[1].sources[0].url).toContain(`product=${products[1].id}`);
    expect(result.catalogueFingerprint).toBe(catalogueFingerprint(products));
    expect(complete).toHaveBeenCalledOnce();
  });
  it.each(["business", "new_product", "unclear"] as const)("does not force products for %s work, including an empty catalogue", async (scope) => {
    const complete = vi.fn<AgentModel>(async (input) => reply({
      scope, reason: "The recommendation does not establish an existing-product target.", references: [inputFor(input).evidence[0].id], candidates: [],
    }));
    const result = await createGrowthAdvisor({ complete }).decide(action, businessId, [], origin, signal());
    expect(result).toMatchObject({ scope, candidates: [] });
  });
  it.each(["foreign-product", "wrong-product-citation", "invented-citation", "one-product-bundle", "duplicate-candidates"] as const)(
    "rejects %s rather than saving plausible-looking invalid guidance", async (failure) => {
      const complete = vi.fn<AgentModel>(async (input) => {
        const data = inputFor(input);
        const candidates = data.catalogue.map((product) => ({ productId: product.productId, reason: "Candidate.", references: [product.evidence[0].id] }));
        if (failure === "foreign-product") candidates[0].productId = "abcdefab-1234-4234-8234-abcdefabcdef";
        if (failure === "wrong-product-citation") candidates[0].references = [data.catalogue[1].evidence[0].id];
        if (failure === "invented-citation") candidates[0].references = ["e_ffffffffffffffff"];
        if (failure === "one-product-bundle") candidates.pop();
        if (failure === "duplicate-candidates") candidates[1] = candidates[0];
        return reply({ scope: "products", reason: "Bundle.", references: [data.evidence[0].id], candidates });
      });
      await expect(createGrowthAdvisor({ complete }).decide(action, businessId, products, origin, signal())).rejects.toMatchObject({ status: 502 });
      expect(complete).toHaveBeenCalledOnce();
    });
  it("preserves owned product origin without AI, validates old links, and detects changed or missing confirmed targets", () => {
    expect(knownProductDecision({ ...action, originProductId: products[0].id }, businessId, products, origin)?.candidates[0].productId).toBe(products[0].id);
    const linked = { ...action, sources: [{ ...action.sources[0], url: `${origin}/#products?business=${businessId}&product=${products[1].id}` }] };
    expect(knownProductDecision(linked, businessId, products, `${origin}/`)?.candidates[0].productId).toBe(products[1].id);
    expect(knownProductDecision(linked, products[0].id, products, origin)).toBeNull();
    expect(knownProductDecision(linked, businessId, products, "https://other.example.com")).toBeNull();
    expect(knownProductDecision({ ...action, originProductId: products[0].id }, businessId, [], origin)).toBeNull();
    const selected = { scope: "product" as const, products: [{ productId: products[0].id, fingerprint: productFingerprint(products[0]) }], confirmedAt: timestamp };
    expect(selectionIsStale(selected, products)).toBe(false);
    expect(selectionIsStale(selected, [products[1]])).toBe(true);
    expect(selectionIsStale(selected, [{ ...products[0], description: "Changed details." }])).toBe(true);
  });
  it("passes the actual action, confirmed scope and only selected products when generating supporting work", async () => {
    const complete = vi.fn<AgentModel>(async (input) => {
      const data = inputFor(input);
      expect(data.action.title).toBe(action.title); expect(data.scope).toBe("product");
      expect(data.catalogue.map((product) => product.productId)).toEqual([products[1].id]);
      return reply({ steps: [{ title: "Review the proposed bundle role", detail: "Confirm category, availability and baseline before approving.", references: [data.evidence[0].id] }] });
    });
    const result = await createGrowthAdvisor({ complete }).propose(action, {
      scope: "product", products: [{ productId: products[1].id, fingerprint: productFingerprint(products[1]) }], confirmedAt: timestamp,
    }, businessId, products, origin, signal());
    expect(result).toMatchObject([{ status: "draft", origin: "action", outcome: "" }]);
    expect(result[0].sources[0].quote).toBe(action.sources[0].quote);
  });
});
