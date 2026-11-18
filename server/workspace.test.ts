import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app.js";
import { openStore, type Store } from "./database.js";
import { digestToken, newSession } from "./auth.js";
import { randomUUID } from "node:crypto";
import { migrations } from "./migrations.js";

const origin = "http://127.0.0.1:5173";
const password = "a local test passphrase";
const profile = { name: "Urban Threads", category: "Clothing", description: "Owner-provided description", website: "" };

describe("persisted identity and business ownership", () => {
  let directory: string;
  let path: string;
  let store: Store;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "growthpulse-db-"));
    path = join(directory, "test.sqlite");
    store = openStore(path);
    app = createApp({ store, origin });
  });
  afterEach(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

  async function register(email = "owner@example.test") {
    const response = await request(app).post("/api/auth/register").set("Origin", origin).send({ name: "Local Owner", email, password }).expect(201);
    const cookies = response.headers["set-cookie"];
    if (!Array.isArray(cookies)) throw new Error("Missing session cookie");
    return { cookie: String(cookies[0]).split(";")[0], response };
  }

  it("validates signup, hashes credentials, normalizes emails, and invalidates logout sessions", async () => {
    await request(app).post("/api/auth/register").set("Origin", origin).send({ name: "Owner", email: "bad", password: "short" }).expect(400);
    const { cookie, response } = await register("OWNER@example.test");
    expect(response.body.user.email).toBe("owner@example.test");
    expect(JSON.stringify(response.body)).not.toContain("password");
    expect(response.headers["set-cookie"][0]).toMatch(/HttpOnly/);
    expect(response.headers["set-cookie"][0]).toMatch(/SameSite=Lax/);
    expect(response.headers["set-cookie"][0]).not.toMatch(/Secure/);
    const database = new Database(path);
    const stored = database.prepare("SELECT password_hash FROM users").get() as { password_hash: string };
    expect(stored.password_hash).toMatch(/^scrypt\$/);
    expect(stored.password_hash).not.toContain(password);
    const session = database.prepare("SELECT token_hash FROM sessions").get() as { token_hash: string };
    expect(session.token_hash).toBe(digestToken(cookie.split("=")[1]));
    database.close();
    await request(app).get("/api/auth/me").set("Cookie", cookie).expect(200).expect("Cache-Control", "no-store");
    await request(app).post("/api/auth/register").set("Origin", origin).send({ name: "Other", email: "owner@example.test", password }).expect(409);
    await request(app).post("/api/auth/logout").set("Origin", origin).set("Cookie", cookie).expect(204);
    await request(app).get("/api/auth/me").set("Cookie", cookie).expect(401);
  });

  it("uses generic login errors, rotates sessions, and persists accounts and businesses across reopening", async () => {
    const owner = await register();
    const first = await request(app).post("/api/businesses").set("Origin", origin).set("Cookie", owner.cookie).send(profile).expect(201);
    const wrong = await request(app).post("/api/auth/login").set("Origin", origin).send({ email: "owner@example.test", password: "wrong" }).expect(401);
    const absent = await request(app).post("/api/auth/login").set("Origin", origin).send({ email: "missing@example.test", password: "wrong" }).expect(401);
    expect(wrong.body).toEqual(absent.body);
    const login = await request(app).post("/api/auth/login").set("Origin", origin).set("Cookie", owner.cookie).send({ email: "owner@example.test", password }).expect(200);
    const cookie = String(login.headers["set-cookie"][0]).split(";")[0];
    expect(cookie).not.toBe(owner.cookie);
    await request(app).get("/api/auth/me").set("Cookie", owner.cookie).expect(401);
    await store.close();
    store = openStore(path);
    app = createApp({ store, origin });
    await request(app).get("/api/auth/me").set("Cookie", cookie).expect(200);
    const restored = await request(app).get(`/api/businesses/${first.body.business.id}`).set("Cookie", cookie).expect(200);
    expect(restored.body.business).toEqual(first.body.business);
    const history = await request(app).get(`/api/businesses/${first.body.business.id}/activity`).set("Cookie", cookie).expect(200);
    expect(history.body.activities).toHaveLength(1);
  });

  it("enforces owner isolation for profiles, edits, evidence, and activity and rejects owner spoofing", async () => {
    const alice = await register("alice@example.test");
    const bob = await register("bob@example.test");
    const created = await request(app).post("/api/businesses").set("Origin", origin).set("Cookie", alice.cookie).send(profile).expect(201);
    const id = created.body.business.id;
    const list = await request(app).get(`/api/businesses?ownerId=${alice.response.body.user.id}`).set("Cookie", bob.cookie).expect(200);
    expect(list.body.businesses).toEqual([]);
    for (const suffix of ["", "/activity", "/evidence"]) {
      await request(app).get(`/api/businesses/${id}${suffix}`).set("Cookie", bob.cookie).expect(404);
    }
    await request(app).put(`/api/businesses/${id}`).set("Origin", origin).set("Cookie", bob.cookie).send(profile).expect(404);
    await request(app).put(`/api/businesses/${id}`).set("Origin", origin).set("Cookie", alice.cookie).send({ ...profile, ownerId: bob.response.body.user.id }).expect(400);
    await request(app).put(`/api/businesses/${id}`).set("Origin", origin).set("Cookie", alice.cookie).send({ ...profile, website: "javascript:alert(1)" }).expect(400);
    await request(app).post("/api/businesses").set("Origin", origin).set("Cookie", alice.cookie).send({ ...profile, name: " " }).expect(400);
    await request(app).put(`/api/businesses/${id}`).set("Origin", origin).set("Cookie", alice.cookie).send({ ...profile, description: "Confirmed new description" }).expect(200);
    const history = await request(app).get(`/api/businesses/${id}/activity`).set("Cookie", alice.cookie).expect(200);
    const evidence = await request(app).get(`/api/businesses/${id}/evidence`).set("Cookie", alice.cookie).expect(200);
    expect(history.body.activities.map((item: { action: string }) => item.action)).toEqual(["business.updated", "business.created"]);
    expect(evidence.body.evidence).toHaveLength(2);
    expect(evidence.body.evidence[0]).toMatchObject({ businessId: id, source: "manual", reference: `businesses/${id}` });
    expect(history.body.activities[0].evidenceId).toBe(evidence.body.evidence[0].id);
  });

  it("blocks unauthenticated, forged, expired, missing-origin, and cross-origin access", async () => {
    await request(app).get("/api/businesses").expect(401);
    await request(app).post("/api/businesses").set("Origin", origin).send(profile).expect(401);
    const { cookie, response } = await register();
    await request(app).get("/api/auth/me").set("Cookie", `gp_session=${"f".repeat(64)}`).expect(401);
    const expired = newSession();
    await store.createSession(response.body.user.id, expired.tokenHash, Date.now() - 1);
    await request(app).get("/api/auth/me").set("Cookie", `gp_session=${expired.token}`).expect(401);
    await request(app).post("/api/businesses").set("Cookie", cookie).send(profile).expect(403);
    await request(app).post("/api/businesses").set("Origin", "https://other.example").set("Cookie", cookie).send(profile).expect(403);
    await request(app).post("/api/auth/logout").set("Origin", "https://other.example").set("Cookie", cookie).expect(403);
    const result = await request(app).get("/api/businesses").set("Cookie", cookie).expect(200);
    expect(result.body.businesses).toEqual([]);
  });

  it("rolls back the profile and evidence when recording activity fails", async () => {
    const { cookie } = await register();
    const database = new Database(path);
    database.exec("CREATE TRIGGER fail_activity BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT, 'Activity write failed'); END;");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await request(app).post("/api/businesses").set("Origin", origin).set("Cookie", cookie).send(profile).expect(500);
    expect(log).toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM businesses").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM evidence").get()).toEqual({ count: 0 });
    database.close();
  });

  it("limits repeated authentication attempts before expensive password work", async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await request(app).post("/api/auth/login").set("Origin", origin).send({}).expect(400);
    }
    await request(app).post("/api/auth/login").set("Origin", origin).send({}).expect(429);
  });

  it("sets Secure cookies when the app is configured for HTTPS production serving", async () => {
    writeFileSync(join(directory, "index.html"), "<html>Test</html>");
    app = createApp({ store, origin: "https://growth.example", production: true, clientDirectory: directory });
    const result = await request(app).post("/api/auth/register").set("Origin", "https://growth.example").send({ name: "Owner", email: "owner@example.test", password }).expect(201);
    expect(result.headers["set-cookie"][0]).toMatch(/; Secure;/);
  });

  it("records migrations once and refuses a database from a newer application", async () => {
    const reopened = openStore(path);
    await reopened.close();
    const database = new Database(path);
    expect(database.prepare("SELECT version FROM schema_migrations").all()).toEqual(migrations.map(({ version }) => ({ version })));
    database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(99);
    database.close();
    expect(() => openStore(path)).toThrow("Database schema is newer than this application");
  });

  it.each([6, 7, 9, 12])("upgrades database version %s without losing saved analyses, scans or preview references", async (version) => {
    const legacyPath = join(directory, "legacy.sqlite");
    const legacy = new Database(legacyPath);
    const ownerId = randomUUID(), businessId = randomUUID(), scanId = randomUUID(), understandingId = randomUUID(), oldJobId = randomUUID();
    const website = "https://shop.example.com/";
    const now = new Date().toISOString();
    const scan = {
      requestedUrl: website, status: "complete", startedAt: now, completedAt: now,
      pages: [{ url: website, capturedAt: now, title: "Legacy shop", description: "", text: "Public fixture",
        headings: [], contacts: [], callsToAction: [], links: [], warnings: [] }], failures: [], notes: [],
    };
    const expanded = { ...scan, pages: Array.from({ length: 20 }, (_, index) => ({ ...scan.pages[0], url: `${website}products/item-${index}` })) };
    try {
      legacy.pragma("foreign_keys = ON");
      legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
      for (const migration of migrations.filter((migration) => migration.version <= version)) {
        legacy.exec(migration.sql);
        legacy.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
      }
      legacy.prepare("INSERT INTO users VALUES (?, ?, ?, ?)").run(ownerId, "Legacy owner", "legacy@example.test", "test-only fixture hash");
      legacy.prepare("INSERT INTO businesses VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(businessId, ownerId, "Legacy shop", "", "", website, now, now);
      legacy.prepare("INSERT INTO website_scans VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(scanId, businessId, website, scan.status, now, now, 1, JSON.stringify(scan));
      legacy.prepare("INSERT INTO onboarding_previews VALUES (?, ?, ?, ?, ?, ?)").run("claimed-preview", JSON.stringify(scan), Date.now() + 60_000, ownerId, businessId, scanId);
      legacy.prepare("INSERT INTO onboarding_previews VALUES (?, ?, ?, NULL, NULL, NULL)").run("pending-preview", JSON.stringify(expanded), Date.now() + 60_000);
      legacy.prepare("INSERT INTO business_understandings (id, business_id, created_at, result_json) VALUES (?, ?, ?, ?)").run(understandingId, businessId, now, JSON.stringify({
        id: understandingId, businessId, scanId, createdAt: now,
        briefing: null, suggestions: [], scanStatus: "complete", reviewedAt: null, warnings: [], productImportId: null,
      }));
      if (version === 9) legacy.prepare(`INSERT INTO analysis_jobs
        (id, owner_id, business_id, requested_url, request_key, scan_id, status, phase, created_at, updated_at, research_enabled)
        VALUES (?, ?, ?, ?, ?, ?, 'failed', 'connecting', ?, ?, 1)`)
        .run(oldJobId, ownerId, businessId, website, randomUUID(), scanId, now, now);
    } finally { legacy.close(); }
    const upgraded = openStore(legacyPath);
    try {
      const claimed = await upgraded.claimPreview(ownerId, "claimed-preview");
      expect(claimed.scan.id).toBe(scanId);
      expect(claimed.scan.pages).toEqual(scan.pages);
      expect((await upgraded.getPreview("pending-preview"))?.scan.pages).toHaveLength(20);
      expect((await upgraded.claimPreview(ownerId, "pending-preview")).scan.pages).toHaveLength(20);
      expect(await upgraded.listScans(ownerId, businessId)).toHaveLength(2);
      expect((await upgraded.getBusiness(ownerId, businessId))?.name).toBe("Legacy shop");
      expect(await upgraded.latestUnderstanding(ownerId, businessId)).toMatchObject({ scanId, scanStatus: "complete", briefing: null });
      expect(await upgraded.salesData(ownerId, businessId)).toMatchObject({ days: [], scenarios: [], traffic: null });
      if (version === 9) expect(await upgraded.getAnalysisJob(ownerId, businessId, oldJobId)).toMatchObject({ researchEnabled: true, researchVersion: 1 });
      const job = await upgraded.enqueueAnalysis(ownerId, businessId, randomUUID(), website, scanId);
      expect(await upgraded.latestAnalysisJob(ownerId, businessId)).toMatchObject({ id: job.id, status: "queued", scanId, researchVersion: 2 });
      const database = new Database(legacyPath);
      try { expect(database.pragma("foreign_key_check")).toEqual([]); }
      finally { database.close(); }
    } finally { await upgraded.close(); }
  });

  it("does not report healthy when the database check fails", async () => {
    vi.spyOn(store, "checkHealth").mockImplementation(() => { throw new Error("Database unavailable"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await request(app).get("/api/health").expect(500);
    expect(result.body).toEqual({ error: "An unexpected server error occurred" });
    expect(log).toHaveBeenCalled();
  });
});
