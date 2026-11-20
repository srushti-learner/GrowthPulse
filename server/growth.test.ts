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
import { createGrowthAdvisor, catalogueFingerprint } from "./growth-advisor.js";
import { emptyProduct } from "../shared/products.js";
import type { AgentModel } from "./business-agent.js";

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
  const complete = vi.fn<AgentModel>();
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "gp-growth-")); path = join(directory, "test.sqlite");
    complete.mockReset();
    complete.mockImplementation(async (input) => {
      const data = JSON.parse(String(input.messages[0].content)) as {
        scope?: string; action: { title: string }; evidence: { id: string }[]; catalogue: { productId: string; evidence: { id: string }[] }[];
      };
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "fixture", name: "submit_action_guidance", input: data.scope
        ? { steps: [{ title: `Support ${data.action.title}`, detail: "Review the confirmed group, record a baseline and approve a small test.", references: [data.evidence[0].id] }] }
        : { scope: data.catalogue.length >= 2 ? "products" : "business", reason: "The saved recommendation supports this owner-reviewed scope.",
          references: [data.evidence[0].id], candidates: data.catalogue.length >= 2 ? data.catalogue.slice(0, 2).map((product) => ({
            productId: product.productId, reason: "This catalogue evidence supports including the product.", references: [product.evidence[0].id],
          })) : [] } }] };
    });
    store = openStore(path); app = createApp({ store, scanner, agent, growthAdvisor: createGrowthAdvisor({ complete }) }); scanner.mockClear(); agent.run.mockClear();
  });
  afterEach(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  async function owner() {
    const user = { id: randomUUID(), name: "Fixture owner", email: `${randomUUID()}@example.test` }, session = newSession();
    await store.createAccount(user, "test-only fixture hash", session.tokenHash, session.expiresAt);
    const business = (await store.saveBusiness(user.id, { name: "Fixture", website: url, category: "", description: "" }))!;
    return { id: user.id, business, cookie: `gp_session=${session.token}`, endpoint: `/api/businesses/${business.id}/growth` };
  }
  async function saveResearch(user: Awaited<ReturnType<typeof owner>>, research = report) {
    const savedScan = (await store.saveScan(user.id, user.business.id, scan))!;
    return (await store.saveUnderstanding(user.id, {
      id: randomUUID(), businessId: user.business.id, scanId: savedScan.id, scanStatus: "complete", reviewedAt: null, createdAt: timestamp,
      warnings: [], suggestions: [], productImportId: null, research,
      briefing: { summary: { text: source.quote, sources: [{ url, quote: source.quote }] }, insights: [], unknowns: [], nextSteps: [] },
    }))!;
  }
  function get(user: Awaited<ReturnType<typeof owner>>) { return request(app).get(user.endpoint).set("Cookie", user.cookie); }
  function add(user: Awaited<ReturnType<typeof owner>>, id: string) {
    return request(app).post(`${user.endpoint}/${id}/plan`).set("Origin", origin).set("Cookie", user.cookie).send({});
  }
  function update(user: Awaited<ReturnType<typeof owner>>, id: string, input: object) {
    return request(app).patch(`${user.endpoint}/${id}/plan`).set("Origin", origin).set("Cookie", user.cookie).send(input);
  }
  function work(user: Awaited<ReturnType<typeof owner>>, id: string, action?: string, input?: object, method: "post" | "patch" = "post") {
    const call = action ? request(app)[method](`${user.endpoint}/${id}/work/${action}`).set("Origin", origin).send(input)
      : request(app).get(`${user.endpoint}/${id}/work`);
    return call.set("Cookie", user.cookie);
  }
  async function plannedAction(user: Awaited<ReturnType<typeof owner>>) {
    await saveResearch(user);
    const id = (await get(user)).body.opportunities[0].id as string;
    await add(user, id).expect(201); return id;
  }

  it("connects a multi-product action only after consent and target approval, then persists contextual steps without new actions", async () => {
    const user = await owner(), id = await plannedAction(user);
    for (const name of ["Cotton tee", "Cotton trousers"]) await store.saveProduct(user.id, user.business.id, { ...emptyProduct, name, description: "Cotton clothing." });
    const initial = (await work(user, id).expect(200)).body;
    expect(initial.item.revision).toBe(0); expect(complete).not.toHaveBeenCalled();
    await work(user, id, "decision", { consent: false, revision: 0 }).expect(400);
    const matched = (await work(user, id, "decision", { consent: true, revision: 0 }).expect(200)).body;
    expect(matched.decision.scope).toBe("products"); expect(matched.item.revision).toBe(1);
    expect(matched.opportunity.work.selection).toBeNull();
    await work(user, id, "proposals", { consent: true, revision: 1 }).expect(409);
    expect(complete).toHaveBeenCalledOnce();
    await work(user, id, "decision", { consent: true, revision: 1 }).expect(200);
    expect(complete).toHaveBeenCalledOnce();
    const confirmed = (await work(user, id, "selection", {
      revision: 1, catalogueFingerprint: matched.catalogueFingerprint, scope: "products",
      productIds: matched.decision.candidates.map((candidate: { productId: string }) => candidate.productId),
    }, "patch").expect(200)).body;
    const proposed = (await work(user, id, "proposals", { consent: true, revision: confirmed.item.revision }).expect(200)).body;
    expect(proposed.opportunity.work.steps).toHaveLength(1);
    const modelInput = JSON.parse(String(complete.mock.calls[1][0].messages[0].content));
    expect(modelInput.action.title).toBe(initial.opportunity.title);
    expect(modelInput.scope).toBe("products"); expect(modelInput.catalogue).toHaveLength(2);
    expect((await get(user)).body.plan).toHaveLength(1);
    const step = proposed.opportunity.work.steps[0];
    await work(user, id, "steps", { revision: proposed.item.revision, stepId: step.id, status: "measured", outcome: "" }, "patch").expect(400);
    const measured = (await work(user, id, "steps", {
      revision: proposed.item.revision, stepId: step.id, status: "measured", outcome: "Observed three sizing enquiries in the recorded test window.",
    }, "patch").expect(200)).body;
    expect(measured.opportunity.work.steps[0].status).toBe("measured");
    await store.close(); store = openStore(path); app = createApp({ store });
    const reopened = (await work(user, id).expect(200)).body;
    expect(reopened.opportunity.work).toEqual(measured.opportunity.work);
    expect(complete).toHaveBeenCalledTimes(2); expect(scanner).not.toHaveBeenCalled(); expect(agent.run).not.toHaveBeenCalled();
  });

  it("keeps business and new-product work valid with an empty catalogue and no provider, while guarding owner and revision", async () => {
    const user = await owner(), id = await plannedAction(user), other = await owner();
    app = createApp({ store });
    const initial = (await work(user, id).expect(200)).body;
    await work(other, id).expect(404);
    await request(app).get(`${user.endpoint}/${id}/work`).expect(401);
    await request(app).patch(`${user.endpoint}/${id}/work/selection`).set("Cookie", user.cookie).send({}).expect(403);
    await work(user, id, "selection", { revision: 0, catalogueFingerprint: initial.catalogueFingerprint, scope: "product", productIds: [] }, "patch").expect(400);
    const selected = (await work(user, id, "selection", {
      revision: 0, catalogueFingerprint: initial.catalogueFingerprint, scope: "new_product", productIds: [],
    }, "patch").expect(200)).body;
    await work(user, id, "steps", { revision: 0, title: "Stale update", detail: "Should not overwrite." }).expect(409);
    const step = (await work(user, id, "steps", { revision: selected.item.revision, title: "Interview customers", detail: "Validate the new concept before developing it." }).expect(200)).body;
    expect(step.opportunity.work.selection.scope).toBe("new_product"); expect(step.opportunity.work.steps).toHaveLength(1);
    expect(step.opportunity.work.steps[0].status).toBe("draft"); expect(complete).not.toHaveBeenCalled();
  });

  it("rejects foreign targets, changed catalogue confirmations and stale product evidence without starting AI", async () => {
    const user = await owner(), id = await plannedAction(user), other = await owner();
    const product = (await store.saveProduct(user.id, user.business.id, { ...emptyProduct, name: "Cotton tee" }))!;
    const foreign = (await store.saveProduct(other.id, other.business.id, { ...emptyProduct, name: "Foreign tee" }))!;
    const snapshot = (await work(user, id)).body;
    await work(user, id, "selection", { revision: 0, catalogueFingerprint: snapshot.catalogueFingerprint, scope: "product", productIds: [foreign.id] }, "patch").expect(404);
    await work(user, id, "selection", { revision: 0, catalogueFingerprint: "old", scope: "product", productIds: [product.id] }, "patch").expect(409);
    await work(user, id, "selection", { revision: 0, catalogueFingerprint: snapshot.catalogueFingerprint, scope: "product", productIds: [product.id] }, "patch").expect(200);
    await store.saveProduct(user.id, user.business.id, { ...emptyProduct, name: "Updated tee", description: "Changed evidence." }, product.id);
    expect((await work(user, id)).body.stale).toBe(true);
    await work(user, id, "proposals", { consent: true, revision: 1 }).expect(409);
    expect(complete).not.toHaveBeenCalled();
  });

  it("preserves reviewed supporting work and rejects target changes until that work is explicitly returned to draft", async () => {
    const user = await owner(), id = await plannedAction(user);
    const fingerprint = catalogueFingerprint([]);
    await work(user, id, "selection", { revision: 0, catalogueFingerprint: fingerprint, scope: "business", productIds: [] }, "patch").expect(200);
    const added = (await work(user, id, "steps", { revision: 1, title: "Approve a platform experiment", detail: "Review the baseline and cost." }).expect(200)).body;
    const stepId = added.opportunity.work.steps[0].id;
    await work(user, id, "steps", { revision: 2, stepId, status: "approved", outcome: "Budget reviewed." }, "patch").expect(200);
    await work(user, id, "selection", { revision: 3, catalogueFingerprint: fingerprint, scope: "new_product", productIds: [] }, "patch").expect(409);
    expect((await work(user, id)).body.opportunity.work.steps[0].status).toBe("approved");
    await work(user, id, "steps", { revision: 3, stepId, status: "draft", outcome: "" }, "patch").expect(200);
    const changed = (await work(user, id, "selection", { revision: 4, catalogueFingerprint: fingerprint, scope: "new_product", productIds: [] }, "patch").expect(200)).body;
    expect(changed.opportunity.work.steps).toMatchObject([{ id: stepId, status: "draft", origin: "owner" }]);
  });
  it("does not duplicate paid matching or overwrite a concurrent planning update", async () => {
    const user = await owner(), id = await plannedAction(user);
    let start!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const held = new Promise<void>((resolve) => { finish = resolve; });
    complete.mockImplementation(async (input) => {
      start(); await held;
      const data = JSON.parse(String(input.messages[0].content));
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "held", name: "submit_action_guidance", input: {
        scope: "business", reason: "Review business guidance.", references: [data.evidence[0].id], candidates: [],
      } }] };
    });
    const pending = work(user, id, "decision", { consent: true, revision: 0 }).then((response) => response);
    await started;
    try {
      await work(user, id, "decision", { consent: true, revision: 0 }).expect(409);
      await update(user, id, { revision: 0, status: "in_progress", impact: "high", effort: "low", timeToValue: "weeks" }).expect(200);
    } finally { finish(); }
    expect((await pending).status).toBe(409);
    expect((await get(user)).body.plan[0]).toMatchObject({ status: "in_progress", revision: 1 });
    expect((await get(user)).body.plan[0].opportunity.work).toBeUndefined();
    expect(complete).toHaveBeenCalledOnce();
  });
  it("preserves reviewed work when the same product group is confirmed in a different order", async () => {
    const user = await owner(), id = await plannedAction(user);
    const first = (await store.saveProduct(user.id, user.business.id, { ...emptyProduct, name: "Recipe mix" }))!;
    const second = (await store.saveProduct(user.id, user.business.id, { ...emptyProduct, name: "Serving bowl" }))!;
    const fingerprint = (await work(user, id)).body.catalogueFingerprint;
    const selected = (await work(user, id, "selection", {
      revision: 0, catalogueFingerprint: fingerprint, scope: "products", productIds: [first.id, second.id],
    }, "patch").expect(200)).body;
    const added = (await work(user, id, "steps", { revision: 1, title: "Review bundle", detail: "Check suitability with customers." }).expect(200)).body;
    const stepId = added.opportunity.work.steps[0].id;
    await work(user, id, "steps", { revision: 2, stepId, status: "approved", outcome: "Reviewed by owner." }, "patch").expect(200);
    const confirmed = (await work(user, id, "selection", {
      revision: 3, catalogueFingerprint: fingerprint, scope: "products",
      productIds: selected.opportunity.work.selection.products.map((product: { productId: string }) => product.productId).reverse(),
    }, "patch").expect(200)).body;
    expect(confirmed.opportunity.work.steps[0]).toMatchObject({ id: stepId, status: "approved", outcome: "Reviewed by owner." });
    expect(complete).not.toHaveBeenCalled();
  });

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
    const user = await owner(); await saveResearch(user);
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
    await store.close(); store = openStore(path); app = createApp({ store, agent, scanner });
    expect((await get(user).expect(200)).body.plan).toEqual([updated]);
    await update(user, opportunity.id, { ...input, revision: 1, status: "completed" }).expect(200);
    expect((await get(user).expect(200)).body.plan[0].status).toBe("completed");
    expect(scanner).not.toHaveBeenCalled(); expect(agent.run).not.toHaveBeenCalled();
  });

  it("enforces owner, business, origin and server-selected evidence for every plan mutation", async () => {
    const alice = await owner(), bob = await owner(); await saveResearch(alice);
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
    const user = await owner();
    const first = await store.enqueueAnalysis(user.id, user.business.id, randomUUID(), url, undefined, true);
    const claimed = (await store.claimAnalysis())!;
    await store.researchJournal(first.id, claimed.lease).write(step);
    await store.failAnalysis(first.id, claimed.lease, "An unrelated research step failed.");
    const opportunity = (await get(user).expect(200)).body.opportunities[0];
    await add(user, opportunity.id).expect(201);
    const second = await store.enqueueAnalysis(user.id, user.business.id, randomUUID(), url, undefined, true);
    const next = (await store.claimAnalysis())!;
    await store.failAnalysis(second.id, next.lease, "No new findings.");
    expect((await get(user).expect(200)).body.opportunities[0].id).toBe(opportunity.id);
    await store.saveBusiness(user.id, { ...user.business, website: "https://new.example.com/" }, user.business.id);
    const changed = (await get(user).expect(200)).body;
    expect(changed.opportunities).toEqual([]);
    expect(changed.plan[0].opportunity.id).toBe(opportunity.id);
    expect(changed.researchStatus).toBe("unavailable");
  });
});
