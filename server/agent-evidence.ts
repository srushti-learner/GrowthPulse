import { createHash } from "node:crypto";
import { agentEvidenceLimits } from "../shared/understanding.js";
import type { ScanResult } from "../shared/website.js";

const productFields = new Set([
  "name", "description", "sku", "gtin", "gtin8", "gtin12", "gtin13", "gtin14", "url",
  "brand", "category", "material", "color", "size", "pattern", "image", "offers",
  "aggregateRating", "additionalProperty", "audience",
]);
const nestedFields = new Set([
  "@type", "name", "description", "url", "price", "priceCurrency", "availability",
  "lowPrice", "highPrice", "offerCount", "priceValidUntil", "itemCondition",
  "ratingValue", "ratingCount", "reviewCount", "bestRating", "worstRating", "value", "audienceType",
]);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function productDetails(json: string): string {
  const raw: unknown = JSON.parse(json);
  const lines: string[] = [];
  function visit(value: unknown, path: string, depth: number) {
    if (depth > 4 || lines.length >= 100) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`${path}: ${String(value)}`); return;
    }
    if (Array.isArray(value)) { value.slice(0, 20).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1)); return; }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) if ((depth === 0 ? productFields : nestedFields).has(key)) {
        visit(child, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  }
  visit(raw, "", 0);
  return lines.join("\n");
}

export function buildAgentEvidence(scan: ScanResult) {
  let sourceIndex = 0;
  const limitations = new Set<string>();
  const payload = {
    status: scan.status, notes: scan.notes, failures: scan.failures, coverage: scan.coverage,
    pages: [] as {
      url: string; capturedAt: string; title: string;
      excerpts: { id: string; field: string; quote: string }[];
    }[],
    limitations: [] as string[],
  };
  const productRecordsCaptured = scan.pages.reduce((count, page) => count + (page.productJson?.length ?? 0), 0);
  if (scan.coverage?.limited || scan.status === "partial") limitations.add("Website coverage is partial or sampled; this is not the full website or catalogue.");
  limitations.add("Static HTML only. JavaScript-only content, private sales, margins and campaign performance are unavailable.");
  let productRecordsProvided = 0;
  // Reserve room for explicit omissions; divide the rest so a large homepage cannot crowd out product pages.
  const pageBudget = Math.floor((agentEvidenceLimits.bytes - bytes(payload) - 16_384) / Math.max(1, scan.pages.length));
  if (pageBudget < 4096) throw new Error("The scan metadata exceeds the agent evidence budget.");
  for (const page of scan.pages) {
    const supplied = { url: page.url, capturedAt: page.capturedAt, title: page.title,
      excerpts: [] as { id: string; field: string; quote: string }[] };
    let clipped = false;
    function fit(value: string, field: string, ceiling = pageBudget) {
      value = value.trim();
      if (!value) return false;
      // Short fields get context so every offered ID resolves to a valid source quote.
      if (value.length < 10) value = `${field} value: ${value}`;
      let added = false;
      for (let offset = 0; offset < value.length;) {
        let end = Math.min(offset + 480, value.length);
        if (value.length - end < 10) end = value.length;
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
        const quote = value.slice(offset, end).trim();
        offset = end;
        if (quote.length < 10) continue;
        const excerpt = { id: `e_${(sourceIndex++).toString(16).padStart(16, "0")}`, field, quote };
        supplied.excerpts.push(excerpt);
        if (bytes(supplied) > ceiling) {
          let low = 0, high = quote.length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            excerpt.quote = quote.slice(0, middle);
            if (bytes(supplied) <= ceiling) low = middle; else high = middle - 1;
          }
          excerpt.quote = quote.slice(0, low).replace(/[\uD800-\uDBFF]$/, "").trim();
          clipped = true;
          if (excerpt.quote.length < 10) { supplied.excerpts.pop(); return added; }
          return true;
        }
        added = true;
      }
      return added;
    }
    fit(page.title, "title", Math.floor(pageBudget / 4));
    fit(page.description, "description", Math.floor(pageBudget / 4));
    for (const json of page.productJson ?? []) {
      if (productRecordsProvided >= agentEvidenceLimits.products) { clipped = true; break; }
      let details: string;
      try { details = productDetails(json); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        limitations.add("Malformed saved structured product records were excluded from analysis."); continue;
      }
      if (!details) { clipped = true; continue; }
      if (!fit(details, "product", Math.floor(pageBudget * .6))) break;
      productRecordsProvided++;
    }
    for (const key of ["headings", "contacts", "callsToAction"] as const) {
      const values = key === "headings" ? page.headings.map((heading) => heading.text) : page[key];
      for (const value of values) {
        if (!fit(value, key, Math.floor(pageBudget * .75))) break;
      }
    }
    fit(page.text, "text");
    if (clipped) limitations.add(`Evidence excerpts or product fields were shortened/omitted for ${page.url.slice(0, 300)}.`);
    payload.pages.push(supplied);
  }
  if (productRecordsProvided < productRecordsCaptured) limitations.add(`Provided ${productRecordsProvided} of ${productRecordsCaptured} captured structured product records; the rest were outside the analysis budget.`);
  limitations.add("Product fields are publisher claims. Nested fields/arrays are sampled; missing fields are not evidence of absence. AggregateOffer ranges are not individual prices.");
  payload.limitations = [...limitations];
  // Shared snapshot prefixes avoid hundreds of unrelated branches in strict citation grammars.
  const sourceScope = createHash("sha256").update(JSON.stringify(payload.pages)).digest("hex").slice(0, 12);
  for (const page of payload.pages) {
    for (const excerpt of page.excerpts) excerpt.id = `e_${sourceScope}${excerpt.id.slice(-4)}`;
  }
  if (bytes(payload) > agentEvidenceLimits.bytes) throw new Error("The agent evidence exceeded its input budget.");
  const coverage = {
    pagesProvided: payload.pages.length, productRecordsCaptured, productRecordsProvided, inputBytes: bytes(payload),
    limited: !!scan.coverage?.limited || scan.status !== "complete" || limitations.size > 2,
    limitations: payload.limitations,
  };
  const sources = new Map(payload.pages.flatMap((page) =>
    page.excerpts.map((excerpt) => [excerpt.id, { url: page.url, quote: excerpt.quote }] as const)));
  return { payload, coverage, sources };
}
