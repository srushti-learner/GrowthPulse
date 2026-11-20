import { describe, expect, it, vi } from "vitest";
import type { AgentModel } from "./business-agent.js";
import { catalogueFingerprint, createGrowthAdvisor, knownProductDecision, selectionIsStale } from "./growth-advisor.js";
import { productFingerprint } from "./product-intelligence.js";
import type { GrowthOpportunity } from "../shared/growth.js";
import { emptyProduct, type Product } from "../shared/products.js";
vi.mock("./content-quality.js", async (original) => ({ ...await original<typeof import("./content-quality.js")>(), reviewContent: vi.fn(async () => ({ rejected: [] })) }));

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
type Input = { action: { title: string }; scope?: string; evidence: { id: string }[]; catalogue: { productId: string; name: string; matchReference: string; evidence: { id: string; quote: string }[] }[] };
const inputFor = (input: Parameters<AgentModel>[0]) => JSON.parse(String(input.messages[0].content)) as Input;
const reply = (input: unknown, name = "submit_action_guidance") => ({ stop_reason: "tool_use" as const, content: [{ type: "tool_use" as const, id: "fixture", name, input }] });
const signal = () => new AbortController().signal;

describe("scope-aware growth advisor", () => {
  it("does not correct overlong guidance that also cites unissued evidence", async () => {
    const complete = vi.fn<AgentModel>().mockResolvedValue(reply({
      scope: "business", reason: "Owner review required. ".repeat(35), references: ["e_ffffffffffffffff"], candidates: [],
    }));
    await expect(createGrowthAdvisor({ complete }).decide(action, businessId, products, origin, signal())).rejects.toMatchObject({ status: 502 });
    expect(complete).toHaveBeenCalledOnce();
  });
  it.each(["valid", "still-overlong", "changed-citation"] as const)("bounds a string-only correction (%s)", async (result) => {
    const complete = vi.fn<AgentModel>(async (input) => {
      const data = JSON.parse(String(input.messages[0].content));
      if (!data.fields) return reply({
        scope: "business", reason: "Owner review required. ".repeat(35), references: [data.evidence[0].id], candidates: [],
      });
      expect(data.fields).toEqual([{ path: "reason", maximum: 600, text: "Owner review required. ".repeat(35) }]);
      expect(input.tool_choice).toMatchObject({ name: "shorten_action_fields" });
      return reply({ fields: [{ path: "reason", text: result === "still-overlong" ? data.fields[0].text : "Owner review required." }],
        ...(result === "changed-citation" ? { references: ["e_ffffffffffffffff"] } : {}) }, "shorten_action_fields");
    });
    const running = createGrowthAdvisor({ complete }).decide(action, businessId, products, origin, signal());
    if (result === "valid") expect(await running).toMatchObject({ scope: "business", reason: "Owner review required." });
    else await expect(running).rejects.toMatchObject({ status: 502 });
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it("keeps multiple products and their own evidence, without guessing bundle suitability", async () => {
    const complete = vi.fn<AgentModel>(async (input) => {
      const data = inputFor(input);
      expect(data.catalogue).toHaveLength(2);
      const providerSchema = JSON.parse(JSON.stringify(input.tools?.[0])).input_schema;
      const resolve = (node: { $ref?: string; properties?: Record<string, unknown>; enum?: string[] }) =>
        node.$ref ? providerSchema.$defs[node.$ref.split("/").at(-1)] : node;
      const candidateSchema = resolve(providerSchema.properties.candidates.items);
      expect(Object.keys(candidateSchema.properties).sort()).toEqual(["catalogueReference", "reason"]);
      expect(resolve(candidateSchema.properties.catalogueReference).enum).toEqual(data.catalogue.map((product) => product.matchReference));
      expect(data.catalogue[0].evidence.some((item) => item.quote.includes('"variants"'))).toBe(true);
      const firstIds = new Set(data.catalogue[0].evidence.map((item) => item.id));
      expect(data.catalogue[1].evidence.some((item) => firstIds.has(item.id))).toBe(false);
      return reply({ scope: "products", reason: "Two categories are explicitly proposed; compatibility still needs owner review.",
        references: [data.evidence[0].id], candidates: data.catalogue.map((product) => ({
          catalogueReference: product.evidence[0].id, reason: "Its recorded category supports a candidate role, not verified bundle suitability.",
        })) });
    });
    const result = await createGrowthAdvisor({ complete }).decide(action, businessId, products, origin, signal());
    expect(result.candidates.map((candidate) => candidate.productId)).toEqual(products.map((product) => product.id));
    expect(result.candidates[1].sources[0].url).toContain(`product=${products[1].id}`);
    expect(result.catalogueFingerprint).toBe(catalogueFingerprint(products));
    expect(complete).toHaveBeenCalledOnce();
  });
  it.each(["valid", "duplicate-path"] as const)("corrects only nested overlong text while preserving the chosen catalogue reference (%s)", async (mode) => {
    let chosenReference = "";
    const complete = vi.fn<AgentModel>(async (input) => {
      const data = JSON.parse(String(input.messages[0].content));
      if (!data.fields) {
        chosenReference = data.catalogue[1].matchReference;
        return reply({ scope: "product", reason: "Await owner approval. ".repeat(35), references: [data.evidence[0].id],
          candidates: [{ catalogueReference: chosenReference, reason: "Candidate role requires owner review. ".repeat(15) }] });
      }
      expect(data.fields.map((field: { path: string }) => field.path)).toEqual(["reason", "candidates.0.reason"]);
      return reply({ fields: data.fields.map((field: { path: string }) => ({
        path: mode === "duplicate-path" ? "reason" : field.path, text: "Owner approval required.",
      })) }, "shorten_action_fields");
    });
    const running = createGrowthAdvisor({ complete }).decide(action, businessId, products, origin, signal());
    if (mode === "duplicate-path") await expect(running).rejects.toMatchObject({ status: 502 });
    else expect(await running).toMatchObject({ scope: "product", reason: "Owner approval required.",
      candidates: [{ productId: products[1].id, reason: "Owner approval required.", sources: [{ id: chosenReference }] }] });
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it.each(["business", "new_product", "unclear"] as const)("does not force products for %s work, including an empty catalogue", async (scope) => {
    const complete = vi.fn<AgentModel>(async (input) => reply({
      scope, reason: "The recommendation does not establish an existing-product target.", references: [inputFor(input).evidence[0].id], candidates: [],
    }));
    const result = await createGrowthAdvisor({ complete }).decide(action, businessId, [], origin, signal());
    expect(result).toMatchObject({ scope, candidates: [] });
  });
  it.each(["action-only-reference", "invented-reference", "one-product-bundle", "duplicate-products"] as const)(
    "rejects %s rather than saving plausible-looking invalid guidance", async (failure) => {
      const complete = vi.fn<AgentModel>(async (input) => {
        const data = inputFor(input);
        const candidates = data.catalogue.map((product) => ({ catalogueReference: product.evidence[0].id, reason: "Candidate." }));
        if (failure === "action-only-reference") candidates[0].catalogueReference = data.evidence[0].id;
        if (failure === "invented-reference") candidates[0].catalogueReference = "e_ffffffffffffffff";
        if (failure === "one-product-bundle") candidates.pop();
        if (failure === "duplicate-products") candidates[1].catalogueReference = data.catalogue[0].evidence[1].id;
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
      return reply({ steps: [{ title: "Review the proposed bundle role", detail: "For the confirmed target, check category, availability and baseline before approving.", references: [data.evidence[0].id] }] });
    });
    const result = await createGrowthAdvisor({ complete }).propose(action, {
      scope: "product", products: [{ productId: products[1].id, fingerprint: productFingerprint(products[1]) }], confirmedAt: timestamp,
    }, businessId, products, origin, signal());
    expect(result).toMatchObject([{ status: "draft", origin: "action", outcome: "",
      targetProducts: [{ productId: products[1].id, name: "Lip colour", fingerprint: productFingerprint(products[1]) }] }]);
    expect(result[0].sources[0].quote).toBe(action.sources[0].quote);
  });
  it.each(["preserved", "abbreviated"] as const)("keeps confirmed identity outside text shortening (%s)", async (mode) => {
    const complete = vi.fn<AgentModel>(async (input) => {
      const data = JSON.parse(String(input.messages[0].content));
      if (!data.fields) return reply({ steps: [{ title: "Review the proposed bundle role",
        detail: `For Lip colour, ${"confirm category, availability and baseline before approving. ".repeat(12)}`,
        references: [data.evidence[0].id] }] });
      expect(data.fields).toMatchObject([{ path: "steps.0.detail", maximum: 600 }]);
      expect(data.fields[0]).not.toHaveProperty("targetProducts");
      return reply({ fields: [{ path: "steps.0.detail",
        text: `For ${mode === "preserved" ? "Lip colour" : "the lip item"}, verify availability and record a baseline before owner approval.` }] }, "shorten_action_fields");
    });
    const running = createGrowthAdvisor({ complete }).propose(action, {
      scope: "product", products: [{ productId: products[1].id, fingerprint: productFingerprint(products[1]) }], confirmedAt: timestamp,
    }, businessId, products, origin, signal());
    expect(await running).toMatchObject([{ targetProducts: [{ productId: products[1].id, name: "Lip colour" }],
      sources: [{ quote: action.sources[0].quote }] }]);
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it.each(["discount", "price"] as const)("rejects invented %s in supporting steps rather than saving a misleading draft", async (failure) => {
    const complete = vi.fn<AgentModel>(async (input) => reply({ steps: [{
      title: "Review the bundle",
      detail: failure === "discount" ? "Offer Lip colour at a 12% discount."
        : "Set Lip colour at INR 275.",
      references: [inputFor(input).evidence[0].id],
    }] }));
    await expect(createGrowthAdvisor({ complete }).propose(action, {
      scope: "product", products: [{ productId: products[1].id, fingerprint: productFingerprint(products[1]) }], confirmedAt: timestamp,
    }, businessId, products, origin, signal())).rejects.toMatchObject({ status: 502 });
    expect(complete).toHaveBeenCalledOnce();
  });
  it("attaches every confirmed product even when short prose contains no product names", async () => {
    const complete = vi.fn<AgentModel>(async (input) => reply({ steps: [{
      title: "Check the confirmed group", detail: "Verify current availability and compatibility before owner approval.",
      references: [inputFor(input).evidence[0].id],
    }] }));
    const result = await createGrowthAdvisor({ complete }).propose(action, {
      scope: "products", products: products.map((product) => ({ productId: product.id, fingerprint: productFingerprint(product) })),
      confirmedAt: timestamp,
    }, businessId, products, origin, signal());
    expect(result[0].targetProducts).toEqual(products.map((product) => ({
      productId: product.id, name: product.name, fingerprint: productFingerprint(product),
    })));
    expect(result[0].detail).not.toContain(products[0].name);
  });
});
