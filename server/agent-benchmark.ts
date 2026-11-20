import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AgentError, createAgentModel, type AgentModel } from "./business-agent.js";
import { contentPolicyVersion, reviewContent, type ContentField } from "./content-quality.js";
import { loadConfig } from "./config.js";

const benchmarkField = z.object({
  path: z.string().min(1).max(120), text: z.string().max(2000),
  maximum: z.number().int().min(1).max(2000), minimum: z.number().int().min(0).optional(),
  role: z.enum(["factual", "advisory", "mixed"]), policy: z.enum(["seo", "financial"]).optional(),
  sources: z.array(z.object({
    id: z.string().regex(/^e_[a-f0-9]{16}$/), quote: z.string().min(1).max(500),
    field: z.string().max(80).optional(), truncated: z.boolean().optional(), capturedAt: z.iso.datetime().optional(),
  }).strict()).max(6),
  forbiddenTerms: z.array(z.string().min(1).max(80)).max(8).optional(), sampledEvidence: z.boolean().optional(),
  expected: z.enum(["supported", "needs_revision"]),
  disallowedPhrases: z.array(z.string().min(1).max(200)).max(12).default([]),
}).strict();
export const benchmarkCasesSchema = z.array(z.object({
  id: z.string().min(1).max(80), sourceUrl: z.url().optional(), allowPartial: z.boolean().default(false),
  fields: z.array(benchmarkField).min(1).max(32).refine((fields) => new Set(fields.map((field) => field.path)).size === fields.length,
    "Benchmark paths must be unique."),
}).strict()).min(1).max(8).refine((cases) => new Set(cases.map((item) => item.id)).size === cases.length,
  "Benchmark case IDs must be unique.");
type BenchmarkCase = z.infer<typeof benchmarkCasesSchema>[number];
class BenchmarkLimit extends Error {}

export async function runReviewerBenchmark(complete: AgentModel, cases: BenchmarkCase[], models: string[], maximumCalls: number) {
  if (!models.length || models.length > 2 || new Set(models).size !== models.length || maximumCalls < 1 || maximumCalls > 32) {
    throw new Error("Invalid benchmark model or call bounds.");
  }
  let calls = 0, budgetExceeded = false;
  const results = [];
  for (const model of models) {
    for (const fixture of cases) {
      if (calls >= maximumCalls) { budgetExceeded = true; break; }
      const started = performance.now();
      let caseCalls = 0, inputTokens: number | null = null, outputTokens: number | null = null;
      const fields: ContentField[] = fixture.fields.map(({ expected: _, disallowedPhrases: __, ...field }) => ({
        ...structuredClone(field), replace(text) { this.text = text; },
      }));
      const metered: AgentModel = async (input, signal) => {
        if (calls >= maximumCalls) { budgetExceeded = true; throw new BenchmarkLimit(); }
        calls++; caseCalls++;
        const message = await complete(input, signal);
        if (message.usage?.input_tokens !== undefined) inputTokens = (inputTokens ?? 0) + message.usage.input_tokens;
        if (message.usage?.output_tokens !== undefined) outputTokens = (outputTokens ?? 0) + message.usage.output_tokens;
        return message;
      };
      let outcome: "accepted" | "partial" | "rejected" | "failed" = "accepted";
      let errorCode: string | undefined, rejectedPaths: string[] = [];
      try {
        const review = await reviewContent(metered, model, fields, {
          sourceUrl: fixture.sourceUrl,
          completeLiveInventory: false,
        }, AbortSignal.timeout(120_000), { allowPartial: fixture.allowPartial });
        rejectedPaths = review.rejected.map((field) => field.path);
        if (rejectedPaths.length) outcome = "partial";
      } catch (error) {
        outcome = error instanceof AgentError && error.code === "content_quality_failed" ? "rejected" : "failed";
        errorCode = error instanceof BenchmarkLimit ? "benchmark_limit"
          : error instanceof AgentError ? error.code ?? "agent_error"
            : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "provider_or_execution_error";
        rejectedPaths = fields.map((field) => field.path);
      }
      const evaluated = fields.map((field, index) => {
        const original = fixture.fields[index];
        const accepted = !rejectedPaths.includes(field.path);
        const knownIssueMiss = accepted && original.expected === "needs_revision"
          && (field.text === original.text || original.disallowedPhrases.some((phrase) => field.text.toLowerCase().includes(phrase.toLowerCase())));
        return { path: field.path, expected: original.expected, originalText: original.text, text: field.text,
          sources: original.sources, accepted, corrected: accepted && field.text !== original.text, knownIssueMiss };
      });
      results.push({ model, caseId: fixture.id, outcome, errorCode, calls: caseCalls,
        milliseconds: Math.round(performance.now() - started), inputTokens, outputTokens,
        acceptedNonemptyFields: evaluated.filter((field) => field.accepted && field.text.trim()).length,
        knownIssueMisses: evaluated.filter((field) => field.knownIssueMiss).length,
        fields: evaluated });
    }
    if (budgetExceeded) break;
  }
  return {
    policyVersion: contentPolicyVersion, models, maximumCalls, calls, complete: !budgetExceeded && results.length === models.length * cases.length,
    costBasis: "Measured token usage is a cost proxy, not a billing total. Failed requests may have unreported usage.",
    evaluationLimit: "Known-issue checks are bounded regression checks, not proof of factual correctness. Manually audit the included accepted text and source excerpts.",
    results,
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    input: { type: "string" }, output: { type: "string" }, models: { type: "string" }, "max-calls": { type: "string", default: "16" },
  } });
  if (!values.input || !values.output || !values.models) throw new Error("input_output_models_required");
  if (existsSync(values.output)) throw new Error("output_already_exists");
  if (statSync(values.input).size > 128 * 1024) throw new Error("input_too_large");
  const cases = benchmarkCasesSchema.parse(JSON.parse(readFileSync(values.input, "utf8")));
  const maximumCalls = z.coerce.number().int().min(1).max(32).parse(values["max-calls"]);
  const complete = createAgentModel({ apiKey: loadConfig().ANTHROPIC_API_KEY });
  if (!complete) throw new Error("api_key_missing");
  const result = await runReviewerBenchmark(complete, cases, values.models.split(","), maximumCalls);
  writeFileSync(values.output, JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ complete: result.complete, calls: result.calls,
    results: result.results.map(({ fields: _, ...summary }) => summary) }, null, 2));
  if (!result.complete || result.results.some((item) => item.outcome === "failed" || item.knownIssueMisses)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error("Agent benchmark failed:", error instanceof z.ZodError ? "invalid_input"
      : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "execution_error");
    process.exitCode = 1;
  });
}
