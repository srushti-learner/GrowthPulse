import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function modelInputSchema(schema: z.ZodType, sourceIds?: readonly string[]): Anthropic.Tool.InputSchema {
  function constrain(original: unknown, converted: unknown): unknown {
    if (Array.isArray(original) && Array.isArray(converted)) {
      return converted.map((item, index) => constrain(original[index], item));
    }
    if (!object(original) || !object(converted)) return converted;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(converted)) result[key] = constrain(original[key], value);
    // The installed SDK moves even supported enum/const constraints into descriptions.
    if (Array.isArray(original.enum)) result.enum = original.enum;
    if (Object.hasOwn(original, "const")) result.const = original.const;
    if (original.pattern === "^e_[a-f0-9]{16}$" && sourceIds?.length) result.enum = [...new Set(sourceIds)];
    return result;
  }
  const result = constrain(z.toJSONSchema(schema, { reused: "ref" }), zodOutputFormat(schema).schema);
  if (!object(result)) throw new Error("A model tool requires an object schema.");
  return { ...result, type: "object" };
}
