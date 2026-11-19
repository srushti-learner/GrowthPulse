import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Product } from "../shared/products.js";
import { researchFindingSchema } from "../shared/research.js";
import { importMarketplaceCsv } from "./marketplace-research.js";
import { customerEvidence } from "./customer-evidence.js";

function fixture() {
  const now = new Date().toISOString();
  const product: Product = { id: randomUUID(), businessId: randomUUID(), name: "Fixture oil", description: "", sku: "", gtin: "",
    listings: [], createdAt: now, updatedAt: now };
  const report = importMarketplaceCsv(product, `product_url,title,review,review_date
https://www.amazon.in/dp/B000000001,Fixture oil,The bottle leaks during dispensing.,2026-10-01
https://www.amazon.in/dp/B000000001,Fixture oil,Packaging leaks every time I pour.,2026-10-02
`);
  report.listings[0].relation = "my_listing";
  report.analysedAt = now;
  report.themes = [{ title: "Possible dispensing issue", sentiment: "negative", scope: "own_product",
    reviewIds: report.listings[0].reviews.map((review) => review.id), experiment: "Check seals before testing packaging changes." }];
  return { product, report, refreshing: false };
}

describe("bounded reuse of confirmed customer review evidence", () => {
  it("retains original excerpts, dates, source provenance and hypothesis status without fabricating new feedback", () => {
    const saved = fixture(), result = customerEvidence([saved]);
    expect(result.findings).toHaveLength(1);
    const finding = researchFindingSchema.parse(result.findings[0]);
    expect(finding.kind).toBe("hypothesis");
    expect(finding.sources.map((source) => source.quote)).toEqual(saved.report.listings[0].reviews.map((review) => review.text));
    expect(finding.sources[0].customerReview).toMatchObject({
      productId: saved.product.id, method: "owner_export", relation: "my_listing", reviewDate: "2026-10-01",
    });
    expect(finding.sources[0].id).not.toBe(finding.sources[1].id);
    expect(customerEvidence([saved])).toEqual(result);
    expect(result.limitations.join(" ")).toContain("not independently fetched or verified");
  });

  it.each(["stale", "unanalysed", "refreshing", "unconfirmed", "excluded", "unavailable", "duplicate-ids", "unknown-id", "duplicate-text"] as const)(
    "does not reuse %s review themes", (reason) => {
      const saved = fixture(), listing = saved.report.listings[0], theme = saved.report.themes[0];
      if (reason === "stale") saved.product.description = "Changed catalogue identity";
      if (reason === "unanalysed") saved.report.analysedAt = null;
      if (reason === "refreshing") saved.refreshing = true;
      if (reason === "unconfirmed" || reason === "excluded") listing.relation = reason;
      if (reason === "unavailable") listing.status = "unavailable";
      if (reason === "duplicate-ids") theme.reviewIds[1] = theme.reviewIds[0];
      if (reason === "unknown-id") theme.reviewIds[1] = "r_0000000000000000";
      if (reason === "duplicate-text") listing.reviews[1].text = `  ${listing.reviews[0].text.toUpperCase()} `;
      const result = customerEvidence([saved]);
      expect(result.findings).toEqual([]);
      expect(result.limitations.join(" ")).toContain("No eligible");
    },
  );

  it("keeps alternative-product feedback separate and retains another seller's provenance", () => {
    const saved = fixture();
    saved.report.listings[0].relation = "alternative";
    expect(customerEvidence([saved]).findings).toEqual([]);
    saved.report.themes[0].scope = "alternatives";
    expect(customerEvidence([saved]).findings[0].detail).toContain("alternative-product");
    expect(customerEvidence([saved]).findings[0].sources[0].customerReview?.relation).toBe("alternative");
    saved.report.listings[0].relation = "other_seller";
    expect(customerEvidence([saved]).findings).toEqual([]);
    saved.report.themes[0].scope = "own_product";
    expect(customerEvidence([saved]).findings[0].sources[0].customerReview?.relation).toBe("other_seller");
  });

  it("omits duplicated themes and bounds the reusable sample across product reports", () => {
    const saved = fixture();
    saved.report.themes.push({ ...saved.report.themes[0], title: "Another name for the same excerpts" });
    expect(customerEvidence([saved]).findings).toHaveLength(1);
    const reports = Array.from({ length: 7 }, fixture);
    const result = customerEvidence(reports);
    expect(result.findings).toHaveLength(3);
    expect(new Set(result.findings.map((finding) => finding.sources[0].customerReview?.productId)).size).toBe(3);
    expect(result.limitations.join(" ")).toContain("3 beyond the theme budget");
  });
});
