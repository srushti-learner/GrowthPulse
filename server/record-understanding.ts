import { randomUUID } from "node:crypto";
import type { Store } from "./database.js";
import { partialBriefingNotice, type Proposal, type Understanding } from "../shared/understanding.js";
import type { SavedScan } from "../shared/website.js";
import { websiteProducts } from "./product-imports.js";
import { CatalogueError } from "./catalogue-store.js";
import { AgentError } from "./business-agent.js";

export function recordUnderstanding(store: Store, ownerId: string, businessId: string, scan: SavedScan,
  proposal: Proposal & Pick<Understanding, "evidenceCoverage" | "research">) {
  const warnings = [...scan.notes, ...scan.failures.map((failure) => `${failure.url}: ${failure.message}`),
    ...scan.pages.filter((page) => page.warnings.length).map((page) => `${page.url}: ${page.warnings.join(" ")}`)];
  if (proposal.validationIssues?.length) warnings.unshift(partialBriefingNotice);
  if (scan.status === "partial") warnings.unshift("Only part of the permitted website could be read. These suggestions are not a full-site assessment.");
  if (!scan.pages.length) warnings.unshift("No pages could be read. No AI profile suggestions were generated. Use manual information or CSV, or try another permitted website.");
  else if (!proposal.briefing && !proposal.suggestions.length) warnings.unshift("The agent could not support a business briefing or profile suggestion from the captured evidence. Your profile is unchanged.");
  let productImportId: string | null = null;
  try {
    const rows = websiteProducts(scan);
    productImportId = store.createProductImport(ownerId, businessId, "website", new URL(scan.requestedUrl).hostname.replace(/^www\./, ""), rows).id;
  } catch (error) {
    if (!(error instanceof CatalogueError) || error.status !== 400) throw error;
    warnings.push(error.message);
  }
  const understanding = store.saveUnderstanding(ownerId, {
    ...proposal, id: randomUUID(), businessId, scanId: scan.id,
    createdAt: new Date().toISOString(), scanStatus: scan.status, reviewedAt: null,
    warnings: warnings.length > 30 ? [...warnings.slice(0, 29), "Additional scan warnings are available in the saved Website evidence."] : warnings,
    productImportId,
  });
  if (!understanding) throw new AgentError(404, "Business not found.");
  return understanding;
}
