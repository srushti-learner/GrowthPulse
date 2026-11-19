// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FirstVisit } from "./FirstVisit";
import type { OnboardingPreview } from "../shared/onboarding";
import type { Understanding } from "../shared/understanding";
import type { AnalysisJob } from "../shared/analysis";

const user = { id: "509e12ce-3028-4ed1-bdf7-329a26d470d8", name: "Test Owner", email: "owner@example.test" };
const timestamp = "2026-11-16T12:00:00.000Z";
const business = { id: "02a221ee-41f1-46c9-bc96-12401d8dcf73", name: "shop.example.com", website: "https://shop.example.com/",
  category: "", description: "", createdAt: timestamp, updatedAt: timestamp };
const preview: OnboardingPreview = {
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  scan: { requestedUrl: business.website, status: "complete", startedAt: timestamp, completedAt: timestamp,
    pages: [{ url: business.website, capturedAt: timestamp, title: "Fixture shop", description: "Cotton clothing for everyday wear.",
      text: "Cotton clothing for everyday wear.", headings: [], contacts: [], callsToAction: [], links: [], warnings: [] }], failures: [], notes: [] },
};
const review = {
  id: "63243bee-1f3a-40db-a516-93b04d40f797", businessId: business.id, scanId: "bdc0f304-3b01-4542-824a-7995d482b81c",
  scanStatus: "complete", reviewedAt: null, createdAt: timestamp, productImportId: null, warnings: [],
  briefing: {
    summary: { text: "This website presents everyday cotton clothing.", sources: [{ url: business.website, quote: preview.scan.pages[0].text }] },
    insights: [{ area: "offering", text: "The stated use case is everyday wear.", whyItMatters: "This explains the intended use.",
      sources: [{ url: business.website, quote: preview.scan.pages[0].text }] }],
    unknowns: [{ question: "What are the delivery costs?", whyItMatters: "These pages do not establish the full purchase cost." }],
    nextSteps: [{ action: "Review delivery information.", reason: "Confirm the total buying commitment." },
      { action: "Check sizing information.", reason: "Confirm how shoppers choose a size." }],
  },
  suggestions: [{ field: "description", value: preview.scan.pages[0].text, sources: [{ url: business.website, quote: preview.scan.pages[0].text }] }],
} satisfies Understanding;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("signed-in website onboarding", () => {
  let container: HTMLDivElement, root: Root;
  const expired = vi.fn();
  beforeEach(() => {
    expired.mockReset();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.history.replaceState(null, "", "/#overview");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render() { await act(async () => root.render(<StrictMode><FirstVisit onSessionExpired={expired} /></StrictMode>)); }
  async function click(selector: string) { await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click()); }
  async function set(name: string, value: string) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
      const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit(selector: string) {
    await act(async () => container.querySelector(selector)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }
  async function startAnalysis() {
    await click('.first-visit button[type="submit"]');
  }
  function fetcher({ restored = null, authenticated = false, previous = null, scanReply = preview, claimStatus = 200 }: {
    restored?: OnboardingPreview | null; authenticated?: boolean; previous?: Understanding | null;
    scanReply?: OnboardingPreview | null; claimStatus?: number;
  } = {}) {
    let cached = restored, savedReview = previous, savedBusiness = business, signedIn = authenticated;
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/health") return json({ status: "ok", service: "growthpulse-api", database: { engine: "sqlite", status: "ok" } });
      if (path === "/api/auth/me") return signedIn ? json({ user }) : json({ error: "Please log in to continue." }, 401);
      if (path === "/api/auth/login" || path === "/api/auth/register") { signedIn = true; return json({ user }); }
      if (path === "/api/auth/logout") { signedIn = false; cached = null; return new Response(null, { status: 204 }); }
      if (path === "/api/onboarding/preview") return json({ preview: cached });
      if (path === "/api/onboarding/scan") { cached = scanReply; return json({ preview: cached }); }
      if (path === "/api/onboarding/claim") return claimStatus !== 200 ? json({ error: "Your public findings have expired. Read the website again to continue." }, claimStatus)
        : json({ business: savedBusiness, scan: { ...cached!.scan, id: review.scanId, businessId: business.id }, understanding: savedReview });
      if (path.endsWith("/understanding")) {
        if (options?.method === "POST") {
          savedReview = review;
          return new Response(`${JSON.stringify({ type: "complete", understanding: savedReview })}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
        }
        return json({ understanding: savedReview });
      }
      if (path.endsWith("/apply")) {
        const { category, description } = JSON.parse(String(options?.body));
        savedBusiness = { ...business, category, description, updatedAt: "2026-11-16T12:01:00.000Z" };
        savedReview = { ...review, reviewedAt: savedBusiness.updatedAt };
        return json({ business: savedBusiness, understanding: savedReview });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch); return fetch;
  }
  function analyses(fetch: ReturnType<typeof fetcher>) {
    return fetch.mock.calls.filter(([path, options]) => path.endsWith("/understanding") && options?.method === "POST");
  }

  it("returns to authentication when the setup session expires without starting analysis", async () => {
    const fetch = vi.fn(async (_path: string, _options?: RequestInit) => json({ error: "Please log in to continue." }, 401));
    vi.stubGlobal("fetch", fetch);
    await render();
    expect(expired).toHaveBeenCalled();
    expect(fetch.mock.calls.every(([path, options]) => path === "/api/onboarding/preview" && !options?.method)).toBe(true);
    expect(container.querySelector(".agent-review")).toBeNull();
  });
  it("goes straight from one approved submission through scan and claim to AI without a findings review step", async () => {
    const fetch = fetcher(); await render();
    expect(container.querySelector(".auth-form")).toBeNull();
    expect(container.querySelector('[type="submit"]')?.textContent).toContain("Start AI analysis");
    expect(analyses(fetch)).toHaveLength(0);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    const details = container.querySelector("details");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.textContent).toContain("Starting analysis confirms");
    expect(details?.textContent).toContain("Competitor research is included.");
    expect(details?.textContent).toContain("Tavily");
    expect(details?.textContent).toContain("charges may apply");
    await set("onboardingUrl", business.website);
    await startAnalysis();
    expect(container.textContent).toContain("Your business, explained.");
    expect(container.querySelector(".public-findings")).toBeNull();
    expect(container.querySelector(".onboarding-continue")).toBeNull();
    expect(analyses(fetch)).toHaveLength(1);
    expect(JSON.parse(String(analyses(fetch)[0][1]?.body))).toEqual({ permission: true, scanId: review.scanId, research: true, researchVersion: 2, reuseCustomerEvidence: true });
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/onboarding/scan"))).toHaveLength(1);
    expect(JSON.parse(String(fetch.mock.calls.find(([path]) => path.endsWith("/onboarding/scan"))![1]?.body))).toEqual({ url: business.website, permission: true });
    expect(JSON.parse(String(fetch.mock.calls.find(([path]) => path.endsWith("/claim"))![1]?.body))).toEqual({ permission: true });
    expect(container.querySelectorAll(".briefing-card")).toHaveLength(1);
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>(".briefing-sections button")).find((button) => button.textContent?.startsWith("Next moves"))!.click());
    expect(container.querySelector(".briefing-card")?.textContent).toContain(review.briefing!.nextSteps[0].action);
    expect(container.querySelector(".briefing-card")?.textContent).not.toContain(review.briefing!.nextSteps[1].action);
    await click(".briefing-navigation .primary-link");
    expect(container.querySelector(".briefing-card")?.textContent).toContain(review.briefing!.nextSteps[1].action);
    expect(container.querySelector(`.first-visit a[href="#overview?business=${business.id}"]`)?.textContent).toContain("Open my growth journey");
    expect(container.querySelector(`.first-visit a[href="#overview?view=business&business=${business.id}"]`)?.textContent).toBe("Review business details");
    expect(container.querySelector(".agent-profile-editor")).toBeNull();
    expect(container.querySelector(".agent-profile-form")).toBeNull();
    expect(analyses(fetch)).toHaveLength(1);
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/apply"))).toHaveLength(0);
  });

  it("hides analysis details during first-time AI analysis without hiding progress or cancellation", async () => {
    const fetch = fetcher({ restored: preview });
    const complete = fetch.getMockImplementation()!;
    const job: AnalysisJob = {
      id: "9f1fb19f-04dc-41d7-ae01-8b5e238266fe", businessId: business.id, requestedUrl: business.website,
      scanId: review.scanId, status: "running", phase: "analysing", preview: null, understanding: null,
      error: null, revision: 1, createdAt: timestamp, updatedAt: timestamp, researchVersion: 2,
    };
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    fetch.mockImplementation(async (path, options) => {
      if (path.endsWith("/understanding") && options?.method === "POST") {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "job", job })}\n`));
          },
        }), { headers: { "Content-Type": "application/x-ndjson" } });
      }
      return complete(path, options);
    });
    await render();
    await startAnalysis();
    expect(container.textContent).not.toContain("Analysis details");
    expect(container.querySelector(".agent-progress [role=status]")?.textContent).toBe("Writing your business briefing...");
    expect(container.querySelector(".agent-progress button")?.textContent).toBe("Cancel analysis");
    expect(container.querySelector(".agent-progress-details")).toBeNull();
    expect(analyses(fetch)).toHaveLength(1);
    await act(async () => {
      stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "complete", understanding: review })}\n`));
      stream.close();
    });
    expect(container.textContent).toContain("Your business, explained.");
    expect(container.querySelector(".agent-progress")).toBeNull();
  });

  it("restores the website URL without showing scan findings or automatically claiming or calling AI", async () => {
    const fetch = fetcher({ restored: preview, authenticated: true }); await render();
    expect(container.querySelector<HTMLInputElement>('[name="onboardingUrl"]')?.value).toBe(business.website);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.querySelector(".public-findings")).toBeNull();
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/claim") || path.endsWith("/onboarding/scan"))).toBe(false);
    expect(analyses(fetch)).toHaveLength(0);
  });

  it("rejects an invalid website before scanning, saving, or calling AI", async () => {
    const fetch = fetcher({ restored: preview }); await render();
    await set("onboardingUrl", "not a website");
    await submit(".first-visit form");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("URL");
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("loads an already completed same-scan briefing without paying for another analysis", async () => {
    const fetch = fetcher({ restored: preview, authenticated: true, previous: review }); await render();
    await startAnalysis();
    expect(container.querySelector(".agent-briefing")?.textContent).toContain(review.briefing!.summary.text);
    expect(analyses(fetch)).toHaveLength(0);
  });

  it("keeps a newer briefing when returning to an older claimed public preview", async () => {
    const previous = { ...review, scanId: "aac3f63e-0b66-4cad-823e-dcd8d7e4f000", createdAt: "2026-11-16T12:01:00.000Z" };
    const fetch = fetcher({ restored: preview, authenticated: true, previous }); await render();
    await startAnalysis();
    expect(container.querySelector(".agent-briefing")?.textContent).toContain(previous.briefing!.summary.text);
    expect(analyses(fetch)).toHaveLength(0);
  });

  it("keeps successful onboarding focused without another optional analysis section", async () => {
    const fetch = fetcher({ restored: preview, authenticated: true }); await render();
    await startAnalysis();
    expect(analyses(fetch)).toHaveLength(1);
    expect(container.querySelector(".agent-rerun")).toBeNull();
    expect(container.querySelector(".agent-product-review")).toBeNull();
    expect(analyses(fetch)).toHaveLength(1);
  });

  it("reports an incomplete briefing and reuses the saved public findings only on explicit retry", async () => {
    const fetch = fetcher({ restored: preview, authenticated: true });
    const complete = fetch.getMockImplementation()!;
    let interrupted = false;
    fetch.mockImplementation(async (path, options) => {
      if (path.endsWith("/understanding") && options?.method === "POST" && !interrupted) {
        interrupted = true;
        return new Response(`${JSON.stringify({ type: "error", status: 502, message: "The AI reached its response limit before finishing the briefing." })}\n`,
          { headers: { "Content-Type": "application/x-ndjson" } });
      }
      return complete(path, options);
    });
    await render();
    await startAnalysis();
    expect(container.querySelector(".agent-review [role=alert]")?.textContent).toContain("response limit");
    expect(container.querySelector(".agent-profile-form")).toBeNull();
    expect(analyses(fetch)).toHaveLength(1);
    await click(".agent-controls button");
    expect(analyses(fetch)).toHaveLength(2);
    expect(JSON.parse(String(analyses(fetch)[1][1]?.body))).toEqual({ permission: true, scanId: review.scanId, research: true, researchVersion: 2, reuseCustomerEvidence: true });
    expect(container.textContent).toContain("Your business, explained.");
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/onboarding/scan"))).toBe(false);
  });

  it("continues directly with usable partial evidence and labels the resulting briefing as partial", async () => {
    const fetch = fetcher({ restored: { ...preview, scan: { ...preview.scan, status: "partial", coverage: { attemptedPages: 2, discoveredPages: 10, sitemapsRead: 1, requests: 4, bytesRead: 2000, productRecords: 12, limited: true }, failures: [{ url: `${business.website}about`, message: "Publisher restriction." }] } },
      previous: { ...review, scanStatus: "partial" } });
    await render(); await startAnalysis();
    expect(container.querySelector(".agent-review")?.textContent).toContain("partial scan");
    expect(container.querySelector(".public-findings")).toBeNull();
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/claim"))).toHaveLength(1);
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/onboarding/scan"))).toBe(false);
  });

  it("reuses the existing website scan without displaying an intermediate page list", async () => {
    const fetch = fetcher({ restored: { ...preview, scan: { ...preview.scan, pages: Array.from({ length: 20 }, (_, index) => ({
      ...preview.scan.pages[0], url: `${business.website}products/item-${index}`, title: `Fixture product ${index}`,
    })) } } });
    await render();
    expect(container.textContent).not.toContain("Fixture product");
    await startAnalysis();
    expect(analyses(fetch)).toHaveLength(1);
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/onboarding/scan"))).toBe(false);
    expect(container.querySelector(".public-findings")).toBeNull();
  });

  it("blocks AI after failed public scans while retaining manual business setup", async () => {
    const fetch = fetcher({ scanReply: { ...preview, scan: { ...preview.scan, status: "failed", pages: [], failures: [{ url: business.website, message: "Publisher restriction." }] } } });
    await render(); await set("onboardingUrl", business.website); await startAnalysis();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("No AI analysis was started");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Publisher restriction.");
    expect(container.querySelector(".onboarding-continue")).toBeNull();
    expect(container.querySelector(".first-visit > p a")?.getAttribute("href")).toBe("#overview?view=business&new=1");
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/claim"))).toBe(false);
    expect(analyses(fetch)).toHaveLength(0);
  });

  it("reports an expired handoff without starting or retrying AI", async () => {
    const fetch = fetcher({ restored: preview, authenticated: true, claimStatus: 410 }); await render();
    await startAnalysis();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("findings have expired");
    expect(analyses(fetch)).toHaveLength(0);
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/claim"))).toHaveLength(1);
    expect(container.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(false);
    await submit(".first-visit form");
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/onboarding/scan"))).toHaveLength(1);
    expect(analyses(fetch)).toHaveLength(0);
  });

  it("does not mistake an empty scan response for success or leave stale findings on screen", async () => {
    const fetch = fetcher({ restored: preview, scanReply: null }); await render();
    await set("onboardingUrl", "https://another.example.com/");
    await startAnalysis();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("unexpected response");
    expect(container.querySelector(".public-findings")).toBeNull();
    expect(analyses(fetch)).toHaveLength(0);
  });

  it("reads a changed website only after the user starts analysis instead of reusing another site's evidence", async () => {
    const fetch = fetcher({ restored: preview }); await render();
    await set("onboardingUrl", "https://another.example.com/");
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    await startAnalysis();
    const scans = fetch.mock.calls.filter(([path]) => path.endsWith("/onboarding/scan"));
    expect(scans).toHaveLength(1);
    expect(JSON.parse(String(scans[0][1]?.body))).toEqual({ url: "https://another.example.com/", permission: true });
    expect(analyses(fetch)).toHaveLength(1);
  });

  it("replaces an expired cached scan before starting analysis", async () => {
    const fetch = fetcher({ restored: { ...preview, expiresAt: new Date(Date.now() - 1).toISOString() } }); await render();
    await startAnalysis();
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/onboarding/scan"))).toHaveLength(1);
    expect(analyses(fetch)).toHaveLength(1);
  });

  it("prevents duplicate submissions while the website is being read", async () => {
    const fetch = fetcher();
    const complete = fetch.getMockImplementation()!;
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    fetch.mockImplementation(async (path, options) => {
      if (path === "/api/onboarding/scan") {
        await pending;
      }
      return complete(path, options);
    });
    await render(); await set("onboardingUrl", business.website); await startAnalysis();
    expect(container.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("AI analysis follows automatically");
    expect(container.textContent).not.toContain("Analysis details");
    await submit(".first-visit form");
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/onboarding/scan"))).toHaveLength(1);
    await act(async () => finish(json({ preview })));
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/claim"))).toHaveLength(1);
    expect(analyses(fetch)).toHaveLength(1);
  });
});
