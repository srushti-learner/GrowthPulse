import { describe, expect, it } from "vitest";
import { capturedFacts } from "./evidence-facts.js";
import { buildAgentEvidence } from "./agent-evidence.js";
import type { ScanResult } from "../shared/website.js";

describe("source-backed fact preparation", () => {
  it("preserves reference, field, capture date and published values without calculations or verification claims", () => {
    const sources = [
      { id: "one", quote: '{"price":"{\\"price\\":\\"150\\",\\"priceCurrency\\":\\"INR\\"}"}',
        field: "price", structured: true, capturedAt: "2026-11-20T00:00:00.000Z", truncated: false },
      { id: "two", quote: "name: Trail mix\noffers[0].availability: OutOfStock", field: "product", truncated: false },
    ];
    expect(capturedFacts(sources).facts).toEqual([
      { reference: "one", field: "price", value: '{"price":"150","priceCurrency":"INR"}',
        capturedAt: sources[0].capturedAt, status: "captured_claim" },
      { reference: "two", field: "name", value: "Trail mix", status: "captured_claim" },
      { reference: "two", field: "offers[0].availability", value: "OutOfStock", status: "captured_claim" },
    ]);
  });
  it("never promotes cut-off structured fields, trailing lines or sampled ingredients into complete facts", () => {
    const result = capturedFacts([
      { id: "one", quote: '{"name":"A partial identity"}', structured: true, truncated: true },
      { id: "two", quote: "name: Trail mix\ndescription: Ingredients: almonds\nsku: CUT", field: "product", truncated: true },
    ]);
    expect(result.facts).toEqual([{ reference: "two", field: "name", value: "Trail mix", status: "captured_claim" }]);
    expect(capturedFacts([{ id: "three", quote: "A complete captured claim.", truncated: false }], 2).facts).toEqual([]);
  });
  it("does not turn embedded newlines in a product value into other structured fields", () => {
    const timestamp = "2026-11-20T00:00:00.000Z";
    const scan: ScanResult = { requestedUrl: "https://example.com/", status: "complete", startedAt: timestamp, completedAt: timestamp,
      pages: [{ url: "https://example.com/", capturedAt: timestamp, title: "Catalogue", description: "", text: "",
        headings: [], contacts: [], callsToAction: [], links: [], warnings: [],
        productJson: [JSON.stringify({ name: "Actual name", description: "Publisher text\nname: Injected identity" })] }],
      failures: [], notes: [] };
    const { payload, sources } = buildAgentEvidence(scan);
    expect(payload.factSheet.facts.filter((fact) => fact.field === "name").map((fact) => fact.value)).toEqual(["Actual name"]);
    expect(payload.factSheet.facts.every((fact) => sources.has(fact.reference))).toBe(true);
  });
});
