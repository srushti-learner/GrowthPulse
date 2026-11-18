import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { openStore, type Store } from "./database.js";
import { migrations } from "./migrations.js";
import type { ScanResult } from "../shared/website.js";

const origin = "http://127.0.0.1:5173";
const input = { url: "https://shop.example.com/", permission: true };
const capturedAt = "2026-11-16T12:00:00.000Z";
const complete: ScanResult = {
  requestedUrl: input.url, status: "complete", startedAt: capturedAt, completedAt: capturedAt,
  pages: [{
    url: input.url, capturedAt, title: "Synthetic shop", description: "Test-only evidence",
    headings: [{ level: 1, text: "Our fixture business" }], text: "Public fixture content.",
    contacts: [], callsToAction: [], links: [], warnings: [],
  }], failures: [], notes: ["Isolated test transport; no real website was contacted."],
};

describe("scan API, persistence and ownership", () => {
  let directory: string;
  let path: string;
  let store: Store;
  let app: ReturnType<typeof createApp>;
  const scanner = vi.fn(async (_url: string, _signal?: AbortSignal) => structuredClone(complete));
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "growthpulse-scans-"));
    path = join(directory, "test.sqlite");
    store = openStore(path);
    scanner.mockReset().mockImplementation(async () => structuredClone(complete));
    app = createApp({ store, origin, scanner });
  });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });
  async function owner(email = "owner@example.test") {
    const account = await request(app).post("/api/auth/register").set("Origin", origin).send({ name: "Fixture Owner", email, password: "a test-only long passphrase" }).expect(201);
    const cookie = String(account.headers["set-cookie"][0]).split(";")[0];
    const business = await request(app).post("/api/businesses").set("Origin", origin).set("Cookie", cookie)
      .send({ name: "Fixture business", category: "", description: "", website: input.url }).expect(201);
    return { cookie, id: business.body.business.id as string, userId: account.body.user.id as string };
  }

  it("allows explicit account-free previews without saving private records", async () => {
    const user = await owner();
    const response = await request(app).post("/api/website/scan").set("Origin", origin).send(input).expect(200).expect("Cache-Control", "no-store");
    expect(response.body.scan).toEqual(complete);
    expect(response.body.scan.id).toBeUndefined();
    expect(scanner).toHaveBeenCalledWith(input.url, expect.any(AbortSignal));
    expect(store.listScans(user.userId, user.id)).toEqual([]);
    expect(store.listEvidence(user.userId, user.id)).toHaveLength(1);
  });

  it("persists immutable scan results, page evidence and activity across reopening", async () => {
    const user = await owner();
    const saved = await request(app).post(`/api/businesses/${user.id}/scans`).set("Origin", origin).set("Cookie", user.cookie).send(input).expect(201);
    const id = saved.body.scan.id;
    expect(saved.body.scan).toEqual({ ...complete, id, businessId: user.id });
    const evidence = store.listEvidence(user.userId, user.id).find((item) => item.source === "website")!;
    expect(evidence).toMatchObject({ reference: input.url, capturedAt });
    expect(evidence.summary).toContain(complete.pages[0].text);
    expect(store.listActivity(user.userId, user.id).find((item) => item.action === "website.scanned")?.evidenceId).toBe(evidence.id);
    store.close();
    store = openStore(path);
    app = createApp({ store, origin, scanner });
    const history = await request(app).get(`/api/businesses/${user.id}/scans`).set("Cookie", user.cookie).expect(200);
    expect(history.body.scans[0]).toMatchObject({ id, pageCount: 1, status: "complete" });
    expect(history.body.scans[0].pages).toBeUndefined();
    const restored = await request(app).get(`/api/businesses/${user.id}/scans/${id}`).set("Cookie", user.cookie).expect(200);
    expect(restored.body).toEqual(saved.body);
    scanner.mockResolvedValueOnce({ ...complete, pages: [{ ...complete.pages[0], title: "Updated observed title" }] });
    await request(app).post(`/api/businesses/${user.id}/scans`).set("Origin", origin).set("Cookie", user.cookie).send(input).expect(201);
    expect(store.listScans(user.userId, user.id)).toHaveLength(2);
    expect(store.getScan(user.userId, user.id, id)?.pages[0].title).toBe("Synthetic shop");
    expect(store.getBusiness(user.userId, user.id)?.name).toBe("Fixture business");
  });

  it("checks authentication and ownership before scanning or returning another business's results", async () => {
    const alice = await owner();
    const bob = await owner("bob@example.test");
    const saved = store.saveScan(alice.userId, alice.id, complete)!;
    for (const suffix of ["", `/${saved.id}`]) {
      await request(app).get(`/api/businesses/${alice.id}/scans${suffix}`).set("Cookie", bob.cookie).expect(404);
      await request(app).get(`/api/businesses/${alice.id}/scans${suffix}`).expect(401);
    }
    await request(app).get(`/api/businesses/${bob.id}/scans/${saved.id}`).set("Cookie", bob.cookie).expect(404);
    await request(app).post(`/api/businesses/${alice.id}/scans`).set("Origin", origin).set("Cookie", bob.cookie).send(input).expect(404);
    await request(app).post(`/api/businesses/${alice.id}/scans`).set("Origin", origin).send(input).expect(401);
    expect(store.saveScan(bob.userId, alice.id, complete)).toBeUndefined();
    expect(scanner).not.toHaveBeenCalled();
  });

  it("requires permission and origin and rejects unsafe inputs and browser-supplied ownership", async () => {
    await request(app).post("/api/website/scan").send(input).expect(403);
    await request(app).post("/api/website/scan").set("Origin", "https://other.example.com").send(input).expect(403);
    await request(app).post("/api/website/scan").set("Origin", origin).send({ url: input.url }).expect(400);
    await request(app).post("/api/website/scan").set("Origin", origin).send({ ...input, ownerId: randomUUID() }).expect(400);
    const rejected = await request(app).post("/api/website/scan").set("Origin", origin).send({ ...input, url: "http://127.0.0.1/" }).expect(400);
    expect(rejected.body.error).toContain("Private");
    expect(scanner).not.toHaveBeenCalled();
  });

  it("records failures honestly rather than fabricating website evidence", async () => {
    const user = await owner();
    scanner.mockResolvedValueOnce({ ...complete, status: "failed", pages: [], failures: [{ url: input.url, message: "robots.txt does not allow this page." }] });
    const response = await request(app).post(`/api/businesses/${user.id}/scans`).set("Origin", origin).set("Cookie", user.cookie).send(input).expect(201);
    expect(response.body.scan.status).toBe("failed");
    expect(response.body.scan.pages).toEqual([]);
    const evidence = store.listEvidence(user.userId, user.id).find((item) => item.source === "website")!;
    expect(evidence.summary).toContain("No website content captured");
    expect(evidence.summary).toContain("robots.txt");
  });

  it("rolls back scan and page evidence if activity recording fails", async () => {
    const user = await owner();
    const database = new Database(path);
    try {
      database.exec("CREATE TRIGGER fail_scan_activity BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT, 'Activity write failed'); END;");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      await request(app).post(`/api/businesses/${user.id}/scans`).set("Origin", origin).set("Cookie", user.cookie).send(input).expect(500);
      expect(log).toHaveBeenCalled();
      expect(store.listScans(user.userId, user.id)).toEqual([]);
      expect(store.listEvidence(user.userId, user.id)).toHaveLength(1);
    } finally { database.close(); }
  });

  it("bounds concurrency and separates anonymous scans from each account's fresh scan allowance", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    scanner.mockImplementation(async () => { await wait; return structuredClone(complete); });
    const first = request(app).post("/api/website/scan").set("Origin", origin).send(input).then((response) => response);
    const second = request(app).post("/api/website/scan").set("Origin", origin).send(input).then((response) => response);
    try {
      await vi.waitFor(() => expect(scanner).toHaveBeenCalledTimes(2));
      const busy = await request(app).post("/api/website/scan").set("Origin", origin).send(input).expect(429);
      expect(busy.body.error).toContain("Two scans");
    } finally { release(); await Promise.all([first, second]); }
    const user = await owner();
    for (let index = 0; index < 3; index++) {
      await request(app).post(`/api/businesses/${user.id}/scans`).set("Origin", origin).set("Cookie", user.cookie).send(input).expect(201);
    }
    const limited = await request(app).post(`/api/businesses/${user.id}/scans`).set("Origin", origin).set("Cookie", user.cookie).send(input).expect(429);
    expect(limited.body.error).toContain("Fresh website scan");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    const other = await owner("other@example.test");
    await request(app).post(`/api/businesses/${other.id}/scans`).set("Origin", origin).set("Cookie", other.cookie).send(input).expect(201);
    await request(app).get(`/api/businesses/${user.id}/scans`).set("Cookie", user.cookie).expect(200);
    expect(scanner).toHaveBeenCalledTimes(6);
  });

  it("upgrades the existing v1 schema without losing profiles, evidence or activity", () => {
    const legacyPath = join(directory, "legacy.sqlite");
    const database = new Database(legacyPath);
    const userId = randomUUID(), businessId = randomUUID(), evidenceId = randomUUID(), activityId = randomUUID();
    database.exec(migrations[0].sql);
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (1)");
    database.prepare("INSERT INTO users VALUES (?, 'Legacy owner', 'legacy@example.test', 'unused-test-hash')").run(userId);
    database.prepare("INSERT INTO businesses VALUES (?, ?, 'Legacy business', '', '', '', ?, ?)").run(businessId, userId, capturedAt, capturedAt);
    database.prepare("INSERT INTO evidence VALUES (?, ?, 'manual', 'legacy-profile', 'Owner-entered information', ?)").run(evidenceId, businessId, capturedAt);
    database.prepare("INSERT INTO activities VALUES (?, ?, ?, 'business.created', ?)").run(activityId, businessId, evidenceId, capturedAt);
    database.close();
    const upgraded = openStore(legacyPath);
    try {
      expect(upgraded.getBusiness(userId, businessId)?.name).toBe("Legacy business");
      expect(upgraded.listActivity(userId, businessId)[0].id).toBe(activityId);
      expect(upgraded.listEvidence(userId, businessId)[0].id).toBe(evidenceId);
      expect(upgraded.saveScan(userId, businessId, complete)?.pages).toEqual(complete.pages);
      expect(upgraded.listActivity(userId, businessId)).toHaveLength(2);
    } finally { upgraded.close(); }
  });
});
