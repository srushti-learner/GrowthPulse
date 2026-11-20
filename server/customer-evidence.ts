import { createHash } from "node:crypto";
import type { Product } from "../shared/products.js";
import type { MarketplaceReport } from "../shared/marketplace.js";
import { marketplaceFeedbackScope } from "../shared/marketplace.js";
import type { ResearchFinding, ResearchSource } from "../shared/research.js";
import { productFingerprint } from "./product-intelligence.js";

export const customerEvidenceLimits = { reports: 6, findings: 3 } as const;
export type CustomerEvidence = { findings: ResearchFinding[]; limitations: string[] };
type SavedReport = { product: Product; report: MarketplaceReport; refreshing: boolean };
const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

export function customerEvidence(saved: SavedReport[]): CustomerEvidence {
  let stale = 0, unanalysed = 0, refreshing = 0, unsupported = 0;
  const seen = new Set<string>();
  const groups = saved.slice(0, customerEvidenceLimits.reports).map(({ product, report, refreshing: active }) => {
    if (active) { refreshing++; return []; }
    if (report.productId !== product.id || report.fingerprint !== productFingerprint(product)) { stale++; return []; }
    const analysedAt = report.analysedAt;
    if (!analysedAt) { unanalysed++; return []; }
    return report.themes.flatMap((theme): ResearchFinding[] => {
      const selected: ResearchSource[] = [], texts = new Set<string>();
      const ids = new Set(theme.reviewIds);
      if (ids.size !== theme.reviewIds.length) { unsupported++; return []; }
      for (const id of ids) {
        const matches = report.listings.flatMap((listing) => listing.reviews.filter((review) => review.id === id).map((review) => ({ listing, review })));
        const match = matches.length === 1 ? matches[0] : undefined;
        if (!match || match.listing.status !== "captured"
          || marketplaceFeedbackScope(match.listing.relation) !== theme.scope) {
          unsupported++; return [];
        }
        const { listing, review } = match;
        if (texts.has(normalized(review.text))) continue;
        texts.add(normalized(review.text));
        if (listing.relation === "unconfirmed" || listing.relation === "excluded") { unsupported++; return []; }
        selected.push({
          id: `e_${createHash("sha256").update(JSON.stringify([report.id, product.id, listing.id, listing.method, listing.relation, review])).digest("hex").slice(0, 16)}`,
          url: listing.url, quote: review.text, capturedAt: listing.capturedAt,
          customerReview: { productId: product.id, productName: product.name.slice(0, 150), reportId: report.id,
            relation: listing.relation, method: listing.method, reviewDate: review.date, analysedAt },
        });
      }
      if (selected.length < 2) { unsupported++; return []; }
      const identity = JSON.stringify([product.id, theme.scope, [...texts].sort()]);
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [{
        kind: "hypothesis", title: `${product.name}: ${theme.title}`.slice(0, 150),
        detail: `Prior AI interpretation of ${theme.scope === "own_product" ? "matched same-product" : "matched alternative-product"} review excerpts: ${theme.title}. Suggested test: ${theme.experiment} This is a dated sample, not a verified product defect or market-wide conclusion.`.slice(0, 600),
        sources: selected.slice(0, 2),
      }];
    });
  });
  const findings: ResearchFinding[] = [];
  for (let index = 0; index < 4 && findings.length < customerEvidenceLimits.findings; index++) {
    for (const group of groups) {
      if (group[index]) findings.push(group[index]);
      if (findings.length === customerEvidenceLimits.findings) break;
    }
  }
  const available = groups.reduce((count, group) => count + group.length, 0);
  return {
    findings,
    limitations: [
      findings.length
        ? `Reused ${findings.length} saved AI theme(s) with two original supporting excerpts each. These are hypotheses, not new independent observations. No additional review collection or customer-analysis call was made.`
        : "No eligible analysed, matched individual review themes were available in the saved sample. Aggregate ratings and brand marketing are not customer voice evidence.",
      "Reviews are a dated, selected sample, not representative current sentiment. Owner exports are not independently fetched or verified. Alternative-product reviews do not establish an issue with your product.",
      "Another seller's reviews can concern delivery or service; they do not prove a physical product defect or ownership of that seller's listing.",
      `Checked at most ${customerEvidenceLimits.reports} recent saved product reports. Omitted: ${stale} catalogue-stale, ${unanalysed} unanalysed, ${refreshing} being refreshed, ${unsupported} unsupported theme(s), ${Math.max(0, available - findings.length)} beyond the theme budget.`,
    ],
  };
}
