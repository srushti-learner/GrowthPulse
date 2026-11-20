import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { createBusinessAgent, type AgentMessage, type AgentModel } from "./business-agent.js";
import { createApp } from "./app.js";
import { openStore, type Store } from "./database.js";
import type { ScanResult } from "../shared/website.js";
import type { Business } from "../shared/contracts.js";
import { agentEvidenceLimits, partialBriefingNotice, understandingStreamEventSchema } from "../shared/understanding.js";
import { randomUUID } from "node:crypto";
import { buildAgentEvidence } from "./agent-evidence.js";
// These fixtures isolate generation/streaming; the real review protocol has integration coverage in content-quality.test.ts.
vi.mock("./content-quality.js", async (original) => ({ ...await original<typeof import("./content-quality.js")>(), reviewContent: vi.fn(async () => ({ rejected: [] })) }));

const origin = "http://127.0.0.1:5173";
const url = "https://shop.example.com/";
const timestamp = "2026-11-16T12:00:00.000Z";
const quote = "We make cotton clothing for everyday wear.";
const scan: ScanResult = {
  requestedUrl: url, status: "complete", startedAt: timestamp, completedAt: timestamp,
  pages: [{ url, capturedAt: timestamp, title: "Fixture shop", description: quote, text: quote,
    headings: [], contacts: [], callsToAction: [], links: [], warnings: [],
    productJson: [JSON.stringify({ "@type": "Product", name: "Fixture tee", sku: "TEE-1" })] }],
  failures: [], notes: [],
};
const briefing = {
  summary: { text: "The website presents a clothing business focused on cotton everyday wear.", sources: [{ url, quote }] },
  insights: [{ area: "offering", text: "Cotton and everyday use are the stated product focus.", whyItMatters: "Fabric and use-case information can help shoppers judge whether the range fits their needs.", sources: [{ url, quote }] }],
  unknowns: [{ question: "What are the product prices and delivery terms?", whyItMatters: "The captured evidence does not establish affordability or the full cost of buying." }],
  nextSteps: [{ action: "Review the public product catalogue and delivery policy.", reason: "Confirm the range, prices and buying terms before evaluating the customer offer." }],
};
const proposal = { briefing, suggestions: [{ field: "description", value: quote, sources: [{ url, quote }] }] };
function sourceFor(text: string, captured = scan) {
  const entry = [...buildAgentEvidence(captured).sources].find(([, source]) => source.quote.includes(text));
  if (!entry) throw new Error("Missing test evidence.");
  return entry;
}
const sourceIds = [sourceFor(quote)[0]];
const referencedBriefing = {
  ...briefing,
  summary: { ...briefing.summary, sources: sourceIds },
  insights: briefing.insights.map((insight) => ({ ...insight, sources: sourceIds })),
};
const referencedProposal = {
  briefing: referencedBriefing,
  suggestions: proposal.suggestions.map((suggestion) => ({ ...suggestion, sources: sourceIds })),
};
function tool(name: string, input: unknown): AgentMessage {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `tool_${name}`, name, input }] };
}
function model() {
  return vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", referencedProposal));
}
function overlongProposal() {
  return {
    ...referencedProposal,
    briefing: {
      ...referencedBriefing,
      nextSteps: [
        ...referencedBriefing.nextSteps,
        { action: "Verify the published delivery terms before planning a campaign. ".repeat(6), reason: "Delivery costs remain unknown." },
        { action: "Check the published product details; do not assume actual availability from public claims. ".repeat(5), reason: "Public claims do not establish actual stock." },
      ],
    },
  };
}
const shortenedActions = [
  { index: 1, action: "Verify published delivery terms before planning a campaign." },
  { index: 2, action: "Check published product details without treating availability claims as actual stock." },
];
const actionRewrites = { fields: shortenedActions.map(({ index, action }) => ({ path: `briefing.nextSteps.${index}.action`, text: action })) };

describe("bounded business agent", () => {
  it.each(["sugar-free date desserts", "nationwide 24-hour shipping", "24-hour delivery"])(
    "omits an unsupported strengthened profile claim: %s", async (claim) => {
      const captured = structuredClone(scan);
      captured.pages[0].text = "Date bites contain no refined sugar. Orders are shipped within 24-48 hours of being placed.";
      captured.pages[0].description = captured.pages[0].text;
      const references = [sourceFor("Date bites", captured)[0]];
      const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", {
        ...referencedProposal,
        briefing: { ...referencedBriefing, summary: { ...referencedBriefing.summary, sources: references },
          insights: referencedBriefing.insights.map((item) => ({ ...item, sources: references })) },
        suggestions: [{ field: "description", value: `The business offers ${claim}.`, sources: references }],
      }));
      const result = await createBusinessAgent({ complete }).run(url, async () => captured, new AbortController().signal);
      expect(result.suggestions).toEqual([]);
      expect(result.briefing).not.toBeNull();
      expect(result.validationIssues).toContainEqual({ path: "suggestions.0.value", code: "unsupported_claim" });
      expect(complete).toHaveBeenCalledTimes(2);
    });
  it.each([true, false])("streams live SDK text and accepts only a completed tool response (completed=%s)", async (completed) => {
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const input = JSON.stringify(referencedProposal);
    const split = input.indexOf("clothing") + 4;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "text/event-stream" } });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(tool("scan_website", {})), { headers: { "Content-Type": "application/json" } })).mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const update = vi.fn();
      const running = createBusinessAgent({ apiKey: "local-test-key" }).run(url, async () => scan, controller.signal, update);
      stream.enqueue(new TextEncoder().encode(
        event("message_start", { message: { id: "msg_fixture", type: "message", role: "assistant", content: [], model: "claude-haiku-4-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })
        + event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tool_proposal", name: "propose_business", input: {} } })
        + event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: input.slice(0, split) } }),
      ));
      await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ type: "briefing", briefing: { summary: { text: "The website presents a clot" } } }));
      expect(update).not.toHaveBeenCalledWith({ type: "phase", phase: "validating" });
      const finalResult = completed ? expect(running).resolves.toMatchObject(proposal)
        : expect(running).rejects.toThrow("response limit");
      stream.enqueue(new TextEncoder().encode(
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: input.slice(split, completed ? undefined : input.indexOf(',"suggestions"')) } })
        + event("content_block_stop", { index: 0 })
        + event("message_delta", { delta: { stop_reason: completed ? "tool_use" : "max_tokens", stop_sequence: null }, usage: { output_tokens: 200 } })
        + event("message_stop", {}),
      ));
      stream.close();
      await finalResult;
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ stream: true, tools: [{ strict: true, eager_input_streaming: true }] });
      const wireSchema = JSON.stringify(JSON.parse(fetch.mock.calls[1][1].body).tools[0].input_schema);
      expect(wireSchema).toContain(`"enum":${JSON.stringify([...buildAgentEvidence(scan).sources.keys()])}`);
      expect(wireSchema).toContain('"enum":["offering","positioning","buying_experience"]');
      const snapshots = update.mock.calls.map(([value]) => value).filter((value) => value.type === "briefing");
      expect(JSON.stringify(snapshots)).not.toContain('"sources"');
      expect(update).toHaveBeenLastCalledWith({ type: "phase", phase: "validating" });
      if (!completed) expect(log).toHaveBeenCalledWith("Business agent response did not complete:", {
        stopReason: "max_tokens", proposalCount: 1, expectedTool: true,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain(quote);
    } finally { controller.abort(); log.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("executes the scanner tool exactly once before interpreting its evidence", async () => {
    const complete = model();
    const scanner = vi.fn(async () => structuredClone(scan));
    const result = await createBusinessAgent({ complete }).run(url, scanner, AbortSignal.timeout(1000));
    expect(result).toMatchObject(proposal);
    expect(result.evidenceCoverage).toMatchObject({ pagesProvided: 1, productRecordsCaptured: 1, productRecordsProvided: 1 });
    expect(scanner).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0][0]).toMatchObject({ model: "claude-haiku-4-5", tool_choice: { name: "scan_website" } });
    expect(complete.mock.calls[1][0]).toMatchObject({
      model: "claude-haiku-4-5", tool_choice: { name: "propose_business" },
      tools: [{ strict: true, input_schema: { type: "object", required: ["briefing", "suggestions"], additionalProperties: false } }],
    });
    const schema = JSON.stringify(complete.mock.calls[1][0].tools);
    expect(schema).toContain("at most once");
    expect(schema).toContain("never repeated fields");
    expect(schema).toContain("120 characters");
    expect(schema).toContain("exact excerpt IDs");
    expect(schema).not.toContain('"quote":');
    expect(complete.mock.calls[1][0].max_tokens).toBeGreaterThan(2200);
    expect(complete.mock.calls.reduce((total, [input]) => total + input.max_tokens, 0)).toBeLessThanOrEqual(4400);
    expect(JSON.stringify(complete.mock.calls[1][0].messages)).toContain(quote);
    expect(JSON.stringify(complete.mock.calls[1][0].messages)).toContain("tool_result");
  });

  it("shortens only overlong actions once, preserving the rest of the validated briefing and citations", async () => {
    const input = overlongProposal(), original = structuredClone(input);
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {}))
      .mockResolvedValueOnce({ ...tool("propose_business", input), usage: { output_tokens: 1200 } })
      .mockResolvedValueOnce(tool("shorten_business_fields", { fields: actionRewrites.fields.toReversed() }));
    const scanner = vi.fn(async () => scan), signal = AbortSignal.timeout(1000);
    const result = await createBusinessAgent({ complete }).run(url, scanner, signal);
    expect(result).toMatchObject({
      ...proposal,
      briefing: { ...briefing, nextSteps: [
        briefing.nextSteps[0],
        { ...input.briefing.nextSteps[1], action: shortenedActions[0].action },
        { ...input.briefing.nextSteps[2], action: shortenedActions[1].action },
      ] },
    });
    expect(input).toEqual(original);
    expect(scanner).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(3);
    const [repair, cancellation, preview] = complete.mock.calls[2];
    expect(repair).toMatchObject({
      model: "claude-haiku-4-5", max_tokens: 1024,
      tools: [{ strict: true, input_schema: { additionalProperties: false } }],
      tool_choice: { name: "shorten_business_fields", disable_parallel_tool_use: true },
    });
    expect(JSON.parse(String(repair.messages[0].content))).toEqual({
      fields: input.briefing.nextSteps.slice(1).map((step, index) => ({
        path: `briefing.nextSteps.${index + 1}.action`, text: step.action.trim(), maximum: 300, context: step.reason,
      })),
    });
    expect(JSON.stringify(repair.messages)).not.toContain(quote);
    expect(cancellation).toBe(signal);
    expect(preview).toBeUndefined();
  });

  it("rephrases all overlong prose fields together without changing citations, structure or the original response", async () => {
    const input = {
      briefing: {
        summary: { text: "s".repeat(701), sources: sourceIds },
        insights: [{ area: "offering", text: "i".repeat(501), whyItMatters: "w".repeat(401), sources: sourceIds }],
        unknowns: [{ question: "q".repeat(301), whyItMatters: "u".repeat(301) }],
        nextSteps: [{ action: "a".repeat(301), reason: "r".repeat(301) }],
      },
      suggestions: [
        { field: "category", value: "c".repeat(121), sources: sourceIds },
        { field: "description", value: "d".repeat(2001), sources: sourceIds },
      ],
    };
    const original = structuredClone(input);
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {}))
      .mockResolvedValueOnce({ ...tool("propose_business", input), usage: { output_tokens: 1200 } })
      .mockImplementationOnce(async (request) => {
        const { fields } = JSON.parse(String(request.messages[0].content)) as { fields: { path: string; text: string; maximum: number }[] };
        expect(fields).toHaveLength(9);
        expect(fields.map(({ path }) => path)).toContain("briefing.insights.0.whyItMatters");
        return tool("shorten_business_fields", { fields: fields.toReversed().map(({ path }) => ({ path, text: "Concise qualified wording." })) });
      });
    const result = await createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000));
    expect(complete).toHaveBeenCalledTimes(3);
    expect(input).toEqual(original);
    expect(result).toMatchObject({
      briefing: {
        summary: { text: "Concise qualified wording.", sources: briefing.summary.sources },
        insights: [{ area: "offering", text: "Concise qualified wording.", whyItMatters: "Concise qualified wording.", sources: briefing.insights[0].sources }],
        unknowns: [{ question: "Concise qualified wording.", whyItMatters: "Concise qualified wording." }],
        nextSteps: [{ action: "Concise qualified wording.", reason: "Concise qualified wording." }],
      },
      suggestions: [
        { field: "category", value: "Concise qualified wording.", sources: briefing.summary.sources },
        { field: "description", value: "Concise qualified wording.", sources: briefing.summary.sources },
      ],
    });
  });

  it.each([400, 401])("enforces the exact 400-character insight significance boundary (%i)", async (length) => {
    const input = structuredClone(referencedProposal);
    input.briefing.insights[0].whyItMatters = "x".repeat(length);
    const shortened = "w".repeat(400);
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {}))
      .mockResolvedValueOnce({ ...tool("propose_business", input), usage: { output_tokens: 1200 } })
      .mockResolvedValueOnce(tool("shorten_business_fields", {
        fields: [{ path: "briefing.insights.0.whyItMatters", text: shortened }],
      }));
    const result = await createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000));
    expect(complete).toHaveBeenCalledTimes(length === 400 ? 2 : 3);
    expect(result.briefing!.insights[0].whyItMatters).toBe(length === 400 ? input.briefing.insights[0].whyItMatters : shortened);
  });

  it("rejects an oversized combined rewrite input without another model call", async () => {
    const input = structuredClone(overlongProposal());
    input.briefing.summary.text = "s".repeat(16_000);
    input.briefing.insights[0].text = "i".repeat(16_000);
    input.briefing.insights[0].whyItMatters = "w".repeat(16_000);
    input.briefing.unknowns[0].question = "q".repeat(16_000);
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {}))
      .mockResolvedValueOnce(tool("propose_business", input));
    await expect(createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000))).rejects.toThrow("input budget");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each([300, 301])("enforces the exact 300-character action boundary (%i)", async (length) => {
    const input = {
      ...referencedProposal,
      briefing: { ...referencedBriefing, nextSteps: [{ ...briefing.nextSteps[0], action: "a".repeat(length) }] },
    };
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {}))
      .mockResolvedValueOnce({ ...tool("propose_business", input), usage: { output_tokens: 1200 } })
      .mockResolvedValueOnce(tool("shorten_business_fields", { fields: [{ path: "briefing.nextSteps.0.action", text: briefing.nextSteps[0].action }] }));
    const result = await createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000));
    expect(result.briefing!.nextSteps[0].action).toBe(length === 300 ? input.briefing.nextSteps[0].action : briefing.nextSteps[0].action);
    expect(complete).toHaveBeenCalledTimes(length === 300 ? 2 : 3);
  });

  it.each([
    { fields: [actionRewrites.fields[0]] },
    { fields: [actionRewrites.fields[0], actionRewrites.fields[0]] },
    { fields: [actionRewrites.fields[0], { path: "briefing.nextSteps.0.action", text: "Change an unaffected action." }] },
    { fields: [actionRewrites.fields[0], { ...actionRewrites.fields[1], text: "x".repeat(301) }] },
    { ...actionRewrites, summary: { text: "Change unrelated content." } },
  ])("discards invalid rewrites without losing independently valid sections or retrying (%j)", async (repair) => {
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {}))
      .mockResolvedValueOnce({ ...tool("propose_business", overlongProposal()), usage: { output_tokens: 1200 } })
      .mockResolvedValueOnce(tool("shorten_business_fields", repair));
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000));
      expect(result.briefing).toEqual(briefing);
      expect(result.validationIssues).toEqual(expect.arrayContaining([{ path: "briefing", code: "text_rewrite_failed" }]));
      expect(complete).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(log.mock.calls)).not.toContain("Check the published product details");
      expect(JSON.stringify(log.mock.calls)).not.toContain(quote);
    } finally { log.mockRestore(); }
  });

  it.each([
    { ...tool("shorten_business_fields", actionRewrites), stop_reason: "max_tokens" as const },
    { ...tool("shorten_business_fields", actionRewrites), stop_reason: "refusal" as const },
    tool("propose_business", referencedProposal),
  ])("never uses incomplete, refused or unexpected rewrites but retains accepted sections", async (repair) => {
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {}))
      .mockResolvedValueOnce({ ...tool("propose_business", overlongProposal()), usage: { output_tokens: 1200 } })
      .mockResolvedValueOnce(repair);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000));
      expect(result.briefing).toEqual(briefing);
      expect(result.validationIssues).toContainEqual({ path: "briefing", code: "text_rewrite_failed" });
      expect(complete).toHaveBeenCalledTimes(3);
    } finally { log.mockRestore(); }
  });

  it.each(["foreign_source", "duplicate_area", "oversized_repair_input"])(
    "isolates unrelated invalid sections before repairing eligible text (%s)", async (problem) => {
      const input = structuredClone(overlongProposal());
      if (problem === "foreign_source") input.briefing.summary.sources = ["e_0000000000000000"];
      if (problem === "duplicate_area") input.briefing.insights.push(input.briefing.insights[0]);
      if (problem === "oversized_repair_input") input.briefing.nextSteps[1].action = "x".repeat(16_001);
      const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {}))
        .mockResolvedValueOnce({ ...tool("propose_business", input), usage: { output_tokens: 1200 } })
        .mockImplementationOnce(async (input) => {
          const fields = JSON.parse(String(input.messages[0].content)).fields as { path: string }[];
          return tool("shorten_business_fields", { fields: fields.map(({ path }) => ({ path, text: "Verify the published information." })) });
        });
      const log = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000));
        expect(result.briefing?.insights).toEqual(briefing.insights);
        expect(result.validationIssues?.length).toBeGreaterThan(0);
        expect(complete).toHaveBeenCalledTimes(3);
      } finally { log.mockRestore(); }
    },
  );

  it.each([true, false])("fits repair output inside the existing total token ceiling (usage available=%s)", async (usageAvailable) => {
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {}))
      .mockResolvedValueOnce({
        ...tool("propose_business", overlongProposal()),
        ...(usageAvailable ? { usage: { output_tokens: 4000 } } : {}),
      }).mockResolvedValueOnce(tool("shorten_business_fields", actionRewrites));
    await createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000));
    expect(complete.mock.calls[2][0].max_tokens).toBe(usageAvailable ? 144 : 48);
  });

  it.each(["before", "during"])("honours cancellation %s repair and never accepts a late result", async (when) => {
    const controller = new AbortController();
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {}))
      .mockResolvedValueOnce({ ...tool("propose_business", overlongProposal()), usage: { output_tokens: 1200 } })
      .mockImplementationOnce(async (_input, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
        return tool("shorten_business_fields", actionRewrites);
      });

    await expect(createBusinessAgent({ complete }).run(url, async () => scan, controller.signal, (update) => {
      if (when === "before" && update.type === "phase" && update.phase === "validating") controller.abort();
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(complete).toHaveBeenCalledTimes(when === "before" ? 2 : 3);
  });

  it("does not accept an otherwise valid result if cancellation arrives at final validation", async () => {
    const controller = new AbortController();
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", referencedProposal));
    await expect(createBusinessAgent({ complete }).run(url, async () => scan, controller.signal, (update) => {
      if (update.type === "phase" && update.phase === "validating") controller.abort();
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each([
    [...sourceIds, "e_0000000000000000"],
    [sourceIds[0], sourceIds[0]],
    [...sourceIds, "malformed"],
    [sourceFor(quote, { ...scan, pages: [{ ...scan.pages[0], capturedAt: "2026-11-15T12:00:00.000Z" }] })[0]],
  ])("rejects the whole affected finding, never just its invalid or duplicate citations (%j)", async (...sources) => {
    const input = structuredClone(referencedProposal);
    input.briefing.insights[0].sources = sources;
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", input));
    const result = await createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000));
    expect(result.briefing?.summary).toEqual(briefing.summary);
    expect(result.briefing?.insights).toEqual([]);
    expect(result.validationIssues?.some((issue) => issue.path.startsWith("briefing.insights.0"))).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each(["connecting", "scanning", "analysing"] as const)("starts no further work after cancellation at %s", async (phase) => {
    const controller = new AbortController(), complete = model(), scanner = vi.fn(async () => scan);
    await expect(createBusinessAgent({ complete }).run(url, scanner, controller.signal, (update) => {
      if (update.type === "phase" && update.phase === phase) controller.abort();
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(complete).toHaveBeenCalledTimes(phase === "connecting" ? 0 : 1);
    expect(scanner).toHaveBeenCalledTimes(phase === "analysing" ? 1 : 0);
  });

  it("does not pay for a rewrite when every cited finding is unsupported", async () => {
    const input = structuredClone(referencedProposal);
    input.briefing.summary.sources = ["e_0000000000000000"];
    input.briefing.insights[0].sources = ["e_0000000000000000"];
    input.briefing.nextSteps[0].action = "Overlong but otherwise valid next check. ".repeat(20);
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", input));
    await expect(createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000))).rejects.toThrow("invalid or unsupported");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not request interpretation when a readable page yields no issued evidence IDs", async () => {
    const empty = { ...scan, pages: [{ ...scan.pages[0], title: "", description: "", text: "", productJson: [] }] };
    const complete = model();
    expect(await createBusinessAgent({ complete }).run(url, async () => empty, AbortSignal.timeout(1000))).toMatchObject({
      briefing: null, suggestions: [],
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "model_request_rejected", "rejected the analysis request (HTTP 400)"],
    [401, "model_authentication_error", "rejected the server's authentication"],
    [403, "model_permission_error", "denied permission"],
    [429, "model_rate_limit", "temporarily limited requests"],
    [500, "model_unavailable", "temporarily unavailable"],
    [529, "model_unavailable", "temporarily unavailable"],
  ] as const)("reports SDK HTTP %s accurately and safely with no automatic network retry", async (status, code, message) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "private-provider-body" } }),
      { status, headers: { "Content-Type": "application/json" } }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {}), scanner = vi.fn(async () => scan);
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(createBusinessAgent({ apiKey: "local-test-key" }).run(url, scanner, AbortSignal.timeout(1000)))
        .rejects.toMatchObject({ code, message: expect.stringContaining(message) });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(scanner).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-provider-body");
      expect(log).toHaveBeenCalledWith("Business agent provider request failed:", expect.objectContaining({
        tool: "scan_website", status, code,
      }));
    } finally { log.mockRestore(); vi.unstubAllGlobals(); }
  });

  it.each([429, 500])("keeps unaffected sections when the SDK rewrite receives HTTP %s without retrying", async (status) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    const fetch = vi.fn().mockResolvedValueOnce(json(tool("scan_website", {})))
      .mockResolvedValueOnce(json({ ...tool("propose_business", overlongProposal()), usage: { output_tokens: 1200 } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "private-provider-body" } }),
        { status, headers: { "Content-Type": "application/json" } }));
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetch);
    try {
      const result = await createBusinessAgent({ apiKey: "local-test-key" }).run(url, async () => scan, AbortSignal.timeout(1000));
      expect(result.briefing).toEqual(briefing);
      expect(result.validationIssues).toContainEqual({ path: "briefing", code: "text_rewrite_failed" });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-provider-body");
    } finally { log.mockRestore(); vi.unstubAllGlobals(); }
  });

  it.each([
    { ...tool("propose_business", referencedProposal), stop_reason: "refusal" as const },
    { ...tool("propose_business", referencedProposal), stop_reason: "max_tokens" as const },
    tool("other_tool", referencedProposal),
    { ...tool("propose_business", referencedProposal), content: [...tool("propose_business", referencedProposal).content, ...tool("propose_business", referencedProposal).content] },
  ])("rejects initial refused, truncated, wrong-tool or multiple-tool proposals even if their findings look valid", async (response) => {
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(response);
    await expect(createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000))).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each([
    tool("scan_website", { url: "http://127.0.0.1/" }),
    tool("other_tool", {}),
    { ...tool("scan_website", {}), stop_reason: "max_tokens" as const },
  ])("rejects tool overrides and incomplete requests without scanning", async (message) => {
    const complete = vi.fn<AgentModel>().mockResolvedValue(message);
    const scanner = vi.fn(async () => scan);
    await expect(createBusinessAgent({ complete }).run(url, scanner, AbortSignal.timeout(1000))).rejects.toThrow("permitted scanner");
    expect(scanner).not.toHaveBeenCalled();
  });

  it.each([
    { suggestions: [{ field: "description", value: quote, sources: [{ url, quote }] }] },
    { suggestions: [{ field: "description", value: quote, sources: [{ url, quote: "A fabricated supporting quote." }] }] },
    { suggestions: [{ field: "description", value: quote, sources: [{ url: "https://other.example.com/", quote }] }] },
    { suggestions: [{ field: "description", value: quote, sources: [] }] },
    { suggestions: [{ field: "category", value: "x".repeat(16_001), sources: sourceIds }] },
    { suggestions: [{ ...referencedProposal.suggestions[0], price: "123" }] },
  ])("omits unsupported profile suggestions without losing the accepted briefing", async (input) => {
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", { ...referencedProposal, ...input }));
    const result = await createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000));
    expect(result.briefing).toEqual(briefing);
    expect(result.suggestions).toEqual([]);
    expect(result.validationIssues?.[0].path).toMatch(/^suggestions\.0/);
  });

  it.each([
    { ...referencedBriefing, summary: { ...referencedBriefing.summary, sources: [{ url, quote: "A fabricated summary source." }] } },
    { ...referencedBriefing, insights: [{ ...referencedBriefing.insights[0], sources: [{ url: "https://other.example.com/", quote }] }] },
    { ...referencedBriefing, insights: [{ ...referencedBriefing.insights[0], whyItMatters: "" }] },
    { ...referencedBriefing, unknowns: [] },
    { ...referencedBriefing, nextSteps: [] },
  ])("preserves independent sections and explicitly records incomplete coverage", async (input) => {
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", { ...referencedProposal, briefing: input }));
    const result = await createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000));
    expect(result.briefing).not.toBeNull();
    expect(result.validationIssues?.length).toBeGreaterThan(0);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not accept profile changes without a briefing or save a briefing with no supported findings", async () => {
    for (const input of [
      { ...referencedProposal, briefing: null },
      { ...referencedProposal, briefing: { ...referencedBriefing,
        summary: { ...referencedBriefing.summary, sources: ["e_0000000000000000"] },
        insights: [{ ...referencedBriefing.insights[0], sources: ["malformed"] }],
      } },
    ]) {
      const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", input));
      await expect(createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000))).rejects.toThrow("invalid or unsupported");
      expect(complete).toHaveBeenCalledTimes(2);
    }
  });

  it("can return a grounded briefing without proposing changes to the owner's profile", async () => {
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", { briefing: referencedBriefing, suggestions: [] }));
    await expect(createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000))).resolves.toMatchObject({ briefing, suggestions: [] });
  });

  it("resolves multiple evidence IDs to their exact original pages and quotes without asking the model to copy them", async () => {
    const secondUrl = `${url}delivery`;
    const deliveryQuote = "Delivery costs \u00a350.\nOrders ship within 2\u20133 days; terms apply.";
    const captured = {
      ...scan, pages: [...scan.pages, {
        ...scan.pages[0], url: secondUrl, title: "Buying information", description: "",
        text: deliveryQuote, productJson: [],
      }],
    };
    const [deliveryId] = sourceFor(deliveryQuote, captured);
    const input = {
      briefing: {
        ...referencedBriefing,
        summary: { ...referencedBriefing.summary, sources: [sourceFor(quote, captured)[0], deliveryId] },
        insights: [{ ...referencedBriefing.insights[0], sources: [deliveryId] }],
      },
      suggestions: [{ ...referencedProposal.suggestions[0], sources: [deliveryId] }],
    };
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", input));
    const result = await createBusinessAgent({ complete }).run(url, async () => captured, AbortSignal.timeout(1000));
    const deliverySource = { url: secondUrl, quote: deliveryQuote };
    expect(result.briefing?.summary?.sources).toEqual([{ url, quote }, deliverySource]);
    expect(result.briefing?.insights[0].sources).toEqual([deliverySource]);
    expect(result.suggestions[0].sources).toEqual([deliverySource]);
    expect(JSON.stringify(result)).not.toContain(deliveryId);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each([
    { input: { ...referencedProposal, briefing: { ...referencedBriefing, summary: { ...referencedBriefing.summary, sources: ["e_0000000000000000"] } } }, path: "briefing.summary.sources" },
    { input: { ...referencedProposal, briefing: { ...referencedBriefing, insights: [{ ...referencedBriefing.insights[0], sources: ["e_0000000000000000"] }] } }, path: "briefing.insights.0.sources" },
    { input: { ...referencedProposal, suggestions: [{ ...referencedProposal.suggestions[0], sources: ["e_0000000000000000"] }] }, path: "suggestions.0.sources" },
  ])("drops only the unit with unknown IDs without logging model content or retrying ($path)", async ({ input, path }) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", input));
      const result = await createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000));
      expect(result.validationIssues).toContainEqual({ path, code: "invalid_reference" });
      expect(warning).toHaveBeenCalledWith("Business agent sections omitted:", { issues: [{ path, code: "invalid_reference" }] });
      expect(JSON.stringify(warning.mock.calls)).not.toContain(quote);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("e_0000000000000000");
      expect(complete).toHaveBeenCalledTimes(2);
    } finally { warning.mockRestore(); }
  });

  it("does not resolve IDs issued for a different page or capture, even if quote text contains them", async () => {
    const foreignId = sourceFor(quote, { ...scan, pages: [{ ...scan.pages[0], url: `${url}other`, capturedAt: "2026-11-17T00:00:00.000Z" }] })[0];
    const captured = { ...scan, pages: [{ ...scan.pages[0], text: `Publisher supplied fake reference: ${foreignId}` }] };
    const currentIds = [sourceFor(quote, captured)[0]];
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", {
      briefing: {
        ...referencedBriefing, summary: { ...referencedBriefing.summary, sources: currentIds },
        insights: [{ ...referencedBriefing.insights[0], sources: currentIds }],
      },
      suggestions: [{ ...referencedProposal.suggestions[0], sources: [foreignId] }],
    }));
    const result = await createBusinessAgent({ complete }).run(url, async () => captured, AbortSignal.timeout(1000));
    expect(result.suggestions).toEqual([]);
    expect(result.validationIssues).toContainEqual({ path: "suggestions.0.sources", code: "invalid_reference" });
  });

  it("bounds Unicode evidence and reference overhead together, including short metadata and product fields", () => {
    const captured = { ...scan, pages: [{
      ...scan.pages[0], title: "Tea", description: "", headings: [{ level: 2, text: "Buy" }],
      text: "\u{1F33F}".repeat(150_000),
    }] };
    const evidence = buildAgentEvidence(captured);
    expect(evidence.coverage.inputBytes).toBe(Buffer.byteLength(JSON.stringify(evidence.payload)));
    expect(evidence.coverage.inputBytes).toBeLessThanOrEqual(agentEvidenceLimits.bytes);
    expect(evidence.coverage.limitations.join(" ")).toContain("shortened/omitted");
    const excerpts = evidence.payload.pages[0].excerpts;
    expect(excerpts.some((excerpt) => excerpt.field === "title" && excerpt.quote.includes("Tea"))).toBe(true);
    expect(excerpts.some((excerpt) => excerpt.field === "headings" && excerpt.quote.includes("Buy"))).toBe(true);
    expect(excerpts.some((excerpt) => excerpt.field === "product")).toBe(true);
    for (const excerpt of excerpts) {
      expect(excerpt.quote.length).toBeGreaterThanOrEqual(10);
      expect(excerpt.quote.length).toBeLessThanOrEqual(500);
      expect(excerpt.quote.isWellFormed()).toBe(true);
      expect(evidence.sources.get(excerpt.id)).toEqual({ url, quote: excerpt.quote });
    }
  });

  it("keeps hundreds of exact citation choices compact without dropping evidence or admitting another snapshot's IDs", async () => {
    const captured = { ...scan, pages: [{ ...scan.pages[0],
      text: Array.from({ length: 6000 }, (_, index) => `Public cotton clothing detail number ${String(index).padStart(5, "0")}. `).join(""),
    }] };
    const evidence = buildAgentEvidence(captured);
    const ids = [...evidence.sources.keys()];
    expect(ids.length).toBeGreaterThan(400);
    const prefixes = new Set(ids.flatMap((id) => Array.from({ length: id.length }, (_, index) => id.slice(0, index + 1))));
    expect(prefixes.size).toBeLessThan(ids.length * 2);
    expect(new Set(evidence.payload.pages.flatMap((page) => page.excerpts.map((excerpt) => excerpt.id))).size).toBe(ids.length);
    const savedCapture = { ...captured, id: randomUUID(), businessId: randomUUID() };
    expect([...buildAgentEvidence(savedCapture).sources.keys()]).toEqual(ids);
    const changed = buildAgentEvidence({ ...captured, completedAt: "2026-11-17T00:00:00.000Z",
      pages: [{ ...captured.pages[0], capturedAt: "2026-11-17T00:00:00.000Z" }] });
    expect([...changed.sources.keys()].some((id) => evidence.sources.has(id))).toBe(false);
    const selected = ids.at(-1)!;
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {}))
      .mockResolvedValueOnce(tool("propose_business", {
        briefing: { ...referencedBriefing, summary: { ...referencedBriefing.summary, sources: [selected] },
          insights: [{ ...referencedBriefing.insights[0], sources: [ids[0]] }] }, suggestions: [],
      }));
    const result = await createBusinessAgent({ complete }).run(url, async () => captured, AbortSignal.timeout(1000));
    expect(JSON.stringify(complete.mock.calls[1][0].tools)).toContain(`"enum":${JSON.stringify(ids)}`);
    expect(result.briefing?.summary?.sources).toEqual([evidence.sources.get(selected)]);
    expect(result.validationIssues).toBeUndefined();
  });

  it.each([
    { input: { ...referencedProposal, briefing: { ...referencedBriefing, insights: [referencedBriefing.insights[0], referencedBriefing.insights[0]] } }, path: "briefing.insights" },
    { input: { ...referencedProposal, suggestions: [referencedProposal.suggestions[0], referencedProposal.suggestions[0]] }, path: "suggestions" },
  ])("omits repeated areas/fields with safe diagnostics while preserving the first valid unit ($path)", async ({ input, path }) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", input));
      const result = await createBusinessAgent({ complete }).run(url, async () => scan, AbortSignal.timeout(1000));
      expect(result).toMatchObject(proposal);
      expect(result.validationIssues).toContainEqual({ code: "duplicate", path: `${path}.1` });
      expect(warning).toHaveBeenCalledWith("Business agent sections omitted:", { issues: [{ code: "duplicate", path: `${path}.1` }] });
      expect(JSON.stringify(warning.mock.calls)).not.toContain(quote);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("x".repeat(121));
      expect(complete).toHaveBeenCalledTimes(2);
    } finally { warning.mockRestore(); }
  });

  it("supplies structured product and buying evidence and validates product-field citations", async () => {
    const richScan = structuredClone(scan);
    richScan.pages[0].headings = [{ level: 2, text: "Delivery and sizing" }];
    richScan.pages[0].callsToAction = ["Explore the linen range"];
    richScan.pages[0].productJson = [JSON.stringify({ "@type": "Product", name: "Linen Summer Shirt", material: "Linen",
      offers: { "@type": "Offer", price: "1299", priceCurrency: "INR", availability: "https://schema.org/InStock" }, unrelatedField: "DO_NOT_FORWARD" })];
    const [productId, productSource] = sourceFor("offers.price: 1299", richScan);
    const productBriefing = { ...briefing, insights: [{ ...briefing.insights[0], text: "The published linen shirt offer is INR 1299.", sources: [productSource] }] };
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", {
      briefing: { ...referencedBriefing, summary: { ...referencedBriefing.summary, sources: [sourceFor(quote, richScan)[0]] },
        insights: [{ ...productBriefing.insights[0], sources: [productId] }] }, suggestions: [],
    }));
    const result = await createBusinessAgent({ complete }).run(url, async () => richScan, AbortSignal.timeout(1000));
    expect(result.briefing).toEqual(productBriefing);
    const sent = JSON.stringify(complete.mock.calls[1][0].messages);
    expect(sent).toContain("Linen Summer Shirt");
    expect(sent).toContain("offers.priceCurrency: INR");
    expect(sent).toContain("Delivery and sizing");
    expect(sent).toContain("Explore the linen range");
    expect(sent).not.toContain("DO_NOT_FORWARD");
  });

  it("balances bounded evidence across pages, discloses sampling and rejects IDs for omitted evidence", async () => {
    const hiddenQuote = "This exact sentence is outside the supplied excerpt.";
    const largeScan = structuredClone(scan);
    largeScan.pages = Array.from({ length: 20 }, (_, index) => ({
      ...scan.pages[0], url: `${url}products/item-${index}`, title: `Fixture ${index}`, description: "Publisher description",
      text: `${"Public product details. ".repeat(480)}${hiddenQuote}`,
      productJson: Array.from({ length: index < 3 ? 50 : 0 }, (_, product) => JSON.stringify({ "@type": "Product", name: `Product ${index}-${product}`, material: "\u68c9".repeat(100) })),
    }));
    const evidence = buildAgentEvidence(largeScan);
    expect(evidence.payload.pages).toHaveLength(20);
    expect(evidence.coverage.productRecordsProvided).toBeLessThanOrEqual(agentEvidenceLimits.products);
    expect(evidence.coverage.productRecordsCaptured).toBe(150);
    expect(evidence.coverage.limited).toBe(true);
    expect(evidence.payload.limitations.join(" ")).toContain("outside the analysis budget");
    expect(Buffer.byteLength(JSON.stringify(evidence.payload))).toBeLessThanOrEqual(agentEvidenceLimits.bytes);
    expect(JSON.stringify(evidence.payload)).not.toContain(hiddenQuote);
    const omittedId = sourceFor(hiddenQuote, { ...scan, pages: [{ ...largeScan.pages[0], text: hiddenQuote, productJson: [] }] })[0];
    expect(evidence.sources.has(omittedId)).toBe(false);
    const complete = vi.fn<AgentModel>().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", {
      briefing: {
        ...referencedBriefing,
        summary: { ...referencedBriefing.summary, sources: [omittedId] },
        insights: [{ ...referencedBriefing.insights[0], sources: [evidence.payload.pages[0].excerpts[0].id] }],
      }, suggestions: [],
    }));
    const result = await createBusinessAgent({ complete }).run(url, async () => largeScan, AbortSignal.timeout(1000));
    expect(result.briefing?.summary).toBeUndefined();
    expect(result.briefing?.insights).toHaveLength(1);
    expect(result.validationIssues).toContainEqual({ path: "briefing.summary.sources", code: "invalid_reference" });
  });

  it("does not interpret blocked pages or fabricate missing evidence", async () => {
    const complete = model();
    const result = await createBusinessAgent({ complete }).run(url, async () => ({ ...scan, status: "failed", pages: [] }), AbortSignal.timeout(1000));
    expect(result.suggestions).toEqual([]);
    expect(complete).toHaveBeenCalledOnce();
  });
});

describe("business understanding API", () => {
  let directory: string, path: string, store: Store, app: ReturnType<typeof createApp>;
  let complete: ReturnType<typeof model>;
  const scanner = vi.fn(async (_url: string, _signal?: AbortSignal) => structuredClone(scan));
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "gp-agent-")); path = join(directory, "test.sqlite");
    store = openStore(path); complete = model(); scanner.mockReset().mockResolvedValue(structuredClone(scan));
    app = createApp({ store, scanner, agent: createBusinessAgent({ complete }) });
  });
  afterEach(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  async function owner(email = "owner@example.test", website = url) {
    const account = await request(app).post("/api/auth/register").set("Origin", origin).send({ name: "Private owner name", email, password: "private account password" }).expect(201);
    const cookie = String(account.headers["set-cookie"][0]).split(";")[0];
    const response = await request(app).post("/api/businesses").set("Origin", origin).set("Cookie", cookie).send({
      name: "Private business name", website, category: "Private owner category", description: "Private profile notes",
    }).expect(201);
    return { cookie, userId: account.body.user.id as string, business: response.body.business as Business };
  }
  function start(owner: { cookie: string; business: { id: string } }, input: unknown = { permission: true }) {
    return request(app).post(`/api/businesses/${owner.business.id}/understanding`).set("Origin", origin).set("Cookie", owner.cookie).send(input);
  }
  function apply(owner: { cookie: string; business: Business }, reviewId: string, input: Record<string, unknown> = {}) {
    return request(app).post(`/api/businesses/${owner.business.id}/understanding/${reviewId}/apply`).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ category: owner.business.category, description: quote, expectedUpdatedAt: owner.business.updatedAt, ...input });
  }

  it.each([true, false])("streams provisional snapshots and persists only valid completed results (valid=%s)", async (valid) => {
    const user = await owner();
    complete.mockReset().mockResolvedValueOnce(tool("scan_website", {})).mockImplementationOnce(async (_input, _signal, onInput) => {
      expect(await store.latestUnderstanding(user.userId, user.business.id)).toBeNull();
      onInput?.({ briefing: { summary: briefing.summary } });
      onInput?.({ briefing: { summary: briefing.summary } });
      return tool("propose_business", valid ? referencedProposal : {
        ...referencedProposal, briefing: { ...referencedBriefing,
          summary: { ...referencedBriefing.summary, sources: ["e_0000000000000000"] },
          insights: [{ ...referencedBriefing.insights[0], sources: ["e_0000000000000000"] }],
        },
      });
    });
    const response = await start(user).set("Accept", "application/x-ndjson").expect(200).expect("Content-Type", /application\/x-ndjson/);
    expect(response.headers["cache-control"]).toContain("no-transform");
    const events = response.text.trim().split("\n").map((line: string) => understandingStreamEventSchema.parse(JSON.parse(line)));
    expect(events.filter((event) => event.type === "phase").map((event) => event.phase)).toEqual(["connecting", "scanning", "analysing", "validating"]);
    expect(events.filter((event) => event.type === "briefing")).toEqual([{ type: "briefing", briefing: { summary: { text: briefing.summary.text } } }]);
    const saved = await store.latestUnderstanding(user.userId, user.business.id);
    if (valid) {
      expect(events.at(-1)).toEqual({ type: "complete", understanding: saved });
      expect(saved?.briefing).toEqual(briefing);
    } else {
      expect(events.at(-1)).toMatchObject({ type: "error", status: 502, message: expect.stringContaining("invalid or unsupported") });
      expect(saved).toBeNull();
    }
    expect((await store.getBusiness(user.userId, user.business.id))?.description).toBe("Private profile notes");
    expect(await store.listScans(user.userId, user.business.id)).toHaveLength(1);
    expect(await store.listProducts(user.userId, user.business.id)).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("flushes live text before provider completion and cancels upstream without saving a review on disconnect", async () => {
    const user = await owner();
    let providerSignal: AbortSignal | undefined;
    complete.mockReset().mockResolvedValueOnce(tool("scan_website", {})).mockImplementationOnce(async (_input, signal, onInput) => {
      providerSignal = signal;
      onInput?.({ briefing: { summary: { text: "Still writing this business summary" } } });
      return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const server = app.listen(0, "127.0.0.1");
    const controller = new AbortController();
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address.");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/businesses/${user.business.id}/understanding`, {
        method: "POST", headers: { Origin: origin, Cookie: user.cookie, Accept: "application/x-ndjson", "Content-Type": "application/json" },
        body: JSON.stringify({ permission: true }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing analysis response stream.");
      let received = "";
      try {
        while (!received.includes("Still writing this business summary")) {
          const { value, done } = await reader.read();
          if (done) throw new Error("Analysis ended before live text arrived.");
          received += new TextDecoder().decode(value);
        }
      } finally { reader.releaseLock(); }
      expect(providerSignal?.aborted).toBe(false);
      expect(await store.latestUnderstanding(user.userId, user.business.id)).toBeNull();
      controller.abort();
      await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
      expect(await store.latestUnderstanding(user.userId, user.business.id)).toBeNull();
      expect(await store.listScans(user.userId, user.business.id)).toHaveLength(1);
      expect((await store.getBusiness(user.userId, user.business.id))?.description).toBe("Private profile notes");
      expect(complete).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("persists the review and ready website products without changing owner profile fields", async () => {
    const user = await owner();
    expect(scanner).not.toHaveBeenCalled();
    const response = await start(user).expect(201);
    const result = response.body.understanding;
    expect(result.scanStatus).toBe("complete");
    expect(result.suggestions).toEqual(proposal.suggestions);
    expect(result.briefing).toEqual(briefing);
    expect(result.productImportId).toBeNull();
    expect(result.catalogue).toMatchObject({ created: 1, skipped: 0 });
    expect(scanner).toHaveBeenCalledWith(url, expect.any(AbortSignal));
    expect((await store.getBusiness(user.userId, user.business.id))?.description).toBe("Private profile notes");
    expect((await store.listProducts(user.userId, user.business.id))[0]).toMatchObject({ name: "Fixture tee", sku: "TEE-1" });
    const sent = JSON.stringify(complete.mock.calls);
    expect(sent).not.toContain("Private profile notes");
    expect(sent).not.toContain("Private owner name");
    expect(sent).not.toContain("owner@example.test");
    expect(sent).not.toContain("private account password");
    await store.close(); store = openStore(path);
    app = createApp({ store, scanner });
    const restored = await request(app).get(`/api/businesses/${user.business.id}/understanding`).set("Cookie", user.cookie).expect(200);
    expect(restored.body).toEqual({ ...response.body, lastSuccessfulUnderstanding: result, job: null });
    expect((await store.getScan(user.userId, user.business.id, result.scanId))?.pages[0].text).toBe(quote);
    const database = new Database(path);
    try {
      database.prepare("UPDATE business_understandings SET result_json = json_remove(result_json, '$.briefing') WHERE id = ?").run(result.id);
    } finally { database.close(); }
    const legacy = await request(app).get(`/api/businesses/${user.business.id}/understanding`).set("Cookie", user.cookie).expect(200);
    expect(legacy.body.understanding.briefing).toBeNull();
    expect(legacy.body.understanding.suggestions).toEqual(proposal.suggestions);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("persists and reopens accepted partial sections with explicit omission metadata", async () => {
    const user = await owner(), input = structuredClone(referencedProposal);
    input.briefing.summary.sources = ["e_0000000000000000"];
    complete.mockReset().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", input));
    const saved = (await start(user).expect(201)).body.understanding;
    expect(saved.briefing.summary).toBeUndefined();
    expect(saved.briefing.insights).toEqual(briefing.insights);
    expect(saved.validationIssues).toContainEqual({ path: "briefing.summary.sources", code: "invalid_reference" });
    expect(saved.warnings).toContain(partialBriefingNotice);
    await store.close(); store = openStore(path); app = createApp({ store });
    const restored = await request(app).get(`/api/businesses/${user.business.id}/understanding`).set("Cookie", user.cookie).expect(200);
    expect(restored.body).toMatchObject({ understanding: saved, lastSuccessfulUnderstanding: saved });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("retains the last accepted briefing across failed refreshes, newer null results and database reopen without reviving stale approvals", async () => {
    const user = await owner(), saved = (await start(user).expect(201)).body.understanding;
    complete.mockReset().mockResolvedValueOnce(tool("scan_website", {}))
      .mockResolvedValueOnce(tool("propose_business", { ...referencedProposal, briefing: null }));
    await start(user).expect(502);
    expect((await store.lastSuccessfulUnderstanding(user.userId, user.business.id))?.id).toBe(saved.id);
    const latest = await store.saveUnderstanding(user.userId, {
      ...saved, id: randomUUID(), createdAt: new Date(Date.parse(saved.createdAt) + 1000).toISOString(),
      briefing: null, suggestions: [], productImportId: null,
    });
    await store.close(); store = openStore(path); app = createApp({ store });
    const restored = await request(app).get(`/api/businesses/${user.business.id}/understanding`).set("Cookie", user.cookie).expect(200);
    expect(restored.body).toEqual({ understanding: latest, lastSuccessfulUnderstanding: saved, job: null });
    await apply(user, saved.id).expect(409);
    expect((await store.getBusiness(user.userId, user.business.id))?.description).toBe("Private profile notes");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("scopes historical briefings to the owner, business, normalized current website and usable scan", async () => {
    const alice = await owner(), bob = await owner("bob@example.test");
    const saved = (await start(alice).expect(201)).body.understanding;
    expect(await store.lastSuccessfulUnderstanding(bob.userId, alice.business.id)).toBeNull();
    expect(await store.lastSuccessfulUnderstanding(alice.userId, bob.business.id)).toBeNull();
    expect(await store.lastSuccessfulUnderstanding(bob.userId, bob.business.id)).toBeNull();
    await store.saveBusiness(alice.userId, { ...alice.business, website: "https://SHOP.EXAMPLE.COM" }, alice.business.id);
    expect((await store.lastSuccessfulUnderstanding(alice.userId, alice.business.id))?.id).toBe(saved.id);
    for (const website of ["https://different.example.com/", "https://shop.example.com/another-path", ""]) {
      await store.saveBusiness(alice.userId, { ...alice.business, website }, alice.business.id);
      const response = await request(app).get(`/api/businesses/${alice.business.id}/understanding`).set("Cookie", alice.cookie).expect(200);
      expect(response.body.understanding).toBeNull();
      expect(response.body.lastSuccessfulUnderstanding).toBeNull();
    }
    await store.saveBusiness(alice.userId, alice.business, alice.business.id);
    const failed = (await store.saveScan(alice.userId, alice.business.id, { ...scan, status: "failed", pages: [] }))!;
    await store.saveUnderstanding(alice.userId, { ...saved, id: randomUUID(), scanId: failed.id,
      createdAt: new Date(Date.parse(saved.createdAt) + 1000).toISOString() });
    expect((await store.latestUnderstanding(alice.userId, alice.business.id))?.scanStatus).toBe("failed");
    expect((await store.lastSuccessfulUnderstanding(alice.userId, alice.business.id))?.id).toBe(saved.id);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("checks ownership, origin and explicit consent before any provider or scanner call", async () => {
    const alice = await owner(), bob = await owner("bob@example.test");
    await request(app).get(`/api/businesses/${alice.business.id}/understanding`).set("Cookie", bob.cookie).expect(404);
    await request(app).get(`/api/businesses/${alice.business.id}/understanding`).expect(401);
    await start({ ...bob, business: alice.business }).expect(404);
    await request(app).post(`/api/businesses/${alice.business.id}/understanding`).set("Origin", origin).send({ permission: true }).expect(401);
    await request(app).post(`/api/businesses/${alice.business.id}/understanding`).set("Cookie", alice.cookie).send({ permission: true }).expect(403);
    await start(alice, { permission: false }).expect(400);
    await start(alice, { permission: true, url: "http://127.0.0.1/" }).expect(400);
    expect(complete).not.toHaveBeenCalled(); expect(scanner).not.toHaveBeenCalled();
  });

  it("saves corrected review fields and completion atomically, survives reloads, and safely retries a completed save", async () => {
    const user = await owner();
    const draft = (await start(user).expect(201)).body.understanding;
    const description = "Owner-corrected description of the business.";
    const saved = await apply(user, draft.id, { description }).expect(200);
    expect(saved.body.business).toMatchObject({ name: user.business.name, website: url, category: user.business.category, description });
    expect(saved.body.understanding.reviewedAt).toBeTypeOf("string");
    const activityCount = (await store.listActivity(user.userId, user.business.id)).length;
    await apply(user, draft.id, { description }).expect(200);
    expect(await store.listActivity(user.userId, user.business.id)).toHaveLength(activityCount);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(scanner).toHaveBeenCalledOnce();
    expect(await store.listProducts(user.userId, user.business.id)).toHaveLength(1);
    await store.close(); store = openStore(path); app = createApp({ store });
    const restored = await request(app).get(`/api/businesses/${user.business.id}/understanding`).set("Cookie", user.cookie).expect(200);
    expect(restored.body.understanding.reviewedAt).toBe(saved.body.understanding.reviewedAt);
    await store.saveBusiness(user.userId, { ...saved.body.business, description: "A later intentional owner edit." }, user.business.id);
    expect((await store.latestUnderstanding(user.userId, user.business.id))?.reviewedAt).toBe(saved.body.understanding.reviewedAt);
    await apply(user, draft.id, { description }).expect(409);
    expect((await store.getBusiness(user.userId, user.business.id))?.description).toBe("A later intentional owner edit.");
  });

  it("requires ownership and origin for approval and rejects browser-supplied profile identity fields", async () => {
    const alice = await owner(), bob = await owner("bob@example.test");
    const draft = (await start(alice).expect(201)).body.understanding;
    await apply({ ...bob, business: alice.business }, draft.id).expect(404);
    await apply(bob, draft.id).expect(409);
    await request(app).post(`/api/businesses/${alice.business.id}/understanding/${draft.id}/apply`).set("Origin", origin).send({}).expect(401);
    await request(app).post(`/api/businesses/${alice.business.id}/understanding/${draft.id}/apply`).set("Cookie", alice.cookie).send({}).expect(403);
    await apply(alice, draft.id, { name: "Browser override" }).expect(400);
    expect((await store.latestUnderstanding(alice.userId, alice.business.id))?.reviewedAt).toBeNull();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite stale profile edits or apply evidence from a changed website", async () => {
    const user = await owner();
    const draft = (await start(user).expect(201)).body.understanding;
    await apply(user, draft.id, { expectedUpdatedAt: "2000-01-01T00:00:00.000Z" }).expect(409);
    const changed = (await store.saveBusiness(user.userId, { ...user.business, website: "https://different.example.com/" }, user.business.id))!;
    await apply({ ...user, business: changed }, draft.id).expect(409);
    expect((await store.getBusiness(user.userId, user.business.id))?.description).toBe(user.business.description);
    expect((await store.latestUnderstanding(user.userId, user.business.id))?.reviewedAt).toBeNull();
  });

  it("rolls back both profile changes and completion if activity recording fails", async () => {
    const user = await owner();
    const draft = (await start(user).expect(201)).body.understanding;
    const database = new Database(path);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      database.exec("CREATE TRIGGER fail_review_activity BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT, 'Activity write failed'); END;");
      await apply(user, draft.id).expect(500);
      expect(log).toHaveBeenCalled();
      expect((await store.getBusiness(user.userId, user.business.id))?.description).toBe(user.business.description);
      expect((await store.latestUnderstanding(user.userId, user.business.id))?.reviewedAt).toBeNull();
    } finally { database.close(); log.mockRestore(); }
  });

  it.each([true, false])("upgrades old reviews without repeating already-applied suggestions (matches profile: %s)", async (matches) => {
    const user = await owner();
    await start(user).expect(201);
    if (matches) await store.saveBusiness(user.userId, { ...user.business, description: quote }, user.business.id);
    await store.close();
    const database = new Database(path);
    try {
      database.exec("ALTER TABLE business_understandings DROP COLUMN reviewed_at; DELETE FROM schema_migrations WHERE version = 5;");
    } finally { database.close(); }
    store = openStore(path);
    const restored = (await store.latestUnderstanding(user.userId, user.business.id))!;
    if (matches) expect(restored.reviewedAt).toBeTypeOf("string");
    else expect(restored.reviewedAt).toBeNull();
  });

  it("reports missing configuration without scanning or losing the saved profile", async () => {
    app = createApp({ store, scanner });
    const user = await owner();
    const response = await start(user).expect(503);
    expect(response.body.error).toContain("ANTHROPIC_API_KEY");
    await start(user).set("Accept", "application/x-ndjson").expect(503).expect("Content-Type", /application\/json/);
    expect(scanner).not.toHaveBeenCalled();
    expect(await store.getBusiness(user.userId, user.business.id)).toBeDefined();
  });

  it("reports provider failure after scanning without applying or persisting a fake completed review", async () => {
    const user = await owner();
    complete.mockReset().mockResolvedValueOnce(tool("scan_website", {}))
      .mockRejectedValueOnce(new Anthropic.APIConnectionError({ message: "private-provider-error-body" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await start(user).expect(502);
      expect(response.body.error).toContain("AI provider could not complete");
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-provider-error-body");
      expect(await store.latestUnderstanding(user.userId, user.business.id)).toBeNull();
      expect(await store.listScans(user.userId, user.business.id)).toHaveLength(1);
      expect(await store.listProducts(user.userId, user.business.id)).toHaveLength(1);
      expect((await store.getBusiness(user.userId, user.business.id))?.description).toBe("Private profile notes");
    } finally { log.mockRestore(); }
  });

  it("reports token-truncated streams without saving them or changing an earlier completed briefing", async () => {
    const user = await owner();
    const previous = await start(user).expect(201);
    complete.mockResolvedValueOnce(tool("scan_website", {})).mockImplementationOnce(async (_input, _signal, onInput) => {
      onInput?.({ briefing: { summary: { text: "An unfinished replacement briefing" } } });
      return { ...tool("propose_business", { briefing: { summary: { text: "An unfinished replacement briefing" } } }), stop_reason: "max_tokens" };
    });
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await start(user).set("Accept", "application/x-ndjson").expect(200);
      const events = response.text.trim().split("\n").map((line: string) => understandingStreamEventSchema.parse(JSON.parse(line)));
      expect(events.some((event) => event.type === "briefing")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "error", status: 502, message: expect.stringContaining("response limit") });
      expect(events.some((event) => event.type === "complete")).toBe(false);
      expect(await store.latestUnderstanding(user.userId, user.business.id)).toEqual(previous.body.understanding);
      expect(await store.listScans(user.userId, user.business.id)).toHaveLength(1);
      expect((await store.getBusiness(user.userId, user.business.id))?.description).toBe("Private profile notes");
      expect(complete).toHaveBeenCalledTimes(4);
    } finally { log.mockRestore(); }
  });

  it.each(["", "http://127.0.0.1/"])("rejects absent or unsafe stored websites (%s)", async (website) => {
    const user = await owner("owner@example.test", website);
    await start(user).expect(400);
    expect(complete).not.toHaveBeenCalled(); expect(scanner).not.toHaveBeenCalled();
  });

  it("retains a failed scan and returns actionable limitations instead of generated findings", async () => {
    const user = await owner();
    scanner.mockResolvedValueOnce({ ...scan, status: "failed", pages: [], failures: [{ url, message: "Publisher blocks this page in robots.txt." }] });
    const response = await start(user).expect(201);
    expect(response.body.understanding.suggestions).toEqual([]);
    expect(response.body.understanding.productImportId).toBeNull();
    expect(response.body.understanding.scanStatus).toBe("failed");
    expect(response.body.understanding.warnings.join(" ")).toContain("robots.txt");
    expect(complete).toHaveBeenCalledOnce();
    expect((await store.listScans(user.userId, user.business.id))[0].status).toBe("failed");

    const database = new Database(path);
    try {
      database.prepare("UPDATE business_understandings SET result_json = json_remove(result_json, '$.scanStatus', '$.briefing') WHERE id = ?")
        .run(response.body.understanding.id);
    } finally { database.close(); }
    const restored = await request(app).get(`/api/businesses/${user.business.id}/understanding`).set("Cookie", user.cookie).expect(200);
    expect(restored.body.understanding.scanStatus).toBe("failed");
    expect(restored.body.understanding.briefing).toBeNull();
    expect(restored.body.understanding.suggestions).toEqual([]);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("preserves a partial scan's outcome alongside usable suggestions", async () => {
    const user = await owner();
    scanner.mockResolvedValueOnce({ ...scan, status: "partial", failures: [{ url: `${url}about`, message: "The website returned HTTP 503." }] });
    const response = await start(user).expect(201);
    expect(response.body.understanding.scanStatus).toBe("partial");
    expect(response.body.understanding.suggestions).toEqual(proposal.suggestions);
    expect(response.body.understanding.warnings.join(" ")).toContain("Only part");
  });

  it("records readable pages with no supported findings without inventing suggestions or product drafts", async () => {
    const user = await owner();
    scanner.mockResolvedValueOnce({ ...scan, pages: [{ ...scan.pages[0], productJson: [] }] });
    complete.mockReset().mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", { suggestions: [], briefing: null }));
    const response = await start(user).expect(201);
    expect(response.body.understanding).toMatchObject({ scanStatus: "complete", suggestions: [], productImportId: null });
    expect(response.body.understanding.warnings.join(" ")).toContain("could not support");
    expect((await store.getBusiness(user.userId, user.business.id))?.description).toBe("Private profile notes");
    await apply(user, response.body.understanding.id).expect(400);
  });

  it("does not charge anonymous preview scans against an authenticated account's analysis allowance", async () => {
    const user = await owner();
    for (let index = 0; index < 3; index++) await request(app).post("/api/website/scan").set("Origin", origin).send({ url, permission: true }).expect(200);
    await start(user).expect(201);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
