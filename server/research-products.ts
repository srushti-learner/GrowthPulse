import { createHash } from "node:crypto";
import { z } from "zod";
import { buildAgentEvidence } from "./agent-evidence.js";
import { websiteProducts } from "./product-imports.js";
import { CatalogueError } from "./catalogue-store.js";
import { normalizedGtin, productInputSchema } from "../shared/products.js";
import { researchLimits, researchSourceSchema, type ResearchSource, type ResearchFinding } from "../shared/research.js";
import type { ScanResult } from "../shared/website.js";

export const researchProductSchema = z.object({
  id: z.string(), role: z.enum(["merchant", "competitor"]), url: z.url(), capturedAt: z.iso.datetime(),
  data: productInputSchema, sources: z.array(researchSourceSchema).min(1),
});
export type ResearchProduct = z.infer<typeof researchProductSchema>;

export function researchEvidence(scan: ScanResult) {
  const evidence = buildAgentEvidence(scan);
  const sources: ResearchSource[] = evidence.payload.pages.flatMap((page) =>
    page.excerpts.map((excerpt) => ({ id: excerpt.id, url: page.url, quote: excerpt.quote, capturedAt: page.capturedAt })));
  return { sources, coverage: evidence.coverage };
}

export function researchProducts(scan: ScanResult, role: ResearchProduct["role"]) {
  const { sources } = researchEvidence(scan);
  const products: ResearchProduct[] = [];
  for (const page of scan.pages) {
    for (const json of page.productJson ?? []) {
      let rows;
      try { rows = websiteProducts({ pages: [{ ...page, productJson: [json] }] }); }
      catch (error) { if (error instanceof CatalogueError && error.status === 400) continue; throw error; }
      for (const row of rows) {
        if (!row.data || row.errors.length) continue;
        const data = row.data;
        const support = sources.filter((source) => source.url === page.url && source.quote.includes(`name: ${data.name}`)).slice(0, 3);
        if (!support.length) continue;
        const identity = JSON.stringify([page.url, data.gtin, data.sku, data.name, data.variants]);
        const id = `p_${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
        if (products.some((product) => product.id === id)) continue;
        products.push({ id, role, url: page.url, capturedAt: page.capturedAt, data, sources: support });
        if (products.length >= researchLimits.productsPerSite) return products;
      }
    }
  }
  return products;
}

export function compareResearchProducts(merchant: ResearchProduct[], competitors: ResearchProduct[]) {
  const findings: ResearchFinding[] = [];
  function citedOffer(product: ResearchProduct) {
    for (const source of product.sources) {
      const fields = new Map(source.quote.split("\n").flatMap((line) => {
        const separator = line.indexOf(": ");
        return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 2).trim()]];
      }));
      if (!["gtin", "gtin8", "gtin12", "gtin13", "gtin14"].some((key) => fields.get(key) === product.data.gtin)) continue;
      const priceKey = [...fields.keys()].find((key) => /^offers(?:\[0\])?\.price$/.test(key)
        && fields.get(key) === product.data.price);
      const supported = priceKey && fields.get(priceKey.replace(/\.price$/, ".priceCurrency"))?.toUpperCase() === product.data.currency;
      return { source, offer: supported ? `${product.data.price} ${product.data.currency}` : "not established in the retained quote" };
    }
    return undefined;
  }
  for (const own of merchant) {
    if (!own.data.gtin) continue;
    const other = competitors.find((product) => product.data.gtin
      && normalizedGtin(product.data.gtin) === normalizedGtin(own.data.gtin));
    if (!other) continue;
    const ownEvidence = citedOffer(own), otherEvidence = citedOffer(other);
    if (!ownEvidence || !otherEvidence) continue;
    const sources = [ownEvidence.source, otherEvidence.source];
    findings.push({
      kind: "observation", title: `Matching published GTIN: ${own.data.name}`.slice(0, 150),
      detail: `These publisher records share a GTIN. Merchant offer: ${ownEvidence.offer}. Competitor offer: ${otherEvidence.offer}. These are dated observations, not a verified like-for-like price advantage.`.slice(0, 600),
      sources,
    });
    if (findings.length === 4) break;
  }
  return {
    findings,
    limitations: [
      findings.length
        ? `Found ${findings.length} matching published GTIN record pair(s) in this sample. Published offers may still be incomplete; like-for-like price comparability is not established.`
        : !merchant.length || !competitors.length
          ? `Pricing coverage is unavailable: captured structured products include ${merchant.length} merchant and ${competitors.length} verified-competitor record(s).`
          : `No quote-supported exact GTIN pair was found among ${merchant.length} merchant and ${competitors.length} verified-competitor product record(s). Similar products may still compete.`,
      "Cross-store SKUs and similar names do not establish an exact match; only matching valid GTINs are identified here.",
      "GTINs and offer values must appear in retained product quotes. Fields outside those excerpts are not presented as cited pricing evidence.",
      "No price delta or unit-price advantage is calculated: market, quantities, tax, shipping and promotion conditions have not all been established.",
      `At most ${researchLimits.productsPerSite} structured products per scanned site are sampled. No match in this sample does not mean there is no competing product.`,
    ],
  };
}
