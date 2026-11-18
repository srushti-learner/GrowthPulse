import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { activitiesSchema, businessesSchema, businessSchema, evidenceResponseSchema, userSchema, type Business, type BusinessInput, type User } from "../shared/contracts.js";
import { migrate } from "./migrations.js";
import { CatalogueError, catalogueStore } from "./catalogue-store.js";
import { savedScanSchema, scanResultSchema, scanSummarySchema, type ScanResult } from "../shared/website.js";
import { understandingSchema, type Understanding, type UnderstandingReviewInput } from "../shared/understanding.js";
import { previewLifetime } from "../shared/onboarding.js";
import { analysisStore } from "./analysis-store.js";
import { researchStore } from "./research-store.js";
import { growthStore } from "./growth-store.js";
import { productIntelligenceStore } from "./product-intelligence.js";
import { analyticsStore } from "./analytics-store.js";
import { marketplaceStore } from "./marketplace-research.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { sqliteDatabase, type SqlDatabase } from "./sql-database.js";
import { SqlCheckpointSaver } from "./sql-checkpointer.js";

export class EmailUnavailable extends Error {}
export class UnderstandingError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export class PreviewError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const businessColumns = "id, name, category, description, website, created_at AS createdAt, updated_at AS updatedAt";

export function openStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const database = new Database(path);
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    migrate(database);
    database.prepare("DELETE FROM onboarding_previews WHERE expires_at <= ?").run(Date.now());
  } catch (error) {
    database.close();
    throw error;
  }
  const wrapped = sqliteDatabase(database);
  return createStore(wrapped, new SqlCheckpointSaver(wrapped));
}

export function createStore(database: SqlDatabase, checkpointer: BaseCheckpointSaver) {
  const catalogue = catalogueStore(database);
  return {
    engine: database.dialect,
    ...catalogue,
    ...analysisStore(database),
    ...researchStore(database, checkpointer),
    ...growthStore(database),
    ...productIntelligenceStore(database),
    ...analyticsStore(database),
    ...marketplaceStore(database),
    async prunePreviews() {
      await database.prepare("DELETE FROM onboarding_previews WHERE expires_at <= ?").run(Date.now());
    },
    async savePreview(tokenHash: string, input: ScanResult, previousHash?: string) {
      const scan = scanResultSchema.parse(input);
      const json = JSON.stringify(scan);
      if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw new PreviewError(413, "These public findings are too large to carry into onboarding. Sign in and use the website workspace instead.");
      return database.transaction(async () => {
        await this.prunePreviews();
        if (previousHash) await this.discardPreview(previousHash);
        const count = (await database.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM onboarding_previews").get())!.count;
        if (count >= 50) throw new PreviewError(429, "Public preview storage is busy. Please try again later.");
        const expiresAt = Date.now() + previewLifetime;
        await database.prepare("INSERT INTO onboarding_previews (token_hash, result_json, expires_at) VALUES (?, ?, ?)")
          .run(tokenHash, json, expiresAt);
        return { scan, expiresAt: new Date(expiresAt).toISOString() };
      })();
    },
    async getPreview(tokenHash: string) {
      await this.prunePreviews();
      const row = await database.prepare<[string], { result: string; expiresAt: number }>(
        "SELECT result_json AS result, expires_at AS expiresAt FROM onboarding_previews WHERE token_hash = ?",
      ).get(tokenHash);
      return row ? { scan: scanResultSchema.parse(JSON.parse(row.result)), expiresAt: new Date(row.expiresAt).toISOString() } : null;
    },
    async discardPreview(tokenHash: string) {
      await database.prepare("DELETE FROM onboarding_previews WHERE token_hash = ?").run(tokenHash);
    },
    async claimPreview(ownerId: string, tokenHash: string) {
      return database.transaction(async () => {
        const preview = await this.getPreview(tokenHash);
        if (!preview) throw new PreviewError(410, "Your public findings have expired. Read the website again to continue.");
        const row = (await database.prepare<[string], { ownerId: string | null; businessId: string | null; scanId: string | null }>(
          "SELECT owner_id AS ownerId, business_id AS businessId, scan_id AS scanId FROM onboarding_previews WHERE token_hash = ?",
        ).get(tokenHash))!;
        if (row.ownerId && row.ownerId !== ownerId) throw new PreviewError(409, "These findings have already been saved to another account. Start a new website review.");
        if (row.businessId && row.scanId) {
          const business = await this.getBusiness(ownerId, row.businessId);
          const scan = await this.getScan(ownerId, row.businessId, row.scanId);
          if (!business || !scan) throw new PreviewError(409, "The saved preview is no longer available. Start a new website review.");
          return { business, scan, understanding: await this.latestUnderstanding(ownerId, business.id) };
        }
        if (preview.scan.status === "failed" || !preview.scan.pages.length) throw new PreviewError(400, "No public pages were captured. Try another permitted website or continue with manual information.");
        const url = new URL(preview.scan.requestedUrl);
        const existing = (await this.listBusinesses(ownerId)).find((business) => business.website && new URL(business.website).href === url.href);
        const business = existing ?? await this.saveBusiness(ownerId, { name: url.hostname.replace(/^www\./, "").slice(0, 120), website: url.href, category: "", description: "" });
        if (!business) throw new PreviewError(409, "The business could not be saved.");
        const scan = await this.saveScan(ownerId, business.id, preview.scan);
        if (!scan) throw new PreviewError(409, "The public findings could not be saved.");
        await database.prepare("UPDATE onboarding_previews SET owner_id = ?, business_id = ?, scan_id = ? WHERE token_hash = ?")
          .run(ownerId, business.id, scan.id, tokenHash);
        return { business, scan, understanding: await this.latestUnderstanding(ownerId, business.id) };
      })();
    },
    async close() { await database.close(); },
    async checkHealth() { await database.prepare("SELECT 1").get(); },
    async createAccount(user: User, passwordHash: string, tokenHash: string, expiresAt: number) {
      return database.transaction(async () => {
        if (await database.prepare("SELECT id FROM users WHERE email = ?").get(user.email)) throw new EmailUnavailable();
        await database.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)").run(user.id, user.name, user.email, passwordHash);
        await database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash, user.id, expiresAt);
      })();
    },
    async credentials(email: string) {
      const row = await database.prepare<[string], User & { passwordHash: string }>("SELECT id, name, email, password_hash AS passwordHash FROM users WHERE email = ?").get(email);
      return row ? { user: userSchema.parse(row), passwordHash: row.passwordHash } : undefined;
    },
    async createSession(userId: string, tokenHash: string, expiresAt: number, previousHash?: string) {
      await database.transaction(async () => {
        await database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
        await database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash, userId, expiresAt);
        if (previousHash) await database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(previousHash);
      })();
    },
    async sessionUser(tokenHash: string) {
      const row = await database.prepare("SELECT u.id, u.name, u.email FROM users u JOIN sessions s ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?").get(tokenHash, Date.now());
      return row ? userSchema.parse(row) : undefined;
    },
    async deleteSession(tokenHash: string) {
      await database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    },
    async listBusinesses(ownerId: string) {
      return businessesSchema.parse({ businesses: await database.prepare(`SELECT ${businessColumns} FROM businesses WHERE owner_id = ? ORDER BY created_at, id`).all(ownerId) }).businesses;
    },
    async getBusiness(ownerId: string, id: string) {
      const row = await database.prepare(`SELECT ${businessColumns} FROM businesses WHERE owner_id = ? AND id = ?`).get(ownerId, id);
      return row ? businessSchema.parse(row) : undefined;
    },
    async saveBusiness(ownerId: string, input: BusinessInput, existingId?: string) {
      return database.transaction(async () => {
        const now = new Date().toISOString();
        const id = existingId ?? randomUUID();
        if (existingId) {
          const result = await database.prepare("UPDATE businesses SET name = ?, category = ?, description = ?, website = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
            .run(input.name, input.category, input.description, input.website, now, id, ownerId);
          if (!result.changes) return undefined;
        } else {
          await database.prepare("INSERT INTO businesses (id, owner_id, name, category, description, website, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(id, ownerId, input.name, input.category, input.description, input.website, now, now);
        }
        const evidenceId = randomUUID();
        await database.prepare("INSERT INTO evidence (id, business_id, source, reference, summary, captured_at) VALUES (?, ?, 'manual', ?, ?, ?)")
          .run(evidenceId, id, `businesses/${id}`, "Business profile supplied by its signed-in owner. Not a scan or AI inference.", now);
        await database.prepare("INSERT INTO activities (id, business_id, evidence_id, action, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(randomUUID(), id, evidenceId, existingId ? "business.updated" : "business.created", now);
        return businessSchema.parse(await database.prepare(`SELECT ${businessColumns} FROM businesses WHERE id = ? AND owner_id = ?`).get(id, ownerId));
      })();
    },
    async saveScan(ownerId: string, businessId: string, input: ScanResult) {
      const { catalogue: _catalogue, ...captured } = scanResultSchema.parse(input);
      return database.transaction(async () => {
        if (!await database.prepare("SELECT id FROM businesses WHERE id = ? AND owner_id = ?").get(businessId, ownerId)) return undefined;
        const synced = await catalogue.syncWebsiteProducts(ownerId, businessId, captured);
        const result = { ...captured, ...(synced ? { catalogue: synced } : {}) };
        const id = randomUUID();
        await database.prepare("INSERT INTO website_scans (id, business_id, requested_url, status, started_at, completed_at, page_count, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, businessId, result.requestedUrl, result.status, result.startedAt, result.completedAt, result.pages.length, JSON.stringify(result));
        const sources = result.pages.length ? result.pages.map((page) => ({
          reference: page.url, capturedAt: page.capturedAt,
          summary: `Static HTML from scan ${id}. ${page.title}\n${page.description}\n${page.text}`.slice(0, 2000),
        })) : [{
          reference: result.requestedUrl, capturedAt: result.completedAt,
          summary: `Failed scan ${id}. No website content captured. ${result.failures.map((failure) => failure.message).join(" ")}`.slice(0, 2000),
        }];
        const firstEvidenceId = randomUUID();
        for (const [index, source] of sources.entries()) {
          await database.prepare("INSERT INTO evidence (id, business_id, source, reference, summary, captured_at) VALUES (?, ?, 'website', ?, ?, ?)")
            .run(index === 0 ? firstEvidenceId : randomUUID(), businessId, source.reference, source.summary, source.capturedAt);
        }
        await database.prepare("INSERT INTO activities (id, business_id, evidence_id, action, created_at) VALUES (?, ?, ?, 'website.scanned', ?)")
          .run(randomUUID(), businessId, firstEvidenceId, result.completedAt);
        return savedScanSchema.parse({ ...result, id, businessId });
      })();
    },
    async listScans(ownerId: string, businessId: string) {
      return (await database.prepare(`
        SELECT s.id, s.business_id AS businessId, s.requested_url AS requestedUrl, s.status,
          s.started_at AS startedAt, s.completed_at AS completedAt, s.page_count AS pageCount
        FROM website_scans s JOIN businesses b ON b.id = s.business_id
        WHERE b.owner_id = ? AND b.id = ? ORDER BY s.completed_at DESC, s.rowid DESC LIMIT 20
      `).all(ownerId, businessId)).map((row) => scanSummarySchema.parse(row));
    },
    async getScan(ownerId: string, businessId: string, scanId: string) {
      const row = await database.prepare<[string, string, string], { id: string; businessId: string; result: string }>(`
        SELECT s.id, s.business_id AS businessId, s.result_json AS result FROM website_scans s
        JOIN businesses b ON b.id = s.business_id WHERE b.owner_id = ? AND b.id = ? AND s.id = ?
      `).get(ownerId, businessId, scanId);
      return row ? savedScanSchema.parse({ ...scanResultSchema.parse(JSON.parse(row.result)), id: row.id, businessId: row.businessId }) : undefined;
    },
    async reusableScan(ownerId: string, businessId: string, url: string) {
      const row = await database.prepare<[string, string, string], { id: string }>(`
        SELECT s.id FROM website_scans s JOIN businesses b ON b.id = s.business_id
        WHERE b.owner_id = ? AND b.id = ? AND s.requested_url = ? AND s.status <> 'failed' AND s.page_count > 0
        ORDER BY s.completed_at DESC, s.rowid DESC LIMIT 1
      `).get(ownerId, businessId, url);
      return row ? this.getScan(ownerId, businessId, row.id) : undefined;
    },
    async getProductImportScan(ownerId: string, businessId: string, importId: string) {
      const draft = await catalogue.getProductImport(ownerId, businessId, importId);
      if (draft.source !== "website") throw new CatalogueError(400, "Only website previews can be refreshed from a saved scan.");
      const references = JSON.stringify(draft.rows.map(({ reference, capturedAt }) => ({ reference, capturedAt })));
      const matches = await database.prepare<[string, string, string], { id: string; businessId: string; result: string }>(database.dialect === "mysql" ? `
        SELECT s.id, s.business_id AS businessId, s.result_json AS result FROM website_scans s
        JOIN businesses b ON b.id = s.business_id
        WHERE b.owner_id = ? AND b.id = ?
          AND NOT EXISTS (
            SELECT 1 FROM JSON_TABLE(?, '$[*]' COLUMNS(
              reference TEXT PATH '$.reference', capturedAt LONGTEXT PATH '$.capturedAt'
            )) r WHERE NOT EXISTS (
              SELECT 1 FROM JSON_TABLE(s.result_json, '$.pages[*]' COLUMNS(
                url TEXT PATH '$.url', capturedAt LONGTEXT PATH '$.capturedAt'
              )) p WHERE BINARY p.url = BINARY r.reference AND BINARY p.capturedAt = BINARY r.capturedAt
            )
          )
        LIMIT 2
      ` : `
        SELECT s.id, s.business_id AS businessId, s.result_json AS result FROM website_scans s
        JOIN businesses b ON b.id = s.business_id
        WHERE b.owner_id = ? AND b.id = ?
          AND NOT EXISTS (
            SELECT 1 FROM json_each(?) r WHERE NOT EXISTS (
              SELECT 1 FROM json_each(s.result_json, '$.pages') p
              WHERE json_extract(p.value, '$.url') = json_extract(r.value, '$.reference')
                AND json_extract(p.value, '$.capturedAt') = json_extract(r.value, '$.capturedAt')
            )
          )
        LIMIT 2
      `).all(ownerId, businessId, references);
      if (matches.length !== 1) return undefined;
      const row = matches[0];
      return savedScanSchema.parse({ ...scanResultSchema.parse(JSON.parse(row.result)), id: row.id, businessId: row.businessId });
    },
    async saveUnderstanding(ownerId: string, input: Understanding) {
      const result = understandingSchema.parse(input);
      const saved = await database.prepare(`
        INSERT INTO business_understandings (id, business_id, created_at, result_json)
        SELECT ?, id, ?, ? FROM businesses WHERE id = ? AND owner_id = ?
      `).run(result.id, result.createdAt, JSON.stringify(result), result.businessId, ownerId);
      return saved.changes ? result : undefined;
    },
    async latestUnderstanding(ownerId: string, businessId: string, requestedUrl?: string) {
      const row = await database.prepare<[string, string, string | null, string | null], { result: string; scanStatus: string | null; reviewedAt: string | null }>(`
        SELECT u.result_json AS result, s.status AS scanStatus, u.reviewed_at AS reviewedAt FROM business_understandings u
        JOIN businesses b ON b.id = u.business_id
        LEFT JOIN website_scans s ON s.business_id = u.business_id AND s.id = ${database.dialect === "mysql" ? "JSON_UNQUOTE(JSON_EXTRACT(u.result_json, '$.scanId'))" : "json_extract(u.result_json, '$.scanId')"}
        WHERE b.owner_id = ? AND b.id = ? AND (? IS NULL OR s.requested_url = ?)
        ORDER BY u.created_at DESC, u.rowid DESC LIMIT 1
      `).get(ownerId, businessId, requestedUrl ?? null, requestedUrl ?? null);
      return row ? understandingSchema.parse({ ...JSON.parse(row.result), scanStatus: row.scanStatus, reviewedAt: row.reviewedAt }) : null;
    },
    async lastSuccessfulUnderstanding(ownerId: string, businessId: string) {
      const business = await this.getBusiness(ownerId, businessId);
      if (!business?.website) return null;
      const row = await database.prepare<[string, string, string], { result: string; scanStatus: string; reviewedAt: string | null }>(`
        SELECT u.result_json AS result, s.status AS scanStatus, u.reviewed_at AS reviewedAt FROM business_understandings u
        JOIN businesses b ON b.id = u.business_id
        JOIN website_scans s ON s.business_id = u.business_id AND s.id = ${database.dialect === "mysql" ? "JSON_UNQUOTE(JSON_EXTRACT(u.result_json, '$.scanId'))" : "json_extract(u.result_json, '$.scanId')"}
        WHERE b.owner_id = ? AND b.id = ? AND s.requested_url = ? AND s.status != 'failed'
          AND ${database.dialect === "mysql" ? "JSON_TYPE(JSON_EXTRACT(u.result_json, '$.briefing')) = 'OBJECT'" : "json_type(u.result_json, '$.briefing') = 'object'"}
        ORDER BY u.created_at DESC, u.rowid DESC LIMIT 1
      `).get(ownerId, businessId, new URL(business.website).href);
      return row ? understandingSchema.parse({ ...JSON.parse(row.result), scanStatus: row.scanStatus, reviewedAt: row.reviewedAt }) : null;
    },
    async applyUnderstanding(ownerId: string, businessId: string, reviewId: string, input: UnderstandingReviewInput): Promise<{ business: Business; understanding: Understanding }> {
      return database.transaction(async () => {
        const business = await this.getBusiness(ownerId, businessId);
        if (!business) throw new UnderstandingError(404, "Business not found.");
        const review = await this.latestUnderstanding(ownerId, businessId);
        if (!review || review.id !== reviewId) throw new UnderstandingError(409, "A newer analysis is available. Reload the business profile before saving.");
        if (review.reviewedAt) {
          if (business.category === input.category && business.description === input.description) return { business, understanding: review };
          throw new UnderstandingError(409, "This analysis has already been saved. Reload the business profile to edit its current details.");
        }
        if (!review.suggestions.length || review.scanStatus === "failed") throw new UnderstandingError(400, "This analysis has no profile suggestions to save.");
        const scan = await this.getScan(ownerId, businessId, review.scanId);
        if (business.updatedAt !== input.expectedUpdatedAt || !business.website || scan?.requestedUrl !== new URL(business.website).href) {
          throw new UnderstandingError(409, "Your business profile has changed. Reload it before saving; run a new analysis if the website changed.");
        }
        const saved = await this.saveBusiness(ownerId, { ...business, category: input.category, description: input.description }, businessId);
        if (!saved) throw new UnderstandingError(404, "Business not found.");
        await database.prepare("UPDATE business_understandings SET reviewed_at = ? WHERE id = ? AND business_id = ?")
          .run(saved.updatedAt, review.id, businessId);
        return { business: saved, understanding: { ...review, reviewedAt: saved.updatedAt } };
      })();
    },
    async listActivity(ownerId: string, businessId: string) {
      return activitiesSchema.parse({ activities: await database.prepare(`
        SELECT a.id, a.business_id AS businessId, a.evidence_id AS evidenceId, a.action, a.created_at AS createdAt
        FROM activities a JOIN businesses b ON b.id = a.business_id
        WHERE b.owner_id = ? AND b.id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 100
      `).all(ownerId, businessId) }).activities;
    },
    async listEvidence(ownerId: string, businessId: string) {
      return evidenceResponseSchema.parse({ evidence: await database.prepare(`
        SELECT e.id, e.business_id AS businessId, e.source, e.reference, e.summary, e.captured_at AS capturedAt
        FROM evidence e JOIN businesses b ON b.id = e.business_id
        WHERE b.owner_id = ? AND b.id = ? ORDER BY e.captured_at DESC, e.rowid DESC LIMIT 100
      `).all(ownerId, businessId) }).evidence;
    },
  };
}
export type Store = ReturnType<typeof openStore>;
