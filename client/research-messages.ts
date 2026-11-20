import type { ResearchStep } from "../shared/research";

const legacyProviderFailures = new Set([
  "The AI provider could not complete this request. Check the server's Anthropic key, model access and billing, then retry. Your profile is unchanged.",
  "The model provider could not complete this step. Check the server-side Anthropic key, model access and billing. No automatic retry was made.",
]);

export const describeLimitation = (text: string) => legacyProviderFailures.has(text)
  ? "The AI provider could not complete this saved attempt. Its specific cause was not recorded. This message does not establish a key or billing problem."
  : text;

export function describeStepLimitations(step: ResearchStep): string[] {
  if (step.key === "pricing" && step.agent === "pricing" && step.limitations.length
    && (step.status === "completed" || step.status === "limited")) {
    return [step.findings.length
      ? "Published prices are available, but we can't yet make a like-for-like comparison."
      : "We couldn't find enough matching product prices to compare."];
  }
  return [...new Set(step.limitations.map(describeLimitation))];
}
