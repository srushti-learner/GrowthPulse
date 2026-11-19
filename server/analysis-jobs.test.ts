import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import request from "supertest";
import { openStore, type Store } from "./database.js";
import { createApp } from "./app.js";
import { newSession } from "./auth.js";
import { createAnalysisWorker } from "./analysis-worker.js";
import { createBusinessAgent, type AgentMessage, type AgentModel } from "./business-agent.js";
import { analysisJobEventSchema, analysisLimits } from "../shared/analysis.js";
import type { ScanResult } from "../shared/website.js";
import { claimWorkSlot } from "./work-slots.js";
import { buildAgentEvidence } from "./agent-evidence.js";

const origin = "http://127.0.0.1:5173";
const url = "https://shop.example.com/";
const timestamp = "2026-11-16T12:00:00.000Z";
const quote = "We make cotton clothing for everyday wear.";
const scan: ScanResult = {
  requestedUrl: url, status: "complete", startedAt: timestamp, completedAt: timestamp,
  pages: [{ url, capturedAt: timestamp, title: "Fixture shop", description: quote, text: quote,
    headings: [], contacts: [], callsToAction: [], links: [], warnings: [],
    productJson: [JSON.stringify({ "@type": "Product", name: "Fixture tee", sku: "TEE-1" })] }],
  failures: [], notes: [],
};
const proposal = {
  briefing: {
    summary: { text: "The website presents everyday cotton clothing.", sources: [{ url, quote }] },
    insights: [{ area: "offering", text: "Cotton is a stated product focus.", whyItMatters: "Fabric helps shoppers assess the range.", sources: [{ url, quote }] }],
    unknowns: [{ question: "What does delivery cost?", whyItMatters: "The full purchase cost is unknown." }],
    nextSteps: [{ action: "Review delivery terms.", reason: "Confirm the total cost before assessing the offer." }],
  },
  suggestions: [{ field: "description", value: quote, sources: [{ url, quote }] }],
};
const sourceIds = [buildAgentEvidence(scan).payload.pages[0].excerpts.find((excerpt) => excerpt.quote === quote)!.id];
const referencedProposal = {
  briefing: {
    ...proposal.briefing,
    summary: { ...proposal.briefing.summary, sources: sourceIds },
    insights: proposal.briefing.insights.map((insight) => ({ ...insight, sources: sourceIds })),
  },
  suggestions: proposal.suggestions.map((suggestion) => ({ ...suggestion, sources: sourceIds })),
};
function tool(name: string, input: unknown): AgentMessage {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `tool_${name}`, name, input }] };
}
const scanner = vi.fn(async () => structuredClone(scan));

describe("durable local analysis jobs", () => {
  let directory: string, path: string, store: Store, database: Database.Database;
  let complete: ReturnType<typeof vi.fn<AgentModel>>, agent: ReturnType<typeof createBusinessAgent>;
  let worker: ReturnType<typeof createAnalysisWorker>, app: ReturnType<typeof createApp>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "gp-analysis-")); path = join(directory, "test.sqlite");
    store = openStore(path); database = new Database(path);
    scanner.mockClear();
    complete = vi.fn<AgentModel>().mockImplementation(async (input) =>
      input.tool_choice?.type === "tool" && input.tool_choice.name === "scan_website" ? tool("scan_website", {}) : tool("propose_business", referencedProposal));
    agent = createBusinessAgent({ complete });
    worker = createAnalysisWorker({ store, agent, scanner });
    app = createApp({ store, agent, scanner });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    await worker.stop(); database.close(); await store.close();
    rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks();
  });
  async function owner() {
    const user = { id: randomUUID(), name: "Fixture owner", email: `${randomUUID()}@example.test` };
    const session = newSession();
    await store.createAccount(user, "test-only fixture hash", session.tokenHash, session.expiresAt);
    const business = (await store.saveBusiness(user.id, { name: "Fixture shop", website: url, category: "", description: "Owner description" }))!;
    return { id: user.id, business, cookie: `gp_session=${session.token}` };
  }
  async function enqueue(user: Awaited<ReturnType<typeof owner>>, scanId?: string, key = randomUUID()) {
    return await store.enqueueAnalysis(user.id, user.business.id, key, url, scanId);
  }
  function start(user: Awaited<ReturnType<typeof owner>>, key = randomUUID(), input: object = { permission: true }) {
    return request(app).post(`/api/businesses/${user.business.id}/understanding`).set("Origin", origin).set("Cookie", user.cookie)
      .set("Prefer", "respond-async").set("Idempotency-Key", key).send(input);
  }
  async function job(user: Awaited<ReturnType<typeof owner>>, id: string) { return (await store.getAnalysisJob(user.id, user.business.id, id))!; }
  function holdBriefing() {
    let release!: () => void;
    let signal!: AbortSignal;
    complete.mockImplementation(async (input, current, onInput) => {
      if (input.tool_choice?.type === "tool" && input.tool_choice.name === "scan_website") return tool("scan_website", {});
      signal = current;
      onInput?.({ briefing: { summary: { text: "Provisional cotton clothing analysis" } } });
      await new Promise<void>((resolve, reject) => {
        release = resolve; current.addEventListener("abort", () => reject(current.reason), { once: true });
      });
      return tool("propose_business", referencedProposal);
    });
    return { release: () => release(), signal: () => signal };
  }

  it("persists disclosed review-reuse permission and fences request keys and active-job aliases by that permission", async () => {
    const user = await owner(), key = randomUUID();
    const input = { permission: true, research: true, researchVersion: 2, reuseCustomerEvidence: true };
    const accepted = await start(user, key, input).expect(202);
    const first = analysisJobEventSchema.parse(JSON.parse(accepted.text)).job;
    expect(first.reuseCustomerEvidence).toBe(true);
    expect(JSON.parse((await start(user, randomUUID(), input).expect(202)).text).job.id).toBe(first.id);
    await start(user, key, { ...input, reuseCustomerEvidence: false }).expect(409);
    await start(user, randomUUID(), { ...input, reuseCustomerEvidence: false }).expect(409);
    await start(user, randomUUID(), { ...input, research: false }).expect(400);
    await worker.stop(); await store.close(); store = openStore(path);
    expect((await store.latestAnalysisJob(user.id, user.business.id))?.reuseCustomerEvidence).toBe(true);
    expect((await store.claimAnalysis())?.reuseCustomerEvidence).toBe(true);
    expect(complete).not.toHaveBeenCalled(); expect(scanner).not.toHaveBeenCalled();
  });

  it("accepts immediately, survives reopening, then saves the worker result with website products already available", async () => {
    const user = await owner(), key = randomUUID();
    const accepted = await start(user, key).expect(202);
    const first = analysisJobEventSchema.parse(JSON.parse(accepted.text)).job;
    expect(first).toMatchObject({ status: "queued", scanId: null, preview: null, understanding: null });
    expect(complete).not.toHaveBeenCalled(); expect(scanner).not.toHaveBeenCalled();
    await worker.stop(); await store.close(); store = openStore(path);
    expect(await store.latestAnalysisJob(user.id, user.business.id)).toEqual(first);
    worker = createAnalysisWorker({ store, agent, scanner }); app = createApp({ store, agent, scanner });
    await worker.tick();
    const saved = await job(user, first.id);
    expect(saved).toMatchObject({ status: "completed", preview: null, error: null, understanding: { briefing: proposal.briefing, reviewedAt: null } });
    expect(saved.scanId).toBe(saved.understanding!.scanId);
    expect(saved.understanding!.productImportId).toBeNull();
    expect(saved.understanding!.catalogue).toMatchObject({ created: 1, skipped: 0 });
    expect(await store.getBusiness(user.id, user.business.id)).toEqual(user.business);
    expect(await store.listProducts(user.id, user.business.id)).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(2); expect(scanner).toHaveBeenCalledOnce();
    const repeated = await start(user, key).expect(202);
    expect(JSON.parse(repeated.text).job).toEqual(saved);
    await worker.tick(); expect(complete).toHaveBeenCalledTimes(2);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("binds request keys to exact input, reconnects identical active work and rejects different active input", async () => {
    const user = await owner(), key = randomUUID(), first = await enqueue(user, undefined, key);
    expect((await enqueue(user, undefined, key)).id).toBe(first.id);
    const alias = randomUUID();
    expect((await enqueue(user, undefined, alias)).id).toBe(first.id);
    await expect(store.enqueueAnalysis(user.id, user.business.id, randomUUID(), url, undefined, true)).rejects.toThrow("already queued or running");
    await expect(store.enqueueAnalysis(user.id, user.business.id, key, "https://other.example.com/")).rejects.toThrow("different analysis");
    const saved = (await store.saveScan(user.id, user.business.id, scan))!;
    await expect(enqueue(user, saved.id, key)).rejects.toThrow("different analysis");
    await store.cancelAnalysis(user.id, user.business.id, first.id);
    expect((await enqueue(user, undefined, key)).status).toBe("cancelled");
    expect((await enqueue(user, undefined, alias)).status).toBe("cancelled");
    await expect(store.enqueueAnalysis(user.id, user.business.id, alias, url, undefined, true)).rejects.toThrow("different analysis");
    expect((await enqueue(user)).id).not.toBe(first.id);
  });

  it("enforces owner-scoped scans, status, streaming, cancellation and consent", async () => {
    const alice = await owner(), bob = await owner(), first = await enqueue(alice);
    const saved = (await store.saveScan(alice.id, alice.business.id, scan))!;
    await expect(enqueue(bob, saved.id)).rejects.toThrow("Matching saved");
    const suffix = `/analysis-jobs/${first.id}`;
    for (const tail of [suffix, `${suffix}/events`]) {
      await request(app).get(`/api/businesses/${alice.business.id}${tail}`).expect(401);
      await request(app).get(`/api/businesses/${bob.business.id}${tail}`).set("Cookie", bob.cookie).expect(404);
    }
    await request(app).post(`/api/businesses/${alice.business.id}${suffix}/cancel`).set("Cookie", alice.cookie).send({}).expect(403);
    await request(app).post(`/api/businesses/${bob.business.id}${suffix}/cancel`).set("Origin", origin).set("Cookie", bob.cookie).send({}).expect(404);
    await start(bob, randomUUID(), { permission: false }).expect(400);
    await start(bob, randomUUID(), { permission: true, scanId: saved.id }).expect(404);
    const stopped = await request(app).post(`/api/businesses/${alice.business.id}${suffix}/cancel`).set("Origin", origin).set("Cookie", alice.cookie).send({}).expect(200);
    expect(stopped.body.job.status).toBe("cancelled");
    const events = await request(app).get(`/api/businesses/${alice.business.id}${suffix}/events`).set("Cookie", alice.cookie).expect(200);
    expect(analysisJobEventSchema.parse(JSON.parse(events.text)).job.status).toBe("cancelled");
    await worker.tick(); expect(complete).not.toHaveBeenCalled();
  });

  it("returns an existing request before rate limiting, but rate-limits genuinely new paid work", async () => {
    const user = await owner(), key = randomUUID();
    const first = await start(user, key).expect(202);
    for (let index = 0; index < 4; index++) await start(user, key).expect(202);
    const duplicate = await start(user).expect(202);
    expect(JSON.parse(duplicate.text).job.id).toBe(JSON.parse(first.text).job.id);
    await store.cancelAnalysis(user.id, user.business.id, JSON.parse(first.text).job.id);
    for (let index = 0; index < 2; index++) {
      const next = await start(user).expect(202);
      await store.cancelAnalysis(user.id, user.business.id, JSON.parse(next.text).job.id);
    }
    await start(user).expect(429);
    await start(user, key).expect(202);
    const scansBlocked = await request(app).post(`/api/businesses/${user.business.id}/scans`).set("Origin", origin).set("Cookie", user.cookie)
      .send({ permission: true, url }).expect(429);
    expect(scansBlocked.body.error).toContain("Fresh website scan");
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps all fresh scans available after saved-evidence analyses exhaust only the paid-work allowance", async () => {
    const user = await owner();
    await store.saveScan(user.id, user.business.id, scan);
    for (let index = 0; index < 3; index++) { await start(user).expect(202); await worker.tick(); }
    await start(user).expect(429);
    expect(scanner).not.toHaveBeenCalled();
    for (let index = 0; index < 3; index++) {
      await request(app).post(`/api/businesses/${user.business.id}/scans`).set("Origin", origin).set("Cookie", user.cookie)
        .send({ permission: true, url }).expect(201);
    }
    expect(scanner).toHaveBeenCalledTimes(3);
  });

  it("does not drain authenticated allowances for invalid or foreign admission requests", async () => {
    const user = await owner(), other = await owner(), foreign = (await store.saveScan(other.id, other.business.id, scan))!;
    for (let index = 0; index < 4; index++) {
      await start(user, randomUUID(), { permission: false }).expect(400);
      await start(user, randomUUID(), { permission: true, scanId: foreign.id }).expect(404);
      await request(app).post(`/api/businesses/${user.business.id}/scans`).set("Origin", origin).set("Cookie", user.cookie)
        .send({ permission: true, url: "http://127.0.0.1" }).expect(400);
    }
    for (let index = 0; index < 3; index++) {
      const accepted = await start(user).expect(202);
      await store.cancelAnalysis(user.id, user.business.id, JSON.parse(accepted.text).job.id);
    }
    expect(scanner).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });

  it("reuses usable matching saved evidence without spending fresh scan allowance, while keeping paid work account-scoped", async () => {
    const alice = await owner(), bob = await owner();
    for (let index = 0; index < 3; index++) {
      await request(app).post(`/api/businesses/${alice.business.id}/scans`).set("Origin", origin).set("Cookie", alice.cookie)
        .send({ permission: true, url }).expect(201);
    }
    const saved = (await store.reusableScan(alice.id, alice.business.id, url))!;
    await request(app).post(`/api/businesses/${alice.business.id}/scans`).set("Origin", origin).set("Cookie", alice.cookie)
      .send({ permission: true, url }).expect(429);
    for (let index = 0; index < 3; index++) {
      const accepted = await start(alice).expect(202);
      expect(JSON.parse(accepted.text).job.scanId).toBe(saved.id);
      await worker.tick();
    }
    expect(scanner).toHaveBeenCalledTimes(3);
    const blocked = await start(alice).expect(429);
    expect(blocked.body.error).toContain("New AI analysis");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    for (let index = 0; index < 5; index++) {
      await request(app).get(`/api/businesses/${alice.business.id}/understanding`).set("Cookie", alice.cookie).expect(200);
      await request(app).get(`/api/businesses/${alice.business.id}/growth`).set("Cookie", alice.cookie).expect(200);
    }
    await start(bob).expect(202);
    const secondBusiness = (await store.saveBusiness(alice.id, { name: "Another shop", website: "https://other.example.com", category: "", description: "" }))!;
    await start({ ...alice, business: secondBusiness }).expect(429);
  });

  it("deduplicates concurrent starts with distinct keys and preserves aliases after completion and reopening", async () => {
    const user = await owner(), keys = [randomUUID(), randomUUID()];
    const accepted = await Promise.all(keys.map((key) => start(user, key).expect(202)));
    const ids = accepted.map((response) => JSON.parse(response.text).job.id);
    expect(new Set(ids).size).toBe(1);
    await worker.tick();
    expect(scanner).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 2; index++) {
      const accepted = await start(user).expect(202);
      await store.cancelAnalysis(user.id, user.business.id, JSON.parse(accepted.text).job.id);
    }
    await start(user).expect(429);
    await store.close(); store = openStore(path); app = createApp({ store, agent, scanner });
    for (const key of keys) {
      const repeated = await start(user, key).expect(202);
      expect(JSON.parse(repeated.text).job).toMatchObject({ id: ids[0], status: "completed" });
    }
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("ignores unusable and different-website scans when resolving reusable evidence", async () => {
    const user = await owner(), other = await owner();
    await store.saveScan(other.id, other.business.id, scan);
    await store.saveScan(user.id, user.business.id, { ...scan, requestedUrl: "https://other.example.com/" });
    await store.saveScan(user.id, user.business.id, { ...scan, status: "failed", pages: [] });
    const accepted = await start(user).expect(202);
    expect(JSON.parse(accepted.text).job.scanId).toBeNull();
    await worker.tick();
    expect(scanner).toHaveBeenCalledOnce();
  });

  it("allows only one running job across database connections and fences an expired lease", async () => {
    const alice = await owner(), bob = await owner(), first = await enqueue(alice), second = await enqueue(bob);
    const other = openStore(path);
    try {
      const claimed = (await store.claimAnalysis())!;
      expect(claimed.id).toBe(first.id); expect(await other.claimAnalysis()).toBeNull();
      expect(await store.updateAnalysis(first.id, claimed.lease, { type: "briefing", briefing: { summary: { text: "Unverified draft" } } })).toBe(true);
      database.prepare("UPDATE analysis_jobs SET lease_until = ? WHERE id = ?").run(Date.now() - 1, first.id);
      expect((await other.claimAnalysis())?.id).toBe(second.id);
      expect(await job(alice, first.id)).toMatchObject({ status: "interrupted", preview: null });
      expect(await store.renewAnalysisLease(first.id, claimed.lease)).toBe(false);
      expect(await store.updateAnalysis(first.id, claimed.lease, { type: "phase", phase: "validating" })).toBe(false);
      const save = vi.fn();
      expect(await store.completeAnalysis(first.id, claimed.lease, save)).toBe(false);
      await expect(store.checkpointAnalysisScan(first.id, claimed.lease, save)).rejects.toThrow("no longer running");
      expect(save).not.toHaveBeenCalled();
      expect(await other.claimAnalysis()).toBeNull();
    } finally { await other.close(); }
  });

  it("expires old queued work and never automatically reruns an interrupted provider call", async () => {
    const user = await owner(), first = await enqueue(user);
    database.prepare("UPDATE analysis_jobs SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - analysisLimits.queueLifetimeMs - 1).toISOString(), first.id);
    await worker.tick();
    expect((await job(user, first.id)).status).toBe("failed");
    const next = await enqueue(user); await store.claimAnalysis();
    database.prepare("UPDATE analysis_jobs SET lease_until = ? WHERE id = ?").run(Date.now() - 1, next.id);
    await worker.tick(); await worker.tick();
    expect((await job(user, next.id)).status).toBe("interrupted");
    expect(complete).not.toHaveBeenCalled();
  });

  it("caps the number of waiting jobs", async () => {
    const user = await owner();
    for (let index = 0; index < analysisLimits.queued; index++) {
      const business = (await store.saveBusiness(user.id, { ...user.business, name: `Queued shop ${index}` }))!;
      await store.enqueueAnalysis(user.id, business.id, randomUUID(), url);
    }
    await expect(enqueue(user)).rejects.toThrow("queue is full");
  });

  it("waits without claiming while both foreground operation slots are occupied", async () => {
    const user = await owner(), first = await enqueue(user);
    const releases = [claimWorkSlot()!, claimWorkSlot()!];
    try {
      await worker.tick();
      expect((await job(user, first.id)).status).toBe("queued");
      expect(complete).not.toHaveBeenCalled();
    } finally { for (const release of releases) release(); }
    await worker.tick(); expect((await job(user, first.id)).status).toBe("completed");
  });

  it("stores progress before completion, survives viewer disconnects, and reconnects to the same result", async () => {
    const user = await owner(), first = await enqueue(user), held = holdBriefing();
    const running = worker.tick();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(await job(user, first.id)).toMatchObject({ status: "running", preview: { summary: { text: "Provisional cotton clothing analysis" } } });
    const server = app.listen(0, "127.0.0.1");
    try {
      if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      const endpoint = `http://127.0.0.1:${address.port}/api/businesses/${user.business.id}/analysis-jobs/${first.id}/events`;
      const response = await fetch(endpoint, { headers: { Cookie: user.cookie } });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("Provisional cotton clothing analysis");
      await reader.cancel();
      expect(held.signal().aborted).toBe(false);
      expect((await job(user, first.id)).status).toBe("running");
      held.release(); await running;
      const restored = await fetch(endpoint, { headers: { Cookie: user.cookie } });
      expect(analysisJobEventSchema.parse(JSON.parse(await restored.text())).job).toMatchObject({ status: "completed", understanding: { briefing: proposal.briefing } });
      expect(complete).toHaveBeenCalledTimes(2); expect(scanner).toHaveBeenCalledOnce();
    } finally {
      held.release(); await running;
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
  });

  it("aborts explicitly cancelled work and prevents a late commit, preserving its scan checkpoint", async () => {
    const user = await owner(), first = await enqueue(user), held = holdBriefing(), running = worker.tick();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    const scanId = (await job(user, first.id)).scanId;
    expect(scanId).not.toBeNull();
    await store.cancelAnalysis(user.id, user.business.id, first.id);
    await running;
    expect(held.signal().aborted).toBe(true);
    expect(await job(user, first.id)).toMatchObject({ status: "cancelled", preview: null, scanId, understanding: null });
    expect(await store.latestUnderstanding(user.id, user.business.id)).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM product_imports").get()).toEqual({ count: 0 });
    expect(await store.getScan(user.id, user.business.id, scanId!)).toBeDefined();
    await worker.tick(); expect(complete).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous saved briefing when output is invalid, then reuses checkpointed evidence only on explicit retry", async () => {
    const user = await owner(), first = await enqueue(user);
    await worker.tick();
    const previous = (await job(user, first.id)).understanding;
    const second = await enqueue(user);
    complete.mockResolvedValueOnce(tool("scan_website", {})).mockResolvedValueOnce(tool("propose_business", {
      ...referencedProposal, briefing: { ...referencedProposal.briefing,
        summary: { text: "Invented", sources: ["e_0000000000000000"] },
        insights: [{ ...referencedProposal.briefing.insights[0], sources: ["e_0000000000000000"] }],
      },
    }));
    await worker.tick(); await worker.tick();
    expect(await job(user, second.id)).toMatchObject({ status: "failed", understanding: null, preview: null });
    expect(await store.latestUnderstanding(user.id, user.business.id)).toEqual(previous);
    expect(scanner).toHaveBeenCalledTimes(2); expect(complete).toHaveBeenCalledTimes(4);
    const retry = await enqueue(user, (await job(user, second.id)).scanId!);
    await worker.tick();
    expect((await job(user, retry.id)).status).toBe("completed");
    expect(scanner).toHaveBeenCalledTimes(2); expect(complete).toHaveBeenCalledTimes(6);
  });

  it("rolls back optional imports and final results together when saving fails", async () => {
    const user = await owner(), first = await enqueue(user);
    vi.spyOn(store, "saveUnderstanding").mockImplementation(() => { throw new Error("Fixture database failure"); });
    await worker.tick();
    expect(await job(user, first.id)).toMatchObject({ status: "failed", understanding: null });
    expect(database.prepare("SELECT COUNT(*) AS count FROM product_imports").get()).toEqual({ count: 0 });
    expect(await store.latestUnderstanding(user.id, user.business.id)).toBeNull();
    expect(await store.listScans(user.id, user.business.id)).toHaveLength(1);
  });

  it("preserves the previous briefing after a blocked scan and does not offer the failed scan as a reusable checkpoint", async () => {
    const user = await owner(), first = await enqueue(user);
    await worker.tick();
    const previous = (await job(user, first.id)).understanding;
    scanner.mockResolvedValueOnce({ ...scan, status: "failed", pages: [], failures: [{ url, message: "Reading is disallowed by robots.txt." }] });
    const blocked = await enqueue(user);
    await worker.tick();
    expect(await job(user, blocked.id)).toMatchObject({ status: "failed", scanId: null, understanding: null, error: expect.stringContaining("No permitted public pages") });
    expect(await store.latestUnderstanding(user.id, user.business.id)).toEqual(previous);
    expect(await store.listScans(user.id, user.business.id)).toHaveLength(2);
    expect(complete).toHaveBeenCalledTimes(3);
    const retry = await enqueue(user);
    await worker.tick();
    expect((await job(user, retry.id)).status).toBe("completed"); expect(scanner).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("rejects a changed website before committing (changed during provider=%s)", async (during) => {
    const user = await owner(), first = await enqueue(user);
    const held = during ? holdBriefing() : null;
    const running = during ? worker.tick() : null;
    if (during) await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    await store.saveBusiness(user.id, { ...user.business, website: "https://other.example.com/" }, user.business.id);
    if (held) held.release();
    if (running) await running; else await worker.tick();
    expect(await job(user, first.id)).toMatchObject({ status: "failed", error: expect.stringContaining("website changed"), understanding: null });
    expect(await store.latestUnderstanding(user.id, user.business.id)).toBeNull();
    expect(complete).toHaveBeenCalledTimes(during ? 2 : 0);
  });

  it("marks graceful worker shutdown as interrupted without rerunning paid work on restart", async () => {
    const user = await owner(), first = await enqueue(user), held = holdBriefing();
    void worker.tick();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    await worker.stop();
    expect(held.signal().aborted).toBe(true);
    expect(await job(user, first.id)).toMatchObject({ status: "interrupted", understanding: null, scanId: expect.any(String) });
    worker = createAnalysisWorker({ store, agent, scanner });
    await worker.tick(); expect(complete).toHaveBeenCalledTimes(2);
  });

  it("rechecks the website inside the final transaction instead of trusting an earlier read", async () => {
    const user = await owner(), first = await enqueue(user), finish = store.completeAnalysis;
    vi.spyOn(store, "completeAnalysis").mockImplementation(async (id, lease, save) => {
      await store.saveBusiness(user.id, { ...user.business, website: "https://changed.example.com/" }, user.business.id);
      return finish(id, lease, save);
    });
    await worker.tick();
    expect(await job(user, first.id)).toMatchObject({ status: "failed", error: expect.stringContaining("website changed"), understanding: null });
    expect(await store.latestUnderstanding(user.id, user.business.id)).toBeNull();
  });
});
