// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusinessWorkspace } from "./BusinessWorkspace";
import type { Understanding } from "../shared/understanding";
import type { AnalysisJob } from "../shared/analysis";
import { BusinessAgentReview } from "./BusinessAgentReview";
import { researchAgents, researchAgentLabels } from "../shared/research";
import { ResearchReport } from "./ResearchReport";

const business = {
  id: "02a221ee-41f1-46c9-bc96-12401d8dcf73", name: "Fixture shop", website: "https://shop.example.com/",
  category: "", description: "Owner description", createdAt: "2026-11-16T12:00:00.000Z", updatedAt: "2026-11-16T12:00:00.000Z",
};
const draft = {
  id: "63243bee-1f3a-40db-a516-93b04d40f797", businessId: business.id,
  scanId: "bdc0f304-3b01-4542-824a-7995d482b81c", scanStatus: "complete", reviewedAt: null, createdAt: business.createdAt, warnings: [],
  productImportId: "4c54b43b-8191-4f3d-af8f-607937219267",
  briefing: {
    summary: { text: "This shop presents a cotton clothing range for everyday use.", sources: [{ url: business.website, quote: "We make cotton clothing for everyday wear." }] },
    insights: [{ area: "offering", text: "The website emphasizes cotton and everyday wear.", whyItMatters: "Fabric and use-case details help shoppers evaluate product fit.", sources: [{ url: business.website, quote: "We make cotton clothing for everyday wear." }] }],
    unknowns: [{ question: "What does delivery cost?", whyItMatters: "The captured pages do not establish the full purchase cost." }],
    nextSteps: [{ action: "Check the public delivery policy.", reason: "Establish shipping costs before assessing affordability." }],
  },
  suggestions: [{ field: "description", value: "Cotton clothing for everyday wear.", sources: [{ url: business.website, quote: "We make cotton clothing for everyday wear." }] }],
} satisfies Understanding;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const streamed = (understanding: Understanding) => new Response(`${JSON.stringify({ type: "complete", understanding })}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
describe("agent-led profile onboarding", () => {
  let container: HTMLDivElement, root: Root;
  const expired = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); expired.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render() {
    await act(async () => root.render(<StrictMode><BusinessWorkspace activityOnly={false} onSessionExpired={expired} /></StrictMode>));
  }
  async function renderAgent(autoStart = false, evidence?: { scanId: string; scanCapturedAt: string }) {
    await act(async () => root.render(<StrictMode><BusinessAgentReview business={business} autoStart={autoStart} {...evidence}
      initialView="overview"
      onSaved={vi.fn()} onRecorded={vi.fn()} onSessionExpired={expired} /></StrictMode>));
    const archive = container.querySelector<HTMLDetailsElement>(".specialist-archive");
    if (archive) await act(async () => { archive.open = true; });
  }
  async function set(name: string, value: string) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function save() {
    await act(async () => container.querySelector("form.profile-card")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }
  async function briefingSection(label: string) {
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>(".briefing-sections button")).find((button) => button.textContent?.startsWith(label))!.click());
  }
  function fetcher({ existing = false, failure = false, review = draft, website = business.website }: { existing?: boolean; failure?: boolean; review?: Understanding; website?: string } = {}) {
    let savedBusiness = { ...business, website };
    let savedReview = review;
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/businesses") return options?.method === "POST" ? json({ business: savedBusiness }, 201) : json({ businesses: existing ? [savedBusiness] : [] });
      if (path.endsWith("/activity")) return json({ activities: [] });
      if (path.endsWith("/evidence")) return json({ evidence: [] });
      if (path.endsWith("/apply")) {
        const { category, description } = JSON.parse(String(options?.body));
        savedBusiness = { ...business, category, description };
        savedReview = { ...review, reviewedAt: business.updatedAt };
        return json({ business: savedBusiness, understanding: savedReview });
      }
      if (path.endsWith("/understanding")) return options?.method === "POST"
        ? failure ? json({ error: "Set ANTHROPIC_API_KEY on the server. Your profile is saved." }, 503) : streamed(review)
        : json({ understanding: existing || savedReview.reviewedAt ? savedReview : null });
      if (options?.method === "PUT") return json({ business: { ...business, ...JSON.parse(String(options.body)) } });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  async function create() {
    await render();
    await set("businessName", business.name); await set("website", business.website);
    expect(container.querySelector('form.profile-card input[type="checkbox"]')).toBeNull();
    expect(container.querySelector("#profile-analysis-notice")?.textContent).toContain("Saving starts your business and competitor analysis.");
    expect(container.querySelector<HTMLButtonElement>('form.profile-card button[type="submit"]')?.disabled).toBe(false);
    await save();
  }

  it("honors the server cooldown without hiding saved findings or enabling another paid start", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async (_path: string, options?: RequestInit) => options?.method === "POST"
        ? new Response(JSON.stringify({ error: "New AI analysis limit reached. Saved findings remain available." }), { status: 429, headers: { "Retry-After": "3" } })
        : json({ understanding: draft }));
      vi.stubGlobal("fetch", fetch); await renderAgent();
      await act(async () => container.querySelector<HTMLButtonElement>(".agent-controls .primary-link")!.click());
      const retry = container.querySelector<HTMLButtonElement>(".agent-controls .primary-link")!;
      expect(retry.disabled).toBe(true);
      expect(container.querySelector("#agent-heading")?.textContent).toBe("Your next analysis is on cooldown.");
      expect(container.textContent).toContain("Retry available in 3 seconds");
      expect(container.textContent).toContain(draft.briefing.summary.text);
      await act(async () => vi.advanceTimersByTime(3000));
      expect(retry.disabled).toBe(false);
      expect(container.querySelector("#agent-heading")?.textContent).toBe("No new analysis was started.");
      expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("keeps research pages focused without the extra settings, product or rerun footer sections", async () => {
    const research: NonNullable<Understanding["research"]> = { version: 1, status: "complete", enabled: true, steps: [], usage: { searches: 0, modelCalls: 1, competitorScans: 0 } };
    const fetch = fetcher({ existing: true, review: { ...draft, research } });
    await act(async () => root.render(<BusinessWorkspace activityOnly={false} researchOnly onSessionExpired={expired} />));
    expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("At a glance");
    expect(container.querySelector(".business-profile-settings")).toBeNull();
    expect(container.querySelector(".agent-product-review")).toBeNull();
    expect(container.querySelector(".agent-profile-editor")).toBeNull();
    expect(container.querySelector(".agent-rerun")).toBeNull();
    expect(container.querySelector(".research-run-details")).toBeNull();
    expect(container.querySelector('.dashboard-paths a[href="#growth"]')?.textContent).toContain("Build your growth plan");
    expect(container.querySelector('[role="tab"][value="opportunities"]')).toBeNull();
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("keeps activity off the business profile and loads it only in Activity History", async () => {
    const fetch = fetcher({ existing: true });
    const historyCalls = () => fetch.mock.calls.filter(([path]) => path.endsWith("/activity") || path.endsWith("/evidence"));
    await render();
    expect(container.querySelector(".saved-profile")).not.toBeNull();
    expect(container.querySelector(".activity-card")).toBeNull();
    expect(historyCalls()).toHaveLength(0);
    await act(async () => root.render(<StrictMode><BusinessWorkspace activityOnly onSessionExpired={expired} /></StrictMode>));
    expect(container.querySelector("#history-heading")?.textContent).toBe("Activity history");
    expect(container.querySelector(".activity-card")?.textContent).toContain("No activity recorded yet.");
    expect(historyCalls()).toHaveLength(2);
    await render();
    expect(container.querySelector(".saved-profile")).not.toBeNull();
    expect(container.querySelector(".activity-card")).toBeNull();
    expect(historyCalls()).toHaveLength(2);
  });

  it("does not substitute an older Store briefing for missing market research or rerun analysis", async () => {
    const fetch = fetcher({ existing: true });
    const consoleError = vi.spyOn(console, "error");
    try {
      await act(async () => root.render(<BusinessWorkspace activityOnly={false} researchOnly researchView="intelligence" onSessionExpired={expired} />));
      expect(container.querySelectorAll(".marketplace-insights")).toHaveLength(1);
      for (let attempt = 0; attempt < 3; attempt++) {
        await act(async () => root.render(<BusinessWorkspace activityOnly={false} researchOnly researchView="overview" onSessionExpired={expired} />));
        expect(container.querySelectorAll(".marketplace-insights")).toHaveLength(0);
        await act(async () => root.render(<BusinessWorkspace activityOnly={false} researchOnly researchView="intelligence" onSessionExpired={expired} />));
        expect(container.querySelectorAll(".marketplace-insights")).toHaveLength(1);
        const businessSelect = container.querySelector<HTMLSelectElement>(".business-toolbar select")!;
        await act(async () => { businessSelect.value = ""; businessSelect.dispatchEvent(new Event("change", { bubbles: true })); });
        expect(container.querySelectorAll(".marketplace-insights")).toHaveLength(0);
        await act(async () => { businessSelect.value = business.id; businessSelect.dispatchEvent(new Event("change", { bubbles: true })); });
        expect(container.querySelectorAll(".marketplace-insights")).toHaveLength(1);
      }
      expect(consoleError.mock.calls.filter((args) => args.some((arg) => typeof arg === "string" && arg.includes("same key")))).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
    const panel = container.querySelector('[role="tabpanel"]:not([hidden])')!;
    expect(panel.textContent).toContain("Not enough external evidence for a market conclusion yet.");
    expect(panel.textContent).toContain("No market research saved");
    expect(panel.querySelector('a[href="#business"]')?.textContent).toBe("Manage website analysis");
    expect(panel.querySelector(".agent-briefing")).toBeNull();
    expect(panel.textContent).not.toContain(draft.briefing.summary.text);
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("opens profile management without the research dashboard and still starts the agent after an approved save", async () => {
    const fetch = fetcher({ existing: true });
    await act(async () => root.render(<StrictMode><BusinessWorkspace activityOnly={false} profileOnly onSessionExpired={expired} /></StrictMode>));
    expect(container.querySelector<HTMLDetailsElement>(".business-profile-settings")?.open).toBe(true);
    expect(container.querySelector(".agent-review")).toBeNull();
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/understanding"))).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>(".saved-profile button")!.click());
    await save();
    expect(container.querySelector(".agent-review")).not.toBeNull();
    expect(fetch.mock.calls.filter(([path, options]) => path.endsWith("/understanding") && options?.method === "POST")).toHaveLength(1);
  });

  it("offers optional analysis controls in Business Profile without loading a research dashboard or starting paid work", async () => {
    const research: NonNullable<Understanding["research"]> = { version: 1, status: "complete", enabled: true, steps: [], usage: { searches: 0, modelCalls: 1, competitorScans: 0 } };
    const fetch = fetcher({ existing: true, review: { ...draft, research } });
    await act(async () => root.render(<BusinessWorkspace activityOnly={false} profileOnly onSessionExpired={expired} />));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".saved-profile button")].find((button) => button.textContent?.includes("Manage website analysis"))!.click());
    expect(container.querySelector(".agent-rerun")).not.toBeNull();
    expect(container.querySelector(".agent-profile-editor")).not.toBeNull();
    expect(container.querySelector(".research-report")).toBeNull();
    expect(container.querySelector(".business-briefing")).toBeNull();
    expect(container.querySelector(".agent-product-review")).toBeNull();
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    expect(container.querySelector<HTMLButtonElement>(".agent-controls button")?.disabled).toBe(false);
    expect(container.querySelector(".agent-controls input[type=checkbox]")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-controls button")!.click());
    expect(fetch.mock.calls.filter(([path, options]) => path.endsWith("/understanding") && options?.method === "POST")).toHaveLength(1);
  });

  it("keeps failure recovery available on research pages rather than hiding errors with the footer controls", async () => {
    const fetch = fetcher({ existing: true, review: { ...draft, scanStatus: "failed", briefing: null, suggestions: [], productImportId: null } });
    await act(async () => root.render(<BusinessWorkspace activityOnly={false} researchOnly onSessionExpired={expired} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("website could not be read");
    expect(container.querySelector(".agent-rerun")).not.toBeNull();
    expect(container.querySelector(".business-profile-settings")).toBeNull();
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("automatically invokes the agent once after saving a website profile without a checkbox, even in Strict Mode", async () => {
    const fetch = fetcher(); await create();
    expect(container.querySelector(".saved-profile")).not.toBeNull();
    expect(container.textContent).toContain("Your business, explained.");
    const calls = fetch.mock.calls.filter(([path, options]) => path.endsWith("/understanding") && options?.method === "POST");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ permission: true, research: true, researchVersion: 2 });
    expect(fetch.mock.calls.some(([path]) => path.includes("/website/scan") || path.endsWith("/scans"))).toBe(false);
    expect(container.querySelector(".agent-suggestion a")?.getAttribute("href")).toBe(business.website);
    expect(container.querySelector<HTMLButtonElement>(".agent-profile-form button[type=submit]")?.disabled).toBe(false);
    expect(container.querySelector(".agent-suggestion input[type=checkbox]")).toBeNull();
    expect(container.querySelector(".saved-profile-details")?.textContent).toContain("Owner description");
    expect(fetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
  });

  const queuedJob: AnalysisJob = {
    id: "9f1fb19f-04dc-41d7-ae01-8b5e238266fe", businessId: business.id, requestedUrl: business.website,
    scanId: draft.scanId, status: "running", phase: "analysing", preview: { summary: { text: "Saved provisional analysis" } },
    understanding: null, error: null, revision: 2, createdAt: business.createdAt, updatedAt: business.updatedAt,
    researchVersion: 2,
  };
  const jobResponse = (job: AnalysisJob) => new Response(`${JSON.stringify({ type: "job", job })}\n`, { headers: { "Content-Type": "application/x-ndjson" } });

  it("includes competitor research only after the disclosed start action without a permission checkbox", async () => {
    const fetch = fetcher({ existing: true });
    await renderAgent();
    const checkboxes = container.querySelectorAll<HTMLInputElement>(".agent-controls input[type=checkbox]");
    expect(checkboxes).toHaveLength(0);
    expect(container.querySelector(".agent-controls")?.textContent).toContain("Competitor research is included.");
    expect(container.querySelector(".agent-controls")?.textContent).toContain("Tavily");
    expect(container.querySelector<HTMLButtonElement>(".agent-controls .primary-link")!.disabled).toBe(false);
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-controls .primary-link")!.click());
    const posts = fetch.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]!.body))).toEqual({ permission: true, research: true, researchVersion: 2 });
  });

  it("includes competitor research when automatically analysing newly consented website evidence", async () => {
    const fetch = fetcher({ existing: true });
    await renderAgent();
    await renderAgent(true, { scanId: draft.scanId, scanCapturedAt: "2026-11-17T12:00:00.000Z" });
    const posts = fetch.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]!.body))).toEqual({ permission: true, scanId: draft.scanId, research: true, researchVersion: 2 });
    expect(container.querySelectorAll(".agent-controls input[type=checkbox]")).toHaveLength(0);
  });

  it("restores accepted findings after cancellation and explicitly retries with the saved run and consent", async () => {
    const research: NonNullable<AnalysisJob["research"]> = {
      version: 1, status: "partial", enabled: true, usage: { searches: 1, competitorScans: 0, modelCalls: 1 },
      steps: [
        { key: "store", agent: "store", status: "failed", findings: [], limitations: ["The store response was incomplete."],
          diagnostic: { code: "model_incomplete", paths: [] }, startedAt: business.createdAt, completedAt: business.updatedAt, reused: false },
        { key: "growth", agent: "growth", status: "completed", findings: [{
          kind: "suggestion", title: "Keep this independently saved suggestion", detail: "Verify cotton descriptions before a merchandising test.",
          sources: [{ id: "e_1111111111111111", url: business.website, quote: "We make cotton clothing for everyday wear.", capturedAt: business.createdAt }],
        }], limitations: [], diagnostic: null, startedAt: business.createdAt, completedAt: business.updatedAt, reused: false },
      ],
    };
    const stopped = { ...queuedJob, status: "cancelled", preview: null, researchEnabled: true, research } as const;
    const fetch = vi.fn(async (_: string, options?: RequestInit) => options?.method === "POST"
      ? streamed({ ...draft, research }) : json({ understanding: null, job: stopped }));
    vi.stubGlobal("fetch", fetch); await renderAgent();
    expect(container.textContent).toContain("The store response was incomplete.");
    expect(container.querySelectorAll(".research-agent-nav button")).toHaveLength(6);
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>(".research-agent-nav button"))
      .find((button) => button.textContent?.startsWith("Growth strategy"))!.click());
    expect(container.textContent).toContain("Keep this independently saved suggestion");
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    expect(container.querySelectorAll(".agent-controls input[type=checkbox]")).toHaveLength(0);
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-controls button"))
      .find((button) => button.textContent === "Retry failed research steps")!.click());
    const post = fetch.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ permission: true, scanId: draft.scanId, research: true, researchVersion: 2, resumeJobId: stopped.id });
    expect(container.querySelector('.research-agent-nav button[aria-pressed="true"]')?.textContent).toContain("Growth strategy");
    expect(container.textContent).toContain("Keep this independently saved suggestion");
  });

  it("does not offer a brand-recheck option or automatically retry limited brand validation", async () => {
    const research: NonNullable<AnalysisJob["research"]> = {
      version: 1, status: "partial", enabled: true, usage: { searches: 6, competitorScans: 1, modelCalls: 4 },
      steps: [{
        key: "competitor-brand-0", agent: "competitor", status: "limited", findings: [],
        limitations: ["Captured pages did not verify a distinct official brand in the merchant's product category."],
        diagnostic: null, startedAt: business.createdAt, completedAt: business.updatedAt, reused: false,
      }],
    };
    const saved: AnalysisJob = { ...queuedJob, status: "completed", preview: null, researchEnabled: true,
      researchVersion: 2, research, understanding: { ...draft, research } };
    const fetch = vi.fn(async (_: string, options?: RequestInit) => options?.method === "POST"
      ? streamed({ ...draft, research }) : json({ understanding: { ...draft, research }, job: saved }));
    vi.stubGlobal("fetch", fetch); await renderAgent();
    expect(container.textContent).not.toContain("Recheck unverified brands");
    expect(container.textContent).not.toContain("Rechecking reuses saved scans");
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    await act(async () => container.querySelector<HTMLDetailsElement>(".agent-rerun")!.querySelector("summary")!.click());
    expect(container.textContent).not.toContain("Recheck unverified brands");
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it.each([
    { enabled: false, researchVersion: 2 },
    { enabled: true, researchVersion: 1 },
  ])("starts a newly approved combined attempt instead of resuming incompatible research ($enabled, version $researchVersion)", async ({ enabled, researchVersion }) => {
    const stopped: AnalysisJob = {
      ...queuedJob, status: "cancelled", preview: null, researchEnabled: enabled, researchVersion,
      research: { version: 1, status: "partial", enabled, usage: { searches: 0, competitorScans: 0, modelCalls: 1 }, steps: [] },
    };
    const fetch = vi.fn(async (_: string, options?: RequestInit) => options?.method === "POST"
      ? streamed(draft) : json({ understanding: draft, job: stopped }));
    vi.stubGlobal("fetch", fetch); await renderAgent();
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    expect(container.querySelector(".agent-controls input[type=checkbox]")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-controls button")!.click());
    const posts = fetch.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]!.body))).toEqual({
      permission: true, scanId: draft.scanId, research: true, researchVersion: 2,
    });
  });

  it.each(["queued", "running"] as const)("restores compact %s progress, then displays the saved result without another POST", async (status) => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn(async (path: string) => {
      if (path.endsWith("/understanding")) return json({ understanding: draft, job: { ...queuedJob, status } });
      if (path.endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "application/x-ndjson" } });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch); await renderAgent();
    expect(container.textContent).toContain("Saved provisional analysis");
    expect(container.querySelector(".agent-progress [role=status]")?.textContent).toBe(status === "queued" ? "Waiting to start..." : "Writing your business briefing...");
    expect(container.querySelector(".agent-review > .card-heading > p:not(.section-eyebrow)")).toBeNull();
    expect(container.querySelector(".agent-progress")?.textContent).not.toContain("background work");
    expect(container.querySelector(".agent-progress button")?.textContent).toBe("Cancel analysis");
    expect(container.querySelector(".agent-progress button")?.closest("details")).toBeNull();
    const details = container.querySelector<HTMLDetailsElement>(".agent-progress-details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("background work continues");
    expect(details.textContent).toContain("10 minutes");
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    expect(container.querySelector(".agent-profile-form")).toBeNull();
    await act(async () => {
      stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "job", job: { ...queuedJob, status: "completed", preview: null, understanding: draft, revision: 3 } })}\n`));
      stream.close();
    });
    expect(container.textContent).toContain(draft.briefing!.summary.text);
    expect(container.querySelector(".agent-profile-form")).not.toBeNull();
    expect(fetch.mock.calls.every(([path]) => !path.endsWith("/cancel"))).toBe(true);
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/understanding"))).toHaveLength(2);
  });

  it("lets readers continue through all specialists without a product-review gate or interruption on completion", async () => {
    const research: NonNullable<Understanding["research"]> = {
      version: 1, status: "running", enabled: true, usage: { searches: 1, competitorScans: 1, modelCalls: 4 },
      steps: researchAgents.map((agent) => ({
        key: agent, agent, status: "completed", findings: [{
          kind: "observation", title: `${researchAgentLabels[agent]} finding`, detail: "Inspect this saved, sourced finding.",
          sources: [{ id: "e_1111111111111111", url: business.website, quote: "We make cotton clothing for everyday wear.", capturedAt: business.createdAt }],
        }], limitations: [], diagnostic: null, startedAt: business.createdAt, completedAt: business.updatedAt, reused: false,
      })),
    };
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const hash = window.location.hash;
    const fetch = vi.fn(async (path: string) => {
      if (path.endsWith("/understanding")) return json({ understanding: null, job: { ...queuedJob, research, preview: null } });
      if (path.endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "application/x-ndjson" } });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch); await renderAgent();
    expect(container.querySelector(".research-agent-heading h4")?.textContent).toBe("Store intelligence");
    expect(container.querySelector(".research-report > .card-heading p")).toBeNull();
    expect(container.querySelector(".research-run-details")).toBeNull();
    expect(container.querySelector(".research-finding")).toBeNull();
    expect(container.querySelectorAll(".agent-briefing")).toHaveLength(1);
    const sourceDetails = container.querySelector<HTMLDetailsElement>(".research-agent-card .agent-briefing .agent-sources")!;
    expect(sourceDetails.open).toBe(false);
    expect(sourceDetails.querySelector("time")?.dateTime).toBe(business.createdAt);
    expect(container.querySelector(".research-finding > .field-note")).toBeNull();
    await act(async () => sourceDetails.querySelector("summary")!.click());
    expect(sourceDetails.open).toBe(true);
    expect(sourceDetails.querySelector("a")?.href).toBe(business.website);
    expect(container.querySelector<HTMLButtonElement>(".research-navigation .secondary-button")?.disabled).toBe(true);
    for (const agent of researchAgents.slice(1)) {
      const next = container.querySelector<HTMLButtonElement>(".research-navigation .primary-link")!;
      expect(next.textContent).toBe(`Next: ${researchAgentLabels[agent]}`);
      await act(async () => next.click());
      expect(container.querySelector(".research-agent-heading h4")?.textContent).toBe(researchAgentLabels[agent]);
      expect(container.querySelector(agent === "competitor" ? ".market-takeaway h5" : ".research-finding h5")?.textContent).toBe(`${researchAgentLabels[agent]} finding`);
      expect(document.activeElement).toBe(container.querySelector(".research-agent-heading h4"));
      if (agent === "competitor") expect(container.querySelector(".market-upgrade button")).toBeNull();
    }
    const heading = container.querySelector(".research-agent-heading h4");
    expect(container.querySelector<HTMLButtonElement>(".research-navigation .primary-link")?.disabled).toBe(true);
    const saved = { ...draft, research: { ...research, status: "complete" as const } };
    await act(async () => {
      stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "job", job: { ...queuedJob, research: saved.research, status: "completed", preview: null, understanding: saved, revision: 3 } })}\n`));
      stream.close();
    });
    expect(container.querySelector(".research-agent-heading h4")).toBe(heading);
    expect(container.querySelector(".research-agent-nav [aria-pressed=true]")?.textContent).toContain("Growth strategy");
    expect(container.querySelector<HTMLDetailsElement>(".agent-product-review")?.open).toBe(false);
    expect(container.querySelector(".agent-product-review summary")?.textContent).toBe("Discovered products (optional)");
    expect(container.querySelector(".agent-product-review")?.textContent).toContain("keep reading the intelligence without importing products");
    await act(async () => container.querySelector<HTMLButtonElement>(".research-navigation .secondary-button")!.click());
    expect(container.querySelector(".research-agent-heading h4")?.textContent).toBe("Product opportunities");
    expect(window.location.hash).toBe(hash);
    expect(fetch.mock.calls.every(([path]) => path.endsWith("/understanding") || path.endsWith("/events"))).toBe(true);
  });

  it("shows Store intelligence once as full guided cards and preserves reading position across specialists", async () => {
    const fullSummary = `${"Cotton clothing for everyday wear. ".repeat(18)}This final sentence must not be clipped.`;
    const research: NonNullable<Understanding["research"]> = {
      version: 1, status: "complete", enabled: true, usage: { searches: 1, competitorScans: 1, modelCalls: 2 },
      steps: (["store", "competitor"] as const).map((agent) => ({
        key: agent, agent, status: "completed", findings: [{
          kind: "observation", title: agent === "store" ? "Your public storefront" : "A competing store",
          detail: agent === "store" ? fullSummary.slice(0, 600) : "This competitor finding remains separate.",
          sources: [{ id: "e_1111111111111111", url: business.website, quote: "We make cotton clothing for everyday wear.", capturedAt: business.createdAt }],
        }], limitations: [], diagnostic: null, startedAt: business.createdAt, completedAt: business.updatedAt, reused: false,
      })),
    };
    const fetch = fetcher({ existing: true, review: { ...draft, research, briefing: {
      ...draft.briefing!, summary: { ...draft.briefing!.summary, text: fullSummary },
    } } });
    await renderAgent();
    expect(container.querySelectorAll(".agent-briefing")).toHaveLength(1);
    expect(container.querySelector(".briefing-card-text")?.textContent).toBe(fullSummary);
    expect(container.querySelector(".research-finding")).toBeNull();
    expect(container.querySelector(".agent-briefing .agent-sources a")?.getAttribute("href")).toBe(business.website);
    await briefingSection("Findings");
    const selectedCard = container.querySelector(".briefing-card");
    expect(selectedCard?.textContent).toContain(draft.briefing!.insights[0].text);
    await act(async () => container.querySelector<HTMLButtonElement>(".research-navigation .primary-link")!.click());
    expect(container.querySelector(".agent-briefing")?.closest("[hidden]")).not.toBeNull();
    expect(container.querySelector(".research-finding")?.textContent).toContain("This competitor finding remains separate.");
    expect(container.textContent).toContain("predates verified-brand research");
    expect(container.querySelector<HTMLDetailsElement>(".research-finding")?.closest("details")?.open).toBe(false);
    expect(container.querySelector(".market-evidence-map")).toBeNull();
    const options = container.querySelector<HTMLDetailsElement>(".market-upgrade .agent-rerun")!;
    expect(options.open).toBe(false);
    expect(container.querySelectorAll(".agent-rerun")).toHaveLength(1);
    await act(async () => options.querySelector<HTMLElement>("summary")!.click());
    expect(options.open).toBe(true);
    expect(options.querySelectorAll("input[type=checkbox]")).toHaveLength(0);
    expect(options.querySelector<HTMLButtonElement>("button.primary-link")?.disabled).toBe(false);
    expect(container.querySelector(".research-agent-heading h4")?.textContent).toBe("Competitor intelligence");
    await act(async () => container.querySelector<HTMLButtonElement>(".research-navigation .secondary-button")!.click());
    expect(container.querySelector(".agent-briefing")?.closest("[hidden]")).toBeNull();
    expect(container.querySelector(".briefing-card")).toBe(selectedCard);
    await briefingSection("Unknowns");
    expect(container.querySelector(".briefing-card")?.textContent).toContain(draft.briefing!.unknowns[0].question);
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it.each([true, false])("starts visual research only on the comparison card action click (previous research: %s)", async (enabled) => {
    const research: NonNullable<Understanding["research"]> = {
      version: 1, status: "complete", enabled, usage: { searches: enabled ? 1 : 0, competitorScans: enabled ? 1 : 0, modelCalls: 2 }, steps: [],
    };
    const fetch = fetcher({ existing: true, review: { ...draft, research } });
    await renderAgent();
    await act(async () => container.querySelector<HTMLButtonElement>(".research-navigation .primary-link")!.click());
    if (!enabled) expect(container.querySelector(".market-upgrade")?.textContent).toContain("New analyses include competitor research automatically.");
    const options = container.querySelector<HTMLDetailsElement>(".market-upgrade .agent-rerun")!;
    await act(async () => options.querySelector<HTMLElement>("summary")!.click());
    const start = options.querySelector<HTMLButtonElement>("button.primary-link")!;
    const posts = () => fetch.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(start.textContent).toContain("Start visual market research");
    expect(start.disabled).toBe(false);
    expect(posts()).toHaveLength(0);
    expect(options.querySelectorAll("input[type=checkbox]")).toHaveLength(0);
    expect(container.querySelectorAll(".agent-rerun")).toHaveLength(1);
    expect(posts()).toHaveLength(0);
    await act(async () => start.click());
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0][1]?.body))).toEqual({ permission: true, research: true, researchVersion: 2 });
  });

  it("leads with a takeaway and action, compares one topic at a time and keeps exact evidence available without paid work", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const base = { agent: "competitor" as const, status: "completed" as const, findings: [], limitations: [], diagnostic: null,
      startedAt: business.createdAt, completedAt: business.updatedAt, reused: false };
    const report: NonNullable<Understanding["research"]> = {
      version: 1, status: "partial", enabled: true, usage: { searches: 1, competitorScans: 2, modelCalls: 9 },
      steps: [
        { ...base, key: "discovery-search-0", search: { query: "protein snack brands India official store", domains: ["rival.example.org", "second.example.org"] } },
        ...["Rival", "Second"].map((name, index) => {
          const url = `https://${name.toLowerCase()}.example.org/`, id = `e_${String(index + 1).repeat(16)}`;
          return { ...base, key: `competitor-brand-${index}`, profile: {
            name, url, marketVerified: index === 0, relevance: "An independent brand with captured protein snack evidence.",
            facts: [
              { dimension: "products" as const, text: `${name} publishes protein snack bars.`, sourceId: id },
              ...(index === 0 ? [{ dimension: "pricing" as const, text: "A six-bar pack costs INR 600.", sourceId: "e_3333333333333333" }] : []),
            ],
            sources: [
              { id, url, quote: `${name} publishes protein snack bars.`, capturedAt: business.createdAt },
              ...(index === 0 ? [{ id: "e_3333333333333333", url: `${url}six-bar-pack`, quote: "A six-bar pack costs INR 600.", capturedAt: business.createdAt }] : []),
            ],
            limitations: ["Delivery and comparable pack prices are not established."],
          } };
        }),
        { ...base, key: "competitor", findings: [
          { kind: "hypothesis", title: "Convenience may be a useful angle", detail: "Validate how customers choose their snack format.",
            sources: [{ id: "e_1111111111111111", url: "https://rival.example.org/", quote: "Rival publishes protein snack bars.", capturedAt: business.createdAt }] },
          { kind: "observation", title: "Both brands lead with protein snack bars", detail: "The captured product claims overlap around protein bars.",
            sources: [{ id: "e_1111111111111111", url: "https://rival.example.org/", quote: "Rival publishes protein snack bars.", capturedAt: business.createdAt }] },
          { kind: "suggestion", title: "Clarify your product promise", detail: "Explain the product need you address before making price claims.",
            sources: [{ id: "e_2222222222222222", url: "https://second.example.org/", quote: "Second publishes protein snack bars.", capturedAt: business.createdAt }] },
          { kind: "suggestion", title: "Check comparable pack sizes", detail: "Do not infer a price advantage from unmatched packs.",
            sources: [{ id: "e_3333333333333333", url: "https://rival.example.org/six-bar-pack", quote: "A six-bar pack costs INR 600.", capturedAt: business.createdAt }] },
        ] },
      ],
    };
    await act(async () => root.render(<ResearchReport report={report} businessName={business.name} briefingKey="comparison-test" />));
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>(".research-agent-nav button"))
      .find((button) => button.textContent?.startsWith("Competitor intelligence"))!.click());
    const brief = container.querySelector('[aria-label="Competitive takeaway"]')!;
    const comparison = container.querySelector('[aria-label="Focused brand comparison"]')!;
    expect(brief.textContent).toContain(business.name);
    expect(brief.querySelector(".market-takeaway h5")?.textContent).toBe("Both brands lead with protein snack bars");
    expect(brief.querySelector(".market-next-move h5")?.textContent).toBe("Clarify your product promise");
    expect(brief.compareDocumentPosition(comparison) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector<HTMLDetailsElement>(".market-more-findings")?.open).toBe(false);
    expect(container.querySelector(".market-more-findings")?.textContent).toContain("Convenience may be a useful angle");
    expect(container.querySelector(".market-more-findings")?.textContent).toContain("Check comparable pack sizes");
    expect(Array.from(container.querySelectorAll("h5")).filter((heading) => heading.textContent === "Clarify your product promise")).toHaveLength(1);
    expect(comparison.querySelectorAll(".market-brand")).toHaveLength(2);
    expect(comparison.querySelector(".market-market-tag.is-confirmed")?.textContent).toBe("Market overlap confirmed");
    expect(comparison.querySelectorAll(".market-market-tag:not(.is-confirmed)")).toHaveLength(1);
    const topics = Array.from(comparison.querySelectorAll<HTMLButtonElement>(".market-topics button"));
    expect(topics.find((button) => button.textContent === "Positioning")?.disabled).toBe(true);
    expect(container.querySelector(".market-selected-fact")).toBeNull();
    expect(Array.from(comparison.querySelectorAll(".market-product-fact")).map((fact) => fact.textContent))
      .toEqual(["Rival publishes protein snack bars.", "Second publishes protein snack bars."]);
    expect(container.textContent).toContain("unknown, not absent");
    expect(container.textContent).toContain("not brand scores");
    const pricing = topics.find((button) => button.textContent === "Published prices and packs")!;
    await act(async () => pricing.click());
    expect(pricing.getAttribute("aria-pressed")).toBe("true");
    expect(comparison.querySelectorAll('.market-topics [aria-pressed="true"]')).toHaveLength(1);
    expect(comparison.querySelector(".market-product-fact")?.textContent).toBe("A six-bar pack costs INR 600.");
    expect(comparison.querySelectorAll(".market-brand")[1].textContent).toContain("Not captured");
    expect(comparison.querySelectorAll(".market-brand")[1].querySelector("button")).toBeNull();
    const source = comparison.querySelector<HTMLButtonElement>(".market-source-button")!;
    await act(async () => source.click());
    const factPanel = container.querySelector<HTMLElement>(".market-selected-fact")!;
    expect(source.getAttribute("aria-controls")).toBe(factPanel.id);
    expect(source.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(factPanel);
    expect(factPanel.querySelector(".section-eyebrow")?.textContent).toBe("Rival / Published prices and packs");
    expect(factPanel.querySelector("blockquote")?.textContent).toBe("A six-bar pack costs INR 600.");
    expect(factPanel.querySelector("a")?.href).toBe("https://rival.example.org/six-bar-pack");
    expect(factPanel.querySelector("time")?.dateTime).toBe(business.createdAt);
    expect(factPanel.textContent).not.toContain("publishes protein snack bars.");
    await act(async () => factPanel.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.querySelector(".market-selected-fact")).toBeNull();
    expect(document.activeElement).toBe(source);
    await act(async () => source.click());
    await act(async () => topics[0].click());
    expect(container.querySelector(".market-selected-fact")).toBeNull();
    expect(comparison.querySelector(".market-product-fact")?.textContent).toBe("Rival publishes protein snack bars.");
    const table = container.querySelector(".market-full-comparison table")!;
    expect(container.querySelector<HTMLDetailsElement>(".market-full-comparison")?.open).toBe(false);
    expect(Array.from(table.querySelectorAll("thead th")).map((cell) => cell.textContent)).toEqual(["Compare", "Rival", "Second"]);
    expect(table.textContent).toContain("Rival publishes protein snack bars.");
    expect(table.textContent).toContain("Not established from captured pages.");
    expect(container.textContent).toContain("a narrow sample, not the whole market");
    expect(container.textContent).not.toContain("Where we searched");
    expect(container.textContent).not.toContain("protein snack brands India official store");
    expect(container.textContent).not.toContain("AI requests");
    const evidence = brief.querySelector<HTMLDetailsElement>(".market-takeaway .agent-sources")!;
    expect(evidence.open).toBe(false);
    await act(async () => evidence.querySelector("summary")!.click());
    expect(evidence.open).toBe(true);
    expect(evidence.querySelector("a")!.href).toBe("https://rival.example.org/");
    expect(container.textContent).not.toContain("e_1111111111111111");
    await act(async () => pricing.click());
    await act(async () => comparison.querySelector<HTMLButtonElement>(".market-source-button")!.click());
    const updated = { ...report, steps: report.steps.filter((step) => step.profile?.name !== "Rival") };
    await act(async () => root.render(<ResearchReport report={updated} businessName={business.name} briefingKey="comparison-test" />));
    expect(container.querySelector(".market-selected-fact")).toBeNull();
    expect(topics[0].getAttribute("aria-pressed")).toBe("true");
    expect(pricing.disabled).toBe(true);
    const secondSource = container.querySelector<HTMLButtonElement>(".market-source-button")!;
    await act(async () => secondSource.click());
    expect(container.querySelector(".market-selected-fact a")?.getAttribute("href")).toBe("https://second.example.org/");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["hypothesis", "none"] as const)("distinguishes a %s summary from an accepted observation", async (kind) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const source = { id: "e_1111111111111111", url: "https://rival.example.org/", quote: "Protein snack bars.", capturedAt: business.createdAt };
    const report: NonNullable<Understanding["research"]> = {
      version: 1, status: "partial", enabled: true, usage: { searches: 1, competitorScans: 1, modelCalls: 2 },
      steps: [{
        key: "competitor-brand-0", agent: "competitor", status: "completed", findings: [], limitations: [], diagnostic: null,
        startedAt: business.createdAt, completedAt: business.updatedAt, reused: false,
        profile: { name: "Rival", url: source.url, marketVerified: false, relevance: "Publishes protein bars.",
          facts: [{ dimension: "products", text: source.quote, sourceId: source.id }], sources: [source], limitations: [] },
      }, {
        key: "competitor", agent: "competitor", status: "limited", diagnostic: null,
        startedAt: business.createdAt, completedAt: business.updatedAt, reused: false,
        findings: kind === "hypothesis" ? [{ kind, title: "Convenience may matter", detail: "Validate this with customers.", sources: [source] }] : [],
        limitations: ["The model provider could not complete this step. Check the server-side Anthropic key, model access and billing. No automatic retry was made."],
      }],
    };
    await act(async () => root.render(<ResearchReport report={report} businessName={business.name} briefingKey="limited-summary" />));
    await act(async () => container.querySelector<HTMLButtonElement>(".research-navigation .primary-link")!.click());
    const brief = container.querySelector(".market-brief")!;
    expect(brief.textContent).not.toContain("What stands out");
    expect(brief.textContent).toContain(kind === "hypothesis" ? "A direction to validate" : "does not yet support a stronger strategic conclusion");
    expect(container.querySelector(".market-next-move")).toBeNull();
    expect(container.querySelector(".market-product-fact")?.textContent).toBe(source.quote);
    const gaps = container.querySelector<HTMLDetailsElement>(".market-research-notes")!;
    expect(gaps.open).toBe(false);
    expect(gaps.textContent).toContain("does not establish a key or billing problem");
    expect(gaps.textContent).not.toContain("Check the server-side Anthropic key");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps per-site diagnostics collapsed when no brand is verified, without inventing comparisons", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const base = { agent: "competitor" as const, findings: [], limitations: [], diagnostic: null,
      startedAt: business.createdAt, completedAt: business.updatedAt, reused: false };
    const report: NonNullable<Understanding["research"]> = {
      version: 1, status: "partial", enabled: true, usage: { searches: 6, competitorScans: 2, modelCalls: 4 },
      steps: [
        { ...base, key: "discovery-plan", status: "completed" },
        { ...base, key: "competitor-site-0", status: "limited", capture: { url: "https://rival.example.org/hair-care", pages: 20 } },
        { ...base, key: "competitor-brand-0", status: "limited",
          diagnostic: { code: "brand_validation", paths: ["candidateOwnBrandStore"] },
          limitations: ["The model could not establish that this is the candidate brand's own store."] },
        { ...base, key: "competitor-site-1", status: "failed", capture: { url: "https://blocked.example.org/", pages: 0 },
          limitations: ["The website's public scanning rules prevented capture."] },
      ],
    };
    await act(async () => root.render(<ResearchReport report={report} businessName={business.name} briefingKey="scan-outcomes" />));
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>(".research-agent-nav button"))
      .find((button) => button.textContent?.startsWith("Competitor intelligence"))!.click());
    const coverage = container.querySelector<HTMLDetailsElement>(".market-research-notes")!;
    expect(coverage.open).toBe(false);
    expect(coverage.textContent).toContain("Sites attempted: 2. Sites captured: 1. Brands verified: 0.");
    await act(async () => coverage.querySelector("summary")!.click());
    expect(coverage.open).toBe(true);
    const outcomes = coverage.querySelectorAll(".market-capture");
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].querySelector("a")?.href).toBe("https://rival.example.org/hair-care");
    expect(outcomes[0].textContent).toContain("20 pages captured");
    expect(outcomes[0].textContent).toContain("Not verified");
    expect(outcomes[0].textContent).toContain("The model could not establish");
    expect(outcomes[1].textContent).toContain("Capture failed");
    expect(outcomes[1].textContent).toContain("0 pages captured");
    expect(outcomes[1].textContent).toContain("public scanning rules");
    expect(container.querySelector(".market-empty")?.textContent).toContain("no brand passed verification in this saved run");
    expect(container.querySelector(".market-heatmap")).toBeNull();
    expect(container.querySelector(".market-landscape")).toBeNull();
    expect(container.querySelector(".market-brief")).toBeNull();
    expect(container.querySelector(".market-battlecards")).toBeNull();
    expect(container.querySelector(".research-limitations")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    await act(async () => root.render(<ResearchReport report={{ ...report, status: "running",
      steps: report.steps.map((step) => step.key === "competitor-brand-0"
        ? { ...step, status: "running", limitations: [], diagnostic: null, completedAt: null } : step),
    }} businessName={business.name} briefingKey="scan-outcomes" />));
    expect(container.querySelector(".market-capture")?.textContent).toContain("Checking brand");
    expect(container.querySelector(".market-capture")?.textContent).not.toContain("The model could not establish");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: "running", enabled: true, message: "Searching and checking brand websites..." },
    { status: "partial", enabled: true, message: "No qualifying independent brand was verified." },
    { status: "complete", enabled: false, message: "This saved analysis covered your store only. New analyses include competitor research automatically." },
  ] as const)("shows an honest empty state for $status research (enabled: $enabled)", async ({ status, enabled, message }) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const report: NonNullable<Understanding["research"]> = {
      version: 1, status, enabled, usage: { searches: 0, competitorScans: 0, modelCalls: 0 }, steps: [],
    };
    await act(async () => root.render(<ResearchReport report={report} businessName={business.name} briefingKey="empty-comparison" />));
    await act(async () => container.querySelector<HTMLButtonElement>(".research-navigation .primary-link")!.click());
    expect(container.querySelector(".market-empty, .market-upgrade")?.textContent).toContain(message);
    expect(container.querySelector(".market-landscape")).toBeNull();
    expect(container.querySelector(".market-heatmap")).toBeNull();
    expect(container.querySelector(".market-selected-fact")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("identifies a planning failure as a search that never started, not an absence of competitors", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const report: NonNullable<Understanding["research"]> = {
      version: 1, status: "partial", enabled: true, usage: { searches: 0, competitorScans: 0, modelCalls: 2 },
      steps: [{
        key: "discovery-plan", agent: "competitor", status: "failed", findings: [], limitations: [],
        diagnostic: { code: "search_plan_evidence", paths: [] }, startedAt: business.createdAt, completedAt: business.updatedAt, reused: false,
      }],
    };
    await act(async () => root.render(<ResearchReport report={report} businessName={business.name} briefingKey="failed-plan" />));
    await act(async () => container.querySelector<HTMLButtonElement>(".research-navigation .primary-link")!.click());
    expect(container.querySelector(".market-empty")?.textContent).toContain("Competitor search could not start");
    expect(container.textContent).not.toContain("No qualifying independent brand was verified");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("distinguishes candidate-selection failure from a completed search with no verified brands", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const report: NonNullable<Understanding["research"]> = {
      version: 1, status: "partial", enabled: true, usage: { searches: 3, competitorScans: 0, modelCalls: 4 },
      steps: [{
        key: "discovery-plan", agent: "competitor", status: "completed", findings: [], limitations: [], diagnostic: null,
        startedAt: business.createdAt, completedAt: business.updatedAt, reused: false,
      }, {
        key: "discovery", agent: "competitor", status: "failed", findings: [], limitations: [],
        diagnostic: { code: "output_validation", paths: ["indices.5"] },
        startedAt: business.createdAt, completedAt: business.updatedAt, reused: false,
      }],
    };
    await act(async () => root.render(<ResearchReport report={report} businessName={business.name} briefingKey="failed-selection" />));
    await act(async () => container.querySelector<HTMLButtonElement>(".research-navigation .primary-link")!.click());
    expect(container.querySelector(".market-empty")?.textContent).toContain("candidate selection could not finish");
    expect(container.querySelector(".market-empty")?.textContent).toContain("not evidence that your business has no competitors");
    expect(container.textContent).not.toContain("No qualifying independent brand was verified");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes a rejected Store preview while other specialists continue without promising more cards", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const report: NonNullable<Understanding["research"]> = {
      version: 1, status: "running", enabled: true, usage: { searches: 0, competitorScans: 0, modelCalls: 2 },
      steps: [{
        key: "store", agent: "store", status: "running", findings: [], limitations: [],
        diagnostic: null, startedAt: business.createdAt, completedAt: null, reused: false,
      }],
    };
    const preview = { summary: { text: "A provisional Store summary that was rejected." } };
    const render = (value: typeof report) => act(async () => root.render(
      <ResearchReport report={value} businessName={business.name} briefing={preview} briefingKey="failed-store" />,
    ));
    await render(report);
    expect(container.textContent).toContain(preview.summary.text);
    expect(container.textContent).toContain("More cards may arrive");
    await render({ ...report, steps: [{ ...report.steps[0], status: "failed", completedAt: business.updatedAt,
      diagnostic: { code: "model_incomplete", paths: [] }, limitations: ["The Store briefing could not be validated."] }] });
    expect(container.textContent).toContain("The Store briefing could not be validated");
    expect(container.textContent).not.toContain(preview.summary.text);
    expect(container.textContent).not.toContain("being written");
    expect(container.textContent).not.toContain("More cards");
    expect(container.querySelector(".agent-briefing")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not substitute an older briefing for accepted Store findings from a newer stopped run", async () => {
    const research: NonNullable<Understanding["research"]> = {
      version: 1, status: "partial", enabled: true, usage: { searches: 0, competitorScans: 0, modelCalls: 1 },
      steps: [{
        key: "store", agent: "store", status: "completed", findings: [{
          kind: "observation", title: "Your public storefront", detail: "Newly accepted Store findings from this attempt.",
          sources: [{ id: "e_1111111111111111", url: business.website, quote: "We make cotton clothing for everyday wear.", capturedAt: business.createdAt }],
        }], limitations: [], diagnostic: null, startedAt: business.createdAt, completedAt: business.updatedAt, reused: false,
      }],
    };
    const fetch = vi.fn(async () => json({ understanding: draft, job: {
      ...queuedJob, status: "cancelled", preview: null, research, error: "This newer attempt was cancelled.",
    } }));
    vi.stubGlobal("fetch", fetch); await renderAgent();
    expect(container.querySelector(".research-agent-card .briefing-card-text")?.textContent).toBe("Newly accepted Store findings from this attempt.");
    expect(container.querySelector(".research-agent-card .agent-sources a")?.getAttribute("href")).toBe(business.website);
    const previous = Array.from(container.querySelectorAll<HTMLDetailsElement>("details"))
      .find((details) => details.querySelector("summary")?.textContent === "Previous saved briefing")!;
    expect(previous.open).toBe(false);
    expect(previous.textContent).toContain(draft.briefing!.summary.text);
    expect(container.querySelector('[role=alert]')?.textContent).toBe("This newer attempt was cancelled.");
    expect(fetch.mock.calls).toHaveLength(2);
  });

  it("reopens the last accepted briefing prominently after a failed Store refresh without mixing sources or enabling historical approvals", async () => {
    const previous = { ...draft, briefing: { ...draft.briefing, summary: {
      text: "The previously accepted business summary.",
      sources: [{ url: `${business.website}old-collection`, quote: "Previously captured cotton clothing." }],
    } } };
    const research: NonNullable<Understanding["research"]> = {
      version: 1, status: "partial", enabled: true, usage: { searches: 3, competitorScans: 2, modelCalls: 9 },
      steps: [{ key: "store", agent: "store", status: "failed", findings: [], limitations: [
        "The AI provider could not complete this request. Check the server's Anthropic key, model access and billing, then retry. Your profile is unchanged.",
      ],
        diagnostic: { code: "model_incomplete", paths: [] }, startedAt: business.createdAt, completedAt: business.updatedAt, reused: false }],
    };
    const current: Understanding = { ...draft, id: "c6edcdb0-c6fb-44e1-a26d-dbc5c3a9d011", briefing: null, suggestions: [], productImportId: null, research };
    const fetch = vi.fn(async (_path: string, _options?: RequestInit) => json({
      understanding: current, lastSuccessfulUnderstanding: previous,
      job: { ...queuedJob, status: "completed", preview: null, research, understanding: current },
    }));
    vi.stubGlobal("fetch", fetch);
    await renderAgent();
    expect(container.querySelector('[aria-label="Last successful Store briefing"]')?.textContent).toContain("previous accepted result");
    expect(container.querySelector('time')?.dateTime).toBe(previous.createdAt);
    expect(container.querySelector(".research-agent-card .briefing-card-text")?.textContent).toBe(previous.briefing.summary.text);
    expect(container.querySelector(".research-agent-card .agent-sources a")?.getAttribute("href")).toBe(previous.briefing.summary.sources[0].url);
    expect(container.querySelector(".research-agent-nav button")?.textContent).toContain("Needs attention - 0 findings");
    expect(container.querySelector(".research-agent-card")?.textContent).toContain("The cards below are your last successful briefing, not the output of this failed attempt.");
    expect(container.querySelector(".research-limitations summary")?.textContent).toBe("Analysis issues and evidence gaps");
    expect(container.querySelector(".research-limitations")?.textContent).toContain("specific cause was not recorded");
    expect(container.textContent).not.toContain("Check the server's Anthropic key");
    expect(container.querySelector(".agent-profile-form")).toBeNull();
    expect(container.querySelector(".research-agent-card .agent-briefing")?.closest("details")?.className).toBe("specialist-archive");
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("shows a partial accepted insight as a finding rather than fabricating a missing business summary", async () => {
    const review: Understanding = { ...draft, briefing: { ...draft.briefing, summary: undefined },
      validationIssues: [{ path: "briefing.summary.sources", code: "invalid_reference" }] };
    fetcher({ existing: true, review });
    await renderAgent();
    expect(container.querySelector(".briefing-card-text")?.textContent).toBe(draft.briefing.insights[0].text);
    expect(container.querySelector(".briefing-card")?.textContent).toContain("What you offer");
    expect(container.querySelector(".agent-findings")?.textContent).toContain("Some proposed sections could not be validated");
    expect(container.textContent).not.toContain(draft.briefing.summary.text);
  });

  it("clears retained results when switching the business website and respects an explicit null retained snapshot", async () => {
    let changed = false;
    const fetch = vi.fn(async () => json({
      understanding: changed ? null : draft, lastSuccessfulUnderstanding: changed ? null : draft, job: null,
    }));
    vi.stubGlobal("fetch", fetch);
    await renderAgent();
    expect(container.textContent).toContain(draft.briefing.summary.text);
    changed = true;
    await act(async () => root.render(<StrictMode><BusinessAgentReview business={{ ...business, website: "https://different.example.org/" }}
      autoStart={false} onSaved={vi.fn()} onRecorded={vi.fn()} onSessionExpired={expired} /></StrictMode>));
    expect(container.textContent).not.toContain(draft.briefing.summary.text);
    expect(container.querySelector(".agent-briefing")).toBeNull();
    expect(container.querySelector(".agent-profile-form")).toBeNull();
  });

  it("keeps live Store cards unverified and preserves the selected card when checked evidence arrives", async () => {
    const research: NonNullable<Understanding["research"]> = {
      version: 1, status: "running", enabled: true, usage: { searches: 0, competitorScans: 0, modelCalls: 1 },
      steps: [{
        key: "store", agent: "store", status: "completed", findings: [{
          kind: "observation", title: "Your public storefront", detail: "An accepted summary, not the live card's text.",
          sources: [{ id: "e_1111111111111111", url: business.website, quote: "We make cotton clothing for everyday wear.", capturedAt: business.createdAt }],
        }], limitations: [], diagnostic: null, startedAt: business.createdAt, completedAt: business.updatedAt, reused: false,
      }],
    };
    const preview = {
      summary: { text: "A provisional Store summary." },
      insights: [{ area: "offering", text: "A provisional Store observation." }],
    };
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn(async (path: string) => {
      if (path.endsWith("/understanding")) return json({ understanding: null, job: { ...queuedJob, research, preview } });
      if (path.endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "application/x-ndjson" } });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch); await renderAgent();
    expect(container.querySelectorAll(".agent-briefing")).toHaveLength(1);
    expect(container.querySelector(".briefing-card-text")?.textContent).toBe(preview.summary.text);
    expect(container.querySelector(".research-agent-card")?.textContent).toContain("sources have not been checked");
    expect(container.querySelector(".research-agent-card")?.textContent).not.toContain("being written");
    expect(container.querySelector(".research-agent-card")?.textContent).not.toContain("More cards may arrive");
    expect(container.querySelector(".research-agent-card a")).toBeNull();
    await briefingSection("Findings");
    const selectedCard = container.querySelector(".briefing-card");
    expect(selectedCard?.textContent).toContain(preview.insights[0].text);
    const saved = { ...draft, research: { ...research, status: "complete" as const } };
    await act(async () => {
      stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "job", job: { ...queuedJob, research: saved.research, status: "completed", preview: null, understanding: saved, revision: 3 } })}\n`));
      stream.close();
    });
    expect(container.querySelector(".briefing-card")).toBe(selectedCard);
    expect(selectedCard?.textContent).toContain(draft.briefing!.insights[0].text);
    expect(selectedCard?.querySelector("a")?.getAttribute("href")).toBe(business.website);
    expect(container.querySelector(".research-agent-card")?.textContent).not.toContain("sources have not been checked");
    expect(container.querySelectorAll(".agent-briefing")).toHaveLength(1);
    expect(fetch.mock.calls.every(([path]) => path.endsWith("/understanding") || path.endsWith("/events"))).toBe(true);
  });

  it("disconnects only the viewer when leaving and does not rerun a completed job even with auto-start on return", async () => {
    let latest = queuedJob;
    let viewer: AbortSignal | undefined;
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/understanding")) return json({ understanding: draft, job: latest });
      if (path.endsWith("/events")) {
        viewer = options!.signal!;
        return new Response(new ReadableStream({
          start(controller) { viewer!.addEventListener("abort", () => controller.error(viewer!.reason), { once: true }); },
        }), { headers: { "Content-Type": "application/x-ndjson" } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch); await renderAgent(true);
    await act(async () => root.render(<p>Away from the business</p>));
    expect(viewer?.aborted).toBe(true);
    latest = { ...queuedJob, status: "completed", understanding: draft, preview: null, revision: 3 };
    await renderAgent(true);
    expect(container.textContent).toContain(draft.briefing!.summary.text);
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("restores an interrupted job without rerunning it and explicitly retries with its saved scan checkpoint", async () => {
    const checkpoint = "aac3f63e-0b66-4cad-823e-dcd8d7e4f000";
    const failed: AnalysisJob = { ...queuedJob, status: "interrupted", scanId: checkpoint, preview: null, error: "Worker stopped; retry explicitly." };
    const retry = { ...queuedJob, id: "e00f4776-1a44-4ea6-9a9f-6ae93dc12a09", status: "queued" as const, scanId: checkpoint };
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/understanding")) return options?.method === "POST" ? jobResponse(retry) : json({ understanding: draft, job: failed });
      if (path.endsWith("/events")) return jobResponse({ ...retry, status: "completed", preview: null, understanding: draft, revision: 4 });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch); await renderAgent(true);
    expect(container.textContent).toContain("Worker stopped; retry explicitly.");
    expect(container.textContent).toContain(draft.briefing!.summary.text);
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-controls button")!.click());
    const posts = fetch.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]!.body))).toEqual({ permission: true, scanId: checkpoint, research: true, researchVersion: 2 });
  });

  it.each(["completed", "failed", "interrupted", "cancelled"] as const)("restores a newer %s job instead of automatically analysing older onboarding evidence", async (status) => {
    const restored: AnalysisJob = {
      ...queuedJob, status, scanId: status === "failed" ? null : "aac3f63e-0b66-4cad-823e-dcd8d7e4f000",
      preview: null, understanding: status === "completed" ? draft : null,
      error: status === "completed" ? null : "Stopped; retry explicitly.",
    };
    const fetch = vi.fn(async (_path: string, _options?: RequestInit) => json({ understanding: draft, job: restored }));
    vi.stubGlobal("fetch", fetch);
    await renderAgent(true, { scanId: draft.scanId, scanCapturedAt: "2026-11-16T11:59:00.000Z" });
    expect(container.textContent).toContain(draft.briefing!.summary.text);
    if (status !== "completed") expect(container.textContent).toContain("Stopped; retry explicitly.");
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("analyses newly consented onboarding evidence even when an older job has already completed", async () => {
    const previous = { ...queuedJob, status: "completed" as const, understanding: draft, preview: null };
    const scanId = "aac3f63e-0b66-4cad-823e-dcd8d7e4f000";
    const next = { ...draft, scanId, createdAt: "2026-11-16T12:02:00.000Z" };
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/understanding")) return options?.method === "POST"
        ? jobResponse({ ...previous, id: "e00f4776-1a44-4ea6-9a9f-6ae93dc12a09", scanId, understanding: next })
        : json({ understanding: draft, job: previous });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);
    await renderAgent(true, { scanId, scanCapturedAt: "2026-11-16T12:01:00.000Z" });
    const posts = fetch.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]!.body))).toEqual({ permission: true, scanId, research: true, researchVersion: 2 });
  });

  it("cancels only on an explicit click and keeps the previous saved briefing", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const stopped: AnalysisJob = { ...queuedJob, status: "cancelled", preview: null, error: "Analysis cancelled. Your profile is unchanged.", revision: 3 };
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/understanding")) return json({ understanding: draft, job: queuedJob });
      if (path.endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "application/x-ndjson" } });
      if (path.endsWith("/cancel") && options?.method === "POST") {
        stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "job", job: stopped })}\n`)); stream.close();
        return json({ job: stopped });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch); await renderAgent();
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Cancel analysis")!.click());
    expect(container.textContent).toContain("Your analysis was cancelled.");
    expect(container.textContent).toContain(draft.briefing!.summary.text);
    const posts = fetch.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts).toHaveLength(1); expect(posts[0][0]).toContain(`/analysis-jobs/${queuedJob.id}/cancel`);
  });

  it("keeps the original idempotency key when explicitly retrying an unacknowledged submission", async () => {
    let attempts = 0;
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/understanding") && options?.method === "POST") {
        if (++attempts === 1) throw new TypeError("Submission response was lost");
        return jobResponse({ ...queuedJob, status: "completed", understanding: draft, preview: null, revision: 3 });
      }
      if (path.endsWith("/understanding")) return json({ understanding: null, job: null });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch); await renderAgent(true);
    expect(container.textContent).toContain("Submission response was lost"); expect(attempts).toBe(1);
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-controls button")!.click());
    const posts = fetch.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts).toHaveLength(2);
    const key = (options?: RequestInit) => new Headers(options?.headers).get("Idempotency-Key");
    expect(key(posts[0][1])).toBeTruthy(); expect(key(posts[1][1])).toBe(key(posts[0][1]));
    expect(container.textContent).toContain(draft.briefing!.summary.text);
  });

  it("allows reconnection without renewed scan consent or another paid submission after a viewer error", async () => {
    let connections = 0;
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/understanding")) return json({ understanding: draft, job: queuedJob });
      if (path.endsWith("/events")) return ++connections === 1 ? json({ error: "Viewer connection unavailable" }, 503)
        : jobResponse({ ...queuedJob, status: "completed", preview: null, understanding: draft, revision: 3 });
      throw new Error(`Unexpected request: ${path} ${options?.method}`);
    });
    vi.stubGlobal("fetch", fetch); await renderAgent();
    expect(container.textContent).toContain("Viewer connection unavailable");
    const reconnect = container.querySelector<HTMLButtonElement>(".agent-controls button")!;
    expect(reconnect.textContent).toContain("Reconnect to analysis"); expect(reconnect.disabled).toBe(false);
    expect(container.querySelector(".agent-controls input[type=checkbox]")).toBeNull();
    await act(async () => reconnect.click());
    expect(container.textContent).not.toContain("Viewer connection unavailable");
    expect(container.textContent).toContain(draft.briefing!.summary.text);
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("leads with a saved briefing, explains significance and gaps, and keeps profile editing secondary", async () => {
    fetcher({ existing: true, review: { ...draft, warnings: ["The crawl stopped at its page/time limit.", "No supported schema.org Product JSON-LD was captured."] } }); await render();
    const briefing = container.querySelector(".agent-briefing")!;
    const editor = container.querySelector(".agent-profile-editor")!;
    expect(briefing.textContent).toContain(draft.briefing!.summary.text);
    expect(briefing.textContent).not.toContain(draft.briefing!.insights[0].text);
    await briefingSection("Findings");
    expect(briefing.textContent).toContain("Why it matters");
    expect(briefing.textContent).toContain(draft.briefing!.insights[0].whyItMatters);
    expect(briefing.querySelector("a")?.getAttribute("href")).toBe(business.website);
    await briefingSection("Unknowns");
    expect(briefing.textContent).toContain(draft.briefing!.unknowns[0].question);
    await briefingSection("Next moves");
    expect(briefing.textContent).toContain(draft.briefing!.nextSteps[0].action);
    expect(briefing.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editor.hasAttribute("open")).toBe(false);
    expect(container.textContent).toContain("briefing is saved automatically");
    expect(container.textContent).not.toContain("Nothing is applied until you save");
    expect(container.textContent).not.toContain("Technical scan limits");
    expect(container.textContent).not.toContain("Product JSON-LD was captured");
    expect(container.textContent).not.toContain("page/time limit");
  });

  it.each([null, draft.productImportId])("omits technical coverage diagnostics while retaining sources and useful unknowns with import %s", async (productImportId) => {
    const fetch = fetcher({ existing: true, review: { ...draft, productImportId, evidenceCoverage: {
      pagesProvided: 20, productRecordsCaptured: 140, productRecordsProvided: 100, inputBytes: 200_000, limited: true,
      limitations: ["Static HTML only.", "Evidence excerpts or product fields were shortened/omitted for https://shop.example.com/pages/faqs."],
    } } });
    await render();
    expect(container.querySelector(".agent-coverage")).toBeNull();
    expect(container.textContent).not.toContain("View sources and limitations");
    expect(container.textContent).not.toContain("Based on 20 website pages");
    expect(container.textContent).not.toContain("captured product records");
    expect(container.textContent).not.toContain("Static HTML only");
    expect(container.textContent).not.toContain("shortened/omitted");
    expect(container.textContent).not.toContain("no catalogue import draft was prepared");
    const evidence = container.querySelector<HTMLDetailsElement>(".agent-briefing .agent-sources")!;
    await act(async () => evidence.querySelector("summary")!.click());
    expect(evidence.open).toBe(true);
    expect(evidence.querySelector("a")?.getAttribute("href")).toBe(business.website);
    await briefingSection("Unknowns");
    expect(container.querySelector(".briefing-card")?.textContent).toContain(draft.briefing!.unknowns[0].question);
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it.each([true, false])("shows live text before completion and handles final success=%s without exposing unverified saves", async (success) => {
    const fetch = fetcher({ existing: true }); await render();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "application/x-ndjson" } });
    fetch.mockResolvedValueOnce(response);
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-controls button")!.click());
    const send = async (data: unknown) => act(async () => { stream.enqueue(new TextEncoder().encode(`${JSON.stringify(data)}\n`)); });
    await send({ type: "phase", phase: "analysing" });
    expect(container.querySelector(".agent-progress")?.textContent).toContain("Writing your business briefing");
    await send({ type: "briefing", briefing: { summary: { text: "A live" } } });
    expect(container.querySelector(".agent-live")?.textContent).toContain("A live");
    await send({ type: "briefing", briefing: { summary: { text: "A live business summary" } } });
    expect(container.querySelector(".agent-live")?.textContent).toContain("A live business summary");
    expect(container.querySelector(".agent-live")?.textContent).toContain("not been saved as a completed briefing");
    expect(container.querySelector(".agent-live a")).toBeNull();
    expect(container.querySelector(".agent-profile-form")).toBeNull();
    expect(container.querySelector(".agent-findings")).toBeNull();
    await send({ type: "briefing", briefing: { summary: { text: "A live business summary" }, insights: [{ area: "offering", text: "A live observation" }] } });
    await briefingSection("Findings");
    expect(container.querySelector(".briefing-card")?.textContent).toContain("A live observation");
    if (success) await send({ type: "complete", understanding: draft });
    else await send({ type: "error", status: 502, message: "The agent returned an unsupported source citation." });
    await act(async () => stream.close());
    expect(container.querySelector(".agent-live")).toBeNull();
    expect(container.querySelector(".agent-briefing")?.textContent).toContain(draft.briefing!.insights[0].text);
    expect(container.querySelector(".agent-review [role=alert]")?.textContent ?? "").toBe(success ? "" : "The agent returned an unsupported source citation.");
    if (!success) expect(container.querySelector(".agent-findings")?.textContent).toContain("Previous saved analysis");
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/apply"))).toBe(false);
    expect(fetch.mock.calls.find(([, options]) => options?.method === "POST")?.[1]?.headers).toMatchObject({ Accept: "application/x-ndjson" });
  });

  it("shows a briefing-only result as useful analysis without requiring a profile save", async () => {
    const fetch = fetcher({ existing: true, review: { ...draft, suggestions: [], productImportId: null } }); await render();
    expect(container.querySelector(".agent-briefing")).not.toBeNull();
    expect(container.querySelector(".agent-profile-form")).toBeNull();
    expect(container.textContent).not.toContain("No supported findings yet");
    expect(container.querySelector(".agent-rerun")?.hasAttribute("open")).toBe(false);
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("labels legacy profile-only results honestly and fixes the old scanner warning without a paid request", async () => {
    const fetch = fetcher({ existing: true, review: { ...draft, briefing: null, warnings: ["Static public HTML only: no JavaScript execution, authentication, AI analysis, or website changes."] } }); await render();
    expect(container.querySelector("#agent-heading")?.textContent).toBe("Saved profile suggestions.");
    expect(container.querySelector(".agent-legacy-note")?.textContent).toContain("does not include a business briefing");
    expect(container.querySelector(".agent-briefing")).toBeNull();
    expect(container.querySelector(".agent-limitations")).toBeNull();
    expect(container.textContent).not.toContain("no JavaScript execution");
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("saves reviewed details once without checkboxes, a second form or another paid analysis", async () => {
    const fetch = fetcher(); await create();
    await briefingSection("Findings");
    expect(container.querySelector<HTMLTextAreaElement>('[name="agentDescription"]')?.value).toBe(draft.suggestions[0].value);
    await act(async () => container.querySelector(".agent-profile-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const writes = fetch.mock.calls.filter(([path]) => path.endsWith("/apply"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({ category: business.category, description: draft.suggestions[0].value, expectedUpdatedAt: business.updatedAt });
    expect(container.querySelector(".saved-profile-details")?.textContent).toContain(draft.suggestions[0].value);
    expect(container.querySelector("#agent-heading")?.textContent).toBe("Your business understanding is saved.");
    expect(container.querySelector(".agent-profile-form")).toBeNull();
    expect(container.querySelector(".agent-briefing")).not.toBeNull();
    expect(container.querySelector(".briefing-card")?.textContent).toContain(draft.briefing!.insights[0].text);
    expect(container.querySelector("form.profile-card")).toBeNull();
    expect(fetch.mock.calls.filter(([path, options]) => path.endsWith("/understanding") && options?.method === "POST")).toHaveLength(1);
  });

  it("restores a completed review without showing the same suggestions or opening rerun consent", async () => {
    const fetch = fetcher({ existing: true, review: { ...draft, reviewedAt: business.updatedAt } });
    await render();
    expect(container.querySelector("#agent-heading")?.textContent).toBe("Your business understanding is saved.");
    expect(container.querySelector(".agent-profile-form")).toBeNull();
    expect(container.querySelector(".agent-suggestion input")).toBeNull();
    expect(container.querySelector(".agent-rerun")?.hasAttribute("open")).toBe(false);
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("lets owners edit the proposed text in place before the one save", async () => {
    const fetch = fetcher({ existing: true }); await render();
    const text = "Owner-corrected business description.";
    await act(async () => {
      const input = container.querySelector<HTMLTextAreaElement>('[name="agentDescription"]')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector(".agent-profile-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const write = fetch.mock.calls.find(([path]) => path.endsWith("/apply"));
    expect(JSON.parse(String(write?.[1]?.body)).description).toBe(text);
    expect(container.querySelector(".saved-profile-details")?.textContent).toContain(text);
  });

  it("retains edits and shows an explicit error when saving fails", async () => {
    const fetch = fetcher({ existing: true }); await render();
    fetch.mockResolvedValueOnce(json({ error: "Your business profile has changed. Reload it before saving." }, 409));
    await act(async () => container.querySelector(".agent-profile-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector(".agent-review [role=alert]")?.textContent).toContain("profile has changed");
    expect(container.querySelector<HTMLTextAreaElement>('[name="agentDescription"]')?.value).toBe(draft.suggestions[0].value);
    expect(container.querySelector("#agent-heading")?.textContent).toBe("Your changes haven't been saved yet.");
    expect(container.querySelector(".saved-profile-details")?.textContent).toContain("Owner description");
  });

  it("saves a profile without a website without starting analysis", async () => {
    const fetch = fetcher({ website: "" }); await render();
    await set("businessName", business.name);
    expect(container.querySelector("#profile-analysis-notice")).toBeNull();
    await save();
    expect(container.querySelector(".saved-profile")).not.toBeNull();
    expect(fetch.mock.calls.some(([path, options]) => path.endsWith("/understanding") && options?.method === "POST")).toBe(false);
    expect(container.querySelector(".agent-review")).toBeNull();
  });

  it("leaves a saved profile intact and explains missing agent configuration", async () => {
    const fetch = fetcher({ failure: true }); await create();
    expect(container.querySelector(".saved-profile-details")?.textContent).toContain(business.name);
    expect(container.querySelector(".agent-review [role=alert]")?.textContent).toContain("ANTHROPIC_API_KEY");
    expect(container.querySelector("#agent-heading")?.textContent).toBe("This analysis couldn't finish.");
    expect(container.querySelector(".agent-findings")).toBeNull();
    expect(container.textContent).toContain("Retry business agent");
    fetch.mockResolvedValueOnce(streamed(draft));
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-controls button")!.click());
    expect(container.querySelector(".agent-review [role=alert]")).toBeNull();
    expect(container.querySelector(".agent-findings")).not.toBeNull();
  });

  it("restores saved reviews without another paid run and links to the right product draft", async () => {
    const fetch = fetcher({ existing: true }); await render();
    expect(container.querySelector(".agent-findings")).not.toBeNull();
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    expect(container.querySelector<HTMLDetailsElement>(".agent-product-review")?.open).toBe(false);
    expect(container.querySelector<HTMLAnchorElement>('.agent-findings a[href^="#products"]')?.getAttribute("href")).toBe(`#products?business=${business.id}&import=${draft.productImportId}`);
  });

  it("shows a restored failed scan as an analysis failure with its reason and an explicit retry", async () => {
    const fetch = fetcher({ existing: true, review: { ...draft, scanStatus: "failed", suggestions: [], productImportId: null, warnings: ["Response exceeds the 1048576-byte limit."] } });
    await render();
    expect(container.querySelector("#agent-heading")?.textContent).toBe("I couldn't analyse this website.");
    expect(container.querySelector(".agent-findings [role=alert]")?.textContent).toContain("AI analysis could not run");
    expect(container.querySelector(".agent-limitations")).toBeNull();
    expect(container.textContent).not.toContain("1048576-byte limit");
    expect(container.querySelector('.agent-findings a[href="#website"]')).not.toBeNull();
    expect(container.querySelector(".agent-suggestion")).toBeNull();
    expect(container.textContent).not.toContain("Here's what I found");
    expect(container.textContent).not.toContain("Draft from");
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    fetch.mockResolvedValueOnce(streamed(draft));
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-controls button")!.click());
    expect(container.querySelector("#agent-heading")?.textContent).toContain("Your business, explained.");
    expect(container.querySelector(".agent-findings [role=alert]")).toBeNull();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it("distinguishes readable pages with no supported findings from failed and successful analyses", async () => {
    fetcher({ existing: true, review: { ...draft, briefing: null, suggestions: [], productImportId: null } });
    await render();
    expect(container.querySelector("#agent-heading")?.textContent).toBe("No supported findings yet.");
    expect(container.querySelector(".agent-findings [role=status]")?.textContent).toContain("Public pages were read");
    expect(container.querySelector(".agent-findings [role=alert]")).toBeNull();
    expect(container.querySelector(".agent-suggestion")).toBeNull();
    expect(container.textContent).not.toContain("Here's what I found");
    expect(container.textContent).toContain("Try business analysis again");
  });

  it("labels partial findings without hiding the usable review cards", async () => {
    fetcher({ existing: true, review: { ...draft, scanStatus: "partial" } });
    await render();
    expect(container.querySelector("#agent-heading")?.textContent).toContain("partial scan");
    expect(container.querySelector(".agent-findings [role=status]")?.textContent).toContain("Some pages could not be read");
    expect(container.querySelector(".agent-suggestion")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".agent-profile-form button[type=submit]")?.disabled).toBe(false);
  });

  it("keeps product-only findings reviewable rather than labeling them an empty analysis", async () => {
    fetcher({ existing: true, review: { ...draft, briefing: null, suggestions: [] } });
    await render();
    expect(container.querySelector("#agent-heading")?.textContent).toContain("Product listings are ready for review");
    expect(container.querySelector<HTMLAnchorElement>('.agent-findings a[href^="#products"]')).not.toBeNull();
    expect(container.textContent).not.toContain("No supported findings");
  });

  it("labels old findings as a previous saved analysis when a refresh fails", async () => {
    const fetch = fetcher({ existing: true });
    await render();
    fetch.mockResolvedValueOnce(json({ error: "The AI provider could not complete this request." }, 502));
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-controls button")!.click());
    expect(container.querySelector("#agent-heading")?.textContent).toBe("This analysis couldn't finish.");
    expect(container.querySelector(".agent-findings")?.textContent).toContain("Previous saved analysis");
    expect(container.querySelector(".agent-suggestion")).not.toBeNull();
    expect(container.querySelector(".agent-review [role=alert]")?.textContent).toContain("AI provider");
  });

  it("cancels the request when leaving the business instead of leaking results into another profile", async () => {
    const fetch = fetcher();
    let activeSignal: AbortSignal | undefined;
    fetch.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === "/api/businesses") return json({ businesses: [business] });
      if (path.endsWith("/activity")) return json({ activities: [] });
      if (path.endsWith("/evidence")) return json({ evidence: [] });
      if (options?.method === "POST") { activeSignal = options.signal ?? undefined; return new Promise<Response>(() => {}); }
      return json({ understanding: null });
    });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-controls button")!.click());
    expect(container.querySelector(".agent-review [role=status]")?.textContent).toContain("Connecting to your business agent");
    expect(activeSignal?.aborted).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>(".business-toolbar button")!.click());
    expect(activeSignal?.aborted).toBe(true);
    expect(container.querySelector(".agent-review")).toBeNull();
  });
});
