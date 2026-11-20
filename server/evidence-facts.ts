import { z } from "zod";

export type FactSource = {
  id: string; quote: string; field?: string; truncated?: boolean; capturedAt?: string;
  structured?: boolean;
};
export const numericTokens = (text: string) =>
  text.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? [];
export const factsFirstInstruction = "Before writing prose, use the server's factSheet to identify supported identities and captured field values, then check their original selected excerpts for scope, dates, conflicts and complete qualifiers. The fact sheet is a bounded selection, not a complete catalogue or independent verification. Derive factual wording from those source-backed values; use other excerpts only when their complete meaning and product scope are clear. Separate claims, interpretations and proposed checks. Omit ambiguous or cut-off ingredients instead of guessing a repair.";

export function capturedFacts(sources: FactSource[], maximumBytes = 8192) {
  const facts: { reference: string; field: string; value: string; capturedAt?: string; status: "captured_claim" }[] = [];
  let omitted = 0;
  for (const source of sources) {
    let values: [string, string][] = [];
    if (source.structured) {
      if (source.truncated) { omitted++; continue; }
      const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(source.quote));
      if (!parsed.success) throw new Error("A structured fact source is invalid.");
      values = Object.entries(parsed.data);
    } else if (source.field === "product" || source.field === "matching_summary") {
      const lines = source.quote.split("\n");
      values = lines.flatMap((line, index) => {
        if (source.truncated && index === lines.length - 1) return [];
        const match = /^([a-z][\w.[\]-]*):\s*(.+)$/i.exec(line);
        return match ? [[match[1], match[2]] as [string, string]] : [];
      });
    } else if (source.truncated === false) {
      values = [[source.field ?? "excerpt", source.quote]];
    }
    for (const [field, value] of values) {
      // A shortened description is not a complete ingredient list or a complete claim.
      if (!value.trim() || source.truncated && /description|ingredients?|nutrition/i.test(field)) { omitted++; continue; }
      const fact = { reference: source.id, field, value, capturedAt: source.capturedAt, status: "captured_claim" as const };
      if (facts.length >= 48 || Buffer.byteLength(JSON.stringify([...facts, fact])) > maximumBytes) { omitted++; continue; }
      facts.push(fact);
    }
  }
  return {
    facts, omitted,
    rules: "These are captured publisher/owner claims, not independently verified facts. Each reference points to its original excerpt. Do not combine unrelated products, calculate new prices or nutrition values, infer current stock or website-wide absence, or reconstruct shortened claims. Use full selected excerpts to verify qualifiers; omit uncertain facts from consumer copy.",
  };
}
