import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { openStore, type Store } from "./database.js";
import { createBusinessAgent, type AgentModel } from "./business-agent.js";
import { digestToken } from "./auth.js";
import { previewLifetime } from "../shared/onboarding.js";
import type { ScanResult } from "../shared/website.js";
import { buildAgentEvidence } from "./agent-evidence.js";

const origin = "http://127.0.0.1:5173";
const url = "https://shop.example.com/";
const timestamp = "2026-11-16T12:00:00.000Z";
const quote = "We make cotton clothing for everyday wear.";
const scan: ScanResult = {
  requestedUrl: url, status: "complete", startedAt: timestamp, completedAt: timestamp,
  pages: [{ url, capturedAt: timestamp, title: "Fixture shop", description: quote, text: quote,
    headings: [], contacts: [], callsToAction: [], links: [], warnings: [] }],
  failures: [], notes: [],
};
const proposal = {
  briefing: {
    summary: { text: "The public website presents cotton clothing.", sources: [{ url, quote }] },
    insights: [{ area: "offering", text: "The stated focus is everyday wear.", whyItMatters: "This explains the stated use case.", sources: [{ url, quote }] }],
    unknowns: [{ question: "What are the delivery terms?", whyItMatters: "The captured pages do not establish them." }],
    nextSteps: [{ action: "Review delivery information.", reason: "Confirm the total buying commitment." }],
  }, suggestions: [],
};
const sourceIds = [buildAgentEvidence(scan).payload.pages[0].excerpts.find((excerpt) => excerpt.quote === quote)!.id];
const referencedProposal = {
  ...proposal,
  briefing: {
    ...proposal.briefing,
    summary: { ...proposal.briefing.summary, sources: sourceIds },
    insights: proposal.briefing.insights.map((insight) => ({ ...insight, sources: sourceIds })),
  },
};

describe("public-first onboarding", () => {
  let directory: string, path: string, store: Store, app: ReturnType<typeof createApp>;
  const scanner = vi.fn(async () => structuredClone(scan));
  const complete = vi.fn<AgentModel>();
  const buildApp = () => createApp({ store, origin, scanner, agent: createBusinessAgent({ complete }) });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "gp-onboarding-")); path = join(directory, "test.sqlite");
    store = openStore(path); scanner.mockReset().mockResolvedValue(structuredClone(scan));
    complete.mockReset()
      .mockResolvedValueOnce({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "scan", name: "scan_website", input: {} }] })
      .mockResolvedValueOnce({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "proposal", name: "propose_business", input: referencedProposal }] });
    app = buildApp();
  });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });
  async function preview() {
    const response = await request(app).post("/api/onboarding/scan").set("Origin", origin).send({ url, permission: true }).expect(200);
    return { cookie: String(response.headers["set-cookie"][0]).split(";")[0], response };
  }
  async function account(email = "owner@example.test") {
    const response = await request(app).post("/api/auth/register").set("Origin", origin)
      .send({ name: "Test Owner", email, password: "a local test-only passphrase" }).expect(201);
    return { cookie: String(response.headers["set-cookie"][0]).split(";")[0], id: response.body.user.id as string };
  }
  function claim(cookies: string, body: unknown = { permission: true }) {
    return request(app).post("/api/onboarding/claim").set("Origin", origin).set("Cookie", cookies).send(body);
  }

  it("reads public pages without AI or an account and carries findings across an API restart", async () => {
    const publicResult = await preview();
    expect(publicResult.response.body.preview.scan).toEqual(scan);
    expect(publicResult.response.headers["set-cookie"][0]).toMatch(/HttpOnly/);
    expect(publicResult.response.headers["set-cookie"][0]).toMatch(/SameSite=Lax/);
    expect(complete).not.toHaveBeenCalled();
    const user = await account();
    expect(store.listBusinesses(user.id)).toEqual([]);
    store.close(); store = openStore(path); app = buildApp();
    const restored = await request(app).get("/api/onboarding/preview").set("Cookie", publicResult.cookie).expect(200);
    expect(restored.body).toEqual(publicResult.response.body);
    expect(scanner).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect((await request(app).get("/api/onboarding/preview").expect(200)).body).toEqual({ preview: null });
  });

  it("requires sign-in, permission and the application origin and never accepts client-supplied evidence", async () => {
    await request(app).post("/api/onboarding/scan").send({ url, permission: true }).expect(403);
    await request(app).post("/api/onboarding/scan").set("Origin", origin).send({ url }).expect(400);
    const publicResult = await preview();
    await claim(publicResult.cookie).expect(401);
    const user = await account();
    await claim(`${publicResult.cookie}; ${user.cookie}`, {}).expect(400);
    await claim(`${publicResult.cookie}; ${user.cookie}`, { permission: true, scan }).expect(400);
    await request(app).post("/api/onboarding/claim").set("Cookie", `${publicResult.cookie}; ${user.cookie}`).send({ permission: true }).expect(403);
    expect(store.listBusinesses(user.id)).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
    expect(scanner).toHaveBeenCalledOnce();
  });

  it("claims once, preserves existing owner details, and cannot be claimed by another account", async () => {
    const publicResult = await preview();
    const user = await account();
    const existing = store.saveBusiness(user.id, { name: "Owner's name", website: url, category: "Owner category", description: "Private owner notes" })!;
    const cookies = `${publicResult.cookie}; ${user.cookie}`;
    const first = await claim(cookies).expect(200);
    const second = await claim(cookies).expect(200);
    expect(first.body.business).toEqual(existing);
    expect(second.body).toEqual(first.body);
    expect(store.listScans(user.id, existing.id)).toHaveLength(1);
    expect(store.listActivity(user.id, existing.id)).toHaveLength(2);
    expect(complete).not.toHaveBeenCalled();
    const other = await account("other@example.test");
    await claim(`${publicResult.cookie}; ${other.cookie}`).expect(409);
    expect(store.listBusinesses(other.id)).toEqual([]);
  });

  it("saves a twenty-page preview and creates its briefing without rescanning, including after reopening", async () => {
    const captured = { ...scan, pages: Array.from({ length: 20 }, (_, index) => ({
      ...scan.pages[0], url: index ? `${url}products/item-${index}` : url,
    })) };
    scanner.mockResolvedValueOnce(captured);
    const sources = [buildAgentEvidence(captured).payload.pages[0].excerpts.find((excerpt) => excerpt.quote === quote)!.id];
    complete.mockReset()
      .mockResolvedValueOnce({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "scan", name: "scan_website", input: {} }] })
      .mockResolvedValueOnce({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "proposal", name: "propose_business",
        input: { ...referencedProposal, briefing: { ...referencedProposal.briefing,
          summary: { ...referencedProposal.briefing.summary, sources },
          insights: referencedProposal.briefing.insights.map((insight) => ({ ...insight, sources })),
        } },
      }] });
    const publicResult = await preview();
    const user = await account();
    const cookies = `${publicResult.cookie}; ${user.cookie}`;
    const saved = await claim(cookies).expect(200);
    expect(saved.body.scan.pages).toHaveLength(20);
    await request(app).post(`/api/businesses/${saved.body.business.id}/understanding`).set("Origin", origin)
      .set("Cookie", user.cookie).send({ permission: true, scanId: saved.body.scan.id }).expect(201);
    expect(scanner).toHaveBeenCalledOnce();
    store.close(); store = openStore(path); app = buildApp();
    const restored = await claim(cookies).expect(200);
    expect(restored.body.scan).toEqual(saved.body.scan);
    expect(restored.body.understanding.scanId).toBe(saved.body.scan.id);
    expect(store.listScans(user.id, saved.body.business.id)[0].pageCount).toBe(20);
  });

  it("streams a grounded briefing from the claimed scan without scanning again or importing client evidence", async () => {
    const publicResult = await preview();
    const user = await account();
    const claimed = await claim(`${publicResult.cookie}; ${user.cookie}`).expect(200);
    const businessId = claimed.body.business.id as string;
    expect(claimed.body.business).toMatchObject({ name: "shop.example.com", website: url, category: "", description: "" });
    const result = await request(app).post(`/api/businesses/${businessId}/understanding`)
      .set("Origin", origin).set("Cookie", user.cookie).set("Accept", "application/x-ndjson")
      .send({ permission: true, scanId: claimed.body.scan.id }).expect(200);
    const events = result.text.trim().split("\n").map((line: string) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: "complete", understanding: { briefing: proposal.briefing, scanId: claimed.body.scan.id } });
    expect(scanner).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(store.listScans(user.id, businessId)).toHaveLength(1);
    const restored = await claim(`${publicResult.cookie}; ${user.cookie}`).expect(200);
    expect(restored.body.understanding).toEqual(store.latestUnderstanding(user.id, businessId));
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("rejects foreign, mismatched and empty saved scans before making a provider request", async () => {
    const user = await account(), other = await account("other@example.test");
    const business = store.saveBusiness(user.id, { name: "Shop", website: url, category: "", description: "" })!;
    const foreign = store.saveBusiness(other.id, { name: "Other", website: url, category: "", description: "" })!;
    const foreignScan = store.saveScan(other.id, foreign.id, scan)!;
    const mismatch = store.saveScan(user.id, business.id, { ...scan, requestedUrl: "https://different.example.com/" })!;
    const failed = store.saveScan(user.id, business.id, { ...scan, status: "failed", pages: [] })!;
    for (const [scanId, status] of [[foreignScan.id, 404], [mismatch.id, 404], [failed.id, 400]] as const) {
      await request(app).post(`/api/businesses/${business.id}/understanding`).set("Origin", origin).set("Cookie", user.cookie)
        .send({ permission: true, scanId }).expect(status);
    }
    expect(complete).not.toHaveBeenCalled();
    expect(scanner).not.toHaveBeenCalled();
  });

  it("expires previews without claiming records or silently repeating a scan", async () => {
    const publicResult = await preview(), user = await account();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + previewLifetime + 1);
    await claim(`${publicResult.cookie}; ${user.cookie}`).expect(410);
    expect((await request(app).get("/api/onboarding/preview").set("Cookie", publicResult.cookie).expect(200)).body).toEqual({ preview: null });
    expect(store.listBusinesses(user.id)).toEqual([]);
    expect(scanner).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not turn a failed scan into a profile or AI briefing and clears the handoff on logout", async () => {
    scanner.mockResolvedValueOnce({ ...scan, status: "failed", pages: [], failures: [{ url, message: "Reading is not permitted." }] });
    const publicResult = await preview(), user = await account();
    await claim(`${publicResult.cookie}; ${user.cookie}`).expect(400);
    expect(store.listBusinesses(user.id)).toEqual([]);
    const logout = await request(app).post("/api/auth/logout").set("Origin", origin).set("Cookie", `${publicResult.cookie}; ${user.cookie}`).expect(204);
    expect(logout.headers["set-cookie"].some((value: string) => value.startsWith("gp_preview="))).toBe(true);
    expect((await request(app).get("/api/onboarding/preview").set("Cookie", publicResult.cookie).expect(200)).body.preview).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("bounds anonymous preview storage and replacement without evicting other browsers", () => {
    const first = digestToken(randomUUID());
    store.savePreview(first, scan);
    for (let index = 1; index < 50; index++) store.savePreview(digestToken(randomUUID()), scan);
    expect(() => store.savePreview(digestToken(randomUUID()), scan)).toThrow("storage is busy");
    const replacement = digestToken(randomUUID());
    store.savePreview(replacement, scan, first);
    expect(store.getPreview(first)).toBeNull();
    expect(store.getPreview(replacement)?.scan).toEqual(scan);
    const oversized = { ...scan, pages: Array.from({ length: 5 }, () => ({ ...scan.pages[0], productJson: Array.from({ length: 50 }, () => "x".repeat(20000)) })) };
    expect(() => store.savePreview(digestToken(randomUUID()), oversized)).toThrow("too large");
  });
});
