import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { growthOpportunities } from "./growth-store.js";
import { openStore, type Store } from "./database.js";
import { createApp } from "./app.js";
import { newSession } from "./auth.js";
import { growthResponseSchema, growthPlanResponseSchema } from "../shared/growth.js";
import { researchAgents, type ResearchReport, type ResearchStep } from "../shared/research.js";
import type { ScanResult } from "../shared/website.js";

const origin = "http://127.0.0.1:5173";
const timestamp = "2026-11-17T12:00:00.000Z";
const url = "https://shop.example.com/";
const source = { id: "e_1111111111111111", url, quote: "Our cotton shirts are available in five sizes.", capturedAt: timestamp };
const step: ResearchStep = {
  key: "growth", agent: "growth", status: "completed", findings: [
    { kind: "suggestion", title: "Test clearer sizing guidance", detail: "Review size guidance with shoppers before changing product pages.", sources: [source] },
  ], limitations: [], diagnostic: null, startedAt: timestamp, completedAt: timestamp, reused: false,
};
const report: ResearchReport = { version: 1, status: "partial", enabled: true, steps: [step], usage: { modelCalls: 1, searches: 0, competitorScans: 0 } };
const scan: ScanResult = {
  requestedUrl: url, status: "complete", startedAt: timestamp, completedAt: timestamp,
  pages: [{ url, capturedAt: timestamp, title: "Fixture", description: source.quote, text: source.quote, links: [], headings: [], callsToAction: [], contacts: [], warnings: [], productJson: [] }],
  failures: [], notes: [],
};

describe("saved growth intelligence", () => {
  let directory: string, path: string, store: Store, app: ReturnType<typeof createApp>;
  const scanner = vi.fn(async () => structuredClone(scan));
  const agent = { configured: true, run: vi.fn(async () => { throw new Error("Growth browsing must not call a model."); }) };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "gp-growth-")); path = join(directory, "test.sqlite");
    store = openStore(path); app = createApp({ store, scanner, agent }); scanner.mockClear(); agent.run.mockClear();
  });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  function owner() {
    const user = { id: randomUUID(), name: "Fixture owner", email: `${randomUUID()}@example.test` }, session = newSession();
    store.createAccount(user, "test-only fixture hash", session.tokenHash, session.expiresAt);
    const business = store.saveBusiness(user.id, { name: "Fixture", website: url, category: "", description: "" })!;
    return { id: user.id, business, cookie: `gp_session=${session.token}`, endpoint: `/api/businesses/${business.id}/growth` };
  }
  function saveResearch(user: ReturnType<typeof owner>, research = report) {
    const savedScan = store.saveScan(user.id, user.business.id, scan)!;
    return store.saveUnderstanding(user.id, {
      id: randomUUID(), businessId: user.business.id, scanId: savedScan.id, scanStatus: "complete", reviewedAt: null, createdAt: timestamp,
      warnings: [], suggestions: [], productImportId: null, research,
      briefing: { summary: { text: source.quote, sources: [{ url, quote: source.quote }] }, insights: [], unknowns: [], nextSteps: [] },
    })!;
  }
  function get(user: ReturnType<typeof owner>) { return request(app).get(user.endpoint).set("Cookie", user.cookie); }
  function add(user: ReturnType<typeof owner>, id: string) {
    return request(app).post(`${user.endpoint}/${id}/plan`).set("Origin", origin).set("Cookie", user.cookie).send({});
  }
  function update(user: ReturnType<typeof owner>, id: string, input: object) {
    return request(app).patch(`${user.endpoint}/${id}/plan`).set("Origin", origin).set("Cookie", user.cookie).send(input);
  }

  it("combines all six specialists, deduplicates exact recommendations and never promotes hypotheses or failed drafts", () => {
    const value: ResearchReport = {
      ...report, steps: [
        ...researchAgents.map((agent) => ({ ...step, key: agent, agent })),
        { ...step, key: "failed", status: "failed", findings: [{ ...step.findings[0], title: "Rejected" }] },
        { ...step, key: "draft", status: "running", findings: [{ ...step.findings[0], title: "Unfinished" }] },
        { ...step, key: "hypothesis", findings: [{ ...step.findings[0], kind: "hypothesis", title: "Not an action" }] },
        { ...step, key: "observation", findings: [{ ...step.findings[0], kind: "observation", title: "Not an action either" }] },
      ],
    };
    const original = structuredClone(value);
    const items = growthOpportunities("business", value);
    expect(items).toHaveLength(1);
    expect(items[0].agents).toEqual([...researchAgents]);
    expect(items[0].sources).toEqual([source]);
    expect(items[0].reviewReason).toContain("not predicted business impact");
    expect(growthOpportunities("business", value)).toEqual(items);
    expect(growthOpportunities("different-business", value)[0].id).not.toBe(items[0].id);
    expect(value).toEqual(original);
  });

  it("opens source-backed strategies without paid work and persists owner assessments across reopening", async () => {
    const user = owner(); saveResearch(user);
    const saved = growthResponseSchema.parse((await get(user).expect(200)).body);
    expect(saved.opportunities).toHaveLength(1); expect(saved.plan).toEqual([]);
    const opportunity = saved.opportunities[0];
    expect(opportunity.strategy.actions).toContain(step.findings[0].detail);
    expect(opportunity.strategy.measurement).toContain("baseline");
    const added = growthPlanResponseSchema.parse((await add(user, opportunity.id).expect(201)).body).item;
    expect(added).toMatchObject({ status: "planned", impact: "unknown", effort: "unknown", timeToValue: "unknown", revision: 0 });
    expect((await add(user, opportunity.id).expect(200)).body.item).toEqual(added);
    const input = { status: "in_progress", impact: "high", effort: "low", timeToValue: "weeks", revision: 0 };
    const updated = growthPlanResponseSchema.parse((await update(user, opportunity.id, input).expect(200)).body).item;
    expect(updated).toMatchObject({ ...input, revision: 1 });
    await update(user, opportunity.id, input).expect(409);
    await update(user, opportunity.id, { ...input, revision: 1, status: "deployed" }).expect(400);
    store.close(); store = openStore(path); app = createApp({ store, agent, scanner });
    expect((await get(user).expect(200)).body.plan).toEqual([updated]);
    await update(user, opportunity.id, { ...input, revision: 1, status: "completed" }).expect(200);
    expect((await get(user).expect(200)).body.plan[0].status).toBe("completed");
    expect(scanner).not.toHaveBeenCalled(); expect(agent.run).not.toHaveBeenCalled();
  });

  it("enforces owner, business, origin and server-selected evidence for every plan mutation", async () => {
    const alice = owner(), bob = owner(); saveResearch(alice);
    const opportunity = (await get(alice).expect(200)).body.opportunities[0];
    await request(app).get(alice.endpoint).expect(401);
    await request(app).get(alice.endpoint).set("Cookie", bob.cookie).expect(404);
    await request(app).post(`${alice.endpoint}/${opportunity.id}/plan`).set("Cookie", alice.cookie).send({}).expect(403);
    await request(app).post(`${alice.endpoint}/${opportunity.id}/plan`).set("Cookie", bob.cookie).set("Origin", origin).send({}).expect(404);
    await request(app).post(`${alice.endpoint}/${opportunity.id}/plan`).set("Cookie", alice.cookie).set("Origin", origin)
      .send({ opportunity: { ...opportunity, title: "Injected recommendation" } }).expect(400);
    await add(bob, opportunity.id).expect(404);
    await add(alice, "a".repeat(64)).expect(404);
    await add(alice, opportunity.id).expect(201);
    await update(bob, opportunity.id, { status: "planned", impact: "low", effort: "high", timeToValue: "days", revision: 0 }).expect(404);
    expect((await get(bob).expect(200)).body).toMatchObject({ opportunities: [], plan: [], researchStatus: "unavailable" });
    expect(agent.run).not.toHaveBeenCalled();
  });

  it("keeps an earlier plan and partial accepted findings after a later empty failure, without crossing website scopes", async () => {
    const user = owner();
    const first = store.enqueueAnalysis(user.id, user.business.id, randomUUID(), url, undefined, true);
    const claimed = store.claimAnalysis()!;
    store.researchJournal(first.id, claimed.lease).write(step);
    store.failAnalysis(first.id, claimed.lease, "An unrelated research step failed.");
    const opportunity = (await get(user).expect(200)).body.opportunities[0];
    await add(user, opportunity.id).expect(201);
    const second = store.enqueueAnalysis(user.id, user.business.id, randomUUID(), url, undefined, true);
    const next = store.claimAnalysis()!;
    store.failAnalysis(second.id, next.lease, "No new findings.");
    expect((await get(user).expect(200)).body.opportunities[0].id).toBe(opportunity.id);
    store.saveBusiness(user.id, { ...user.business, website: "https://new.example.com/" }, user.business.id);
    const changed = (await get(user).expect(200)).body;
    expect(changed.opportunities).toEqual([]);
    expect(changed.plan[0].opportunity.id).toBe(opportunity.id);
    expect(changed.researchStatus).toBe("unavailable");
  });
});
