import { describe, expect, it, vi } from "vitest";
import { benchmarkCasesSchema, runReviewerBenchmark } from "./agent-benchmark.js";
import type { AgentModel } from "./business-agent.js";

const cases = benchmarkCasesSchema.parse([{ id: "fixture", fields: [
  { path: "safe", text: "Check current labels.", maximum: 150, role: "advisory", sources: [], expected: "supported" },
  { path: "unsafe", text: "This guarantees stronger sales.", maximum: 150, role: "advisory", sources: [],
    expected: "needs_revision", disallowedPhrases: ["guarantees"] },
] }]);
const approval: AgentModel = async (input) => ({
  stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 30 },
  content: [{ type: "tool_use", id: "fixture", name: "review_content_quality", input: {
    fields: JSON.parse(String(input.messages[0].content)).fields.map((field: { path: string }) => ({
      path: field.path, verdict: "supported", reason: "supported", replacement: "",
    })),
  } }],
});

describe("bounded reviewer comparisons", () => {
  it("compares identical immutable cases and reports an approving model's known miss rather than claiming success", async () => {
    const complete = vi.fn(approval);
    const before = structuredClone(cases);
    const report = await runReviewerBenchmark(complete, cases, ["baseline", "stronger"], 2);
    expect(report.complete).toBe(true);
    expect(report.results.map((result) => result.knownIssueMisses)).toEqual([1, 1]);
    expect(report.results.map((result) => result.inputTokens)).toEqual([100, 100]);
    expect(complete.mock.calls.map(([input]) => input.model)).toEqual(["baseline", "stronger"]);
    expect(cases).toEqual(before);
  });
  it("stops at the shared call ceiling without silently running the second model", async () => {
    const complete = vi.fn(approval);
    const report = await runReviewerBenchmark(complete, cases, ["baseline", "stronger"], 1);
    expect(report).toMatchObject({ complete: false, calls: 1 });
    expect(report.results).toHaveLength(1);
    expect(complete).toHaveBeenCalledOnce();
  });
  it("distinguishes safe rejection from useful accepted output", async () => {
    const unsafe = benchmarkCasesSchema.parse([{ id: "volatile", fields: [{
      path: "seo", text: "Trail mix for INR 150", role: "factual", policy: "seo", maximum: 150, sources: [],
      expected: "needs_revision",
    }] }]);
    const report = await runReviewerBenchmark(approval, unsafe, ["baseline"], 2);
    expect(report.results[0]).toMatchObject({ outcome: "rejected", acceptedNonemptyFields: 0, knownIssueMisses: 0 });
  });
});
