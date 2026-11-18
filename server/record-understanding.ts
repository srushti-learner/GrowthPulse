import { randomUUID } from "node:crypto";
import type { Store } from "./database.js";
import { partialBriefingNotice, type Proposal, type Understanding } from "../shared/understanding.js";
import type { SavedScan } from "../shared/website.js";
import { AgentError } from "./business-agent.js";

export async function recordUnderstanding(store: Store, ownerId: string, businessId: string, scan: SavedScan,
  proposal: Proposal & Pick<Understanding, "evidenceCoverage" | "research">) {
  const warnings = [...scan.notes, ...scan.failures.map((failure) => `${failure.url}: ${failure.message}`),
    ...scan.pages.filter((page) => page.warnings.length).map((page) => `${page.url}: ${page.warnings.join(" ")}`)];
  if (proposal.validationIssues?.length) warnings.unshift(partialBriefingNotice);
  if (scan.status === "partial") warnings.unshift("Only part of the permitted website could be read. These suggestions are not a full-site assessment.");
  if (!scan.pages.length) warnings.unshift("No pages could be read. No AI profile suggestions were generated. Use manual information or CSV, or try another permitted website.");
  else if (!proposal.briefing && !proposal.suggestions.length) warnings.unshift("The agent could not support a business briefing or profile suggestion from the captured evidence. Your profile is unchanged.");
  const catalogue = scan.catalogue ?? await store.syncWebsiteProducts(ownerId, businessId, scan);
  if (catalogue?.skipped) warnings.push(`${catalogue.skipped} website product records need attention. See Products for the reasons; usable products are already available.`);
  else if (!catalogue) warnings.push("No supported schema.org Product JSON-LD was captured. Products were not guessed from page text; use manual entry or CSV if needed.");
  const understanding = await store.saveUnderstanding(ownerId, {
    ...proposal, id: randomUUID(), businessId, scanId: scan.id,
    createdAt: new Date().toISOString(), scanStatus: scan.status, reviewedAt: null,
    warnings: warnings.length > 30 ? [...warnings.slice(0, 29), "Additional scan warnings are available in the saved Website evidence."] : warnings,
    productImportId: null,
    ...(catalogue ? { catalogue } : {}),
  });
  if (!understanding) throw new AgentError(404, "Business not found.");
  return understanding;
}
