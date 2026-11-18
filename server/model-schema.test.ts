import { describe, expect, it } from "vitest";
import { z } from "zod";
import { modelInputSchema } from "./model-schema.js";

function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(nodes)];
}

describe("provider wire-schema constraints", () => {
  const ids = ["e_1111111111111111", "e_2222222222222222"];
  const sourceId = z.string().regex(/^e_[a-f0-9]{16}$/);

  it("restores real citation enums in reused definitions and nested arrays without restoring unsupported bounds", () => {
    const schema = modelInputSchema(z.object({
      sourceId, summary: z.object({ sourceId }),
      findings: z.array(z.object({ sourceIds: z.array(sourceId).min(1).max(3), text: z.string().min(10).max(300) })).max(4),
    }), [...ids, ids[0]]);
    expect(schema.$defs).toBeDefined();
    expect(nodes(schema).filter((node) => JSON.stringify(node.enum) === JSON.stringify(ids))).toHaveLength(1);
    expect(nodes(schema).filter((node) => typeof node.$ref === "string").length).toBeGreaterThan(1);
    expect(nodes(schema).every((node) => !("maxLength" in node) && !("minLength" in node) && !("maxItems" in node))).toBe(true);
  });

  it("preserves categorical enums and literal constants, including nullable union branches", () => {
    const schema = modelInputSchema(z.object({
      name: z.literal("record_findings"),
      result: z.object({ kind: z.enum(["observation", "suggestion"]), sourceId }).nullable(),
    }), ids);
    expect(nodes(schema)).toContainEqual(expect.objectContaining({ const: "record_findings" }));
    expect(nodes(schema)).toContainEqual(expect.objectContaining({ enum: ["observation", "suggestion"] }));
    expect(nodes(schema)).toContainEqual(expect.objectContaining({ enum: ids }));
  });

  it("does not generate an invalid empty enum when no sources are supplied", () => {
    expect(nodes(modelInputSchema(z.object({ sourceId }), []))).not.toContainEqual(expect.objectContaining({ enum: [] }));
  });
});
