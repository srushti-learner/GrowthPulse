// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { OnboardingPreview } from "../shared/onboarding";
import type { Understanding } from "../shared/understanding";

const user = { id: "509e12ce-3028-4ed1-bdf7-329a26d470d8", name: "Test Owner", email: "owner@example.test" };
const timestamp = "2026-11-16T12:00:00.000Z";
const business = { id: "02a221ee-41f1-46c9-bc96-12401d8dcf73", name: "shop.example.com", website: "https://shop.example.com/",
  category: "", description: "", createdAt: timestamp, updatedAt: timestamp };
const preview: OnboardingPreview = {
  expiresAt: "2026-11-16T12:30:00.000Z",
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

describe("first-visit journey", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.history.replaceState(null, "", "/#overview");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render() { await act(async () => root.render(<StrictMode><App /></StrictMode>)); }
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

  it("carries public findings through signup while keeping optional profile changes off the research page", async () => {
    const fetch = fetcher(); await render();
    expect(container.querySelector(".auth-form")).toBeNull();
    await set("onboardingUrl", business.website);
    await click('[name="onboardingPermission"]');
    await submit(".first-visit form");
    expect(container.querySelector(".public-findings")?.textContent).toContain("Fixture shop");
    expect(container.querySelector(".public-finding a")?.getAttribute("href")).toBe(business.website);
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/claim"))).toBe(false);
    expect(analyses(fetch)).toHaveLength(0);
    expect(container.querySelector(".onboarding-continue")?.textContent).toContain("Competitor research is included.");
    expect(container.querySelector(".onboarding-continue")?.textContent).toContain("Tavily");
    await click(".onboarding-continue button");
    await click(".auth-form .text-button");
    expect(container.querySelector(".public-findings")?.textContent).toContain("Fixture shop");
    await set("name", user.name); await set("email", user.email); await set("password", "local test passphrase");
    await submit(".auth-form");
    expect(container.textContent).toContain("Your business, explained.");
    expect(analyses(fetch)).toHaveLength(1);
    expect(JSON.parse(String(analyses(fetch)[0][1]?.body))).toEqual({ permission: true, scanId: review.scanId, research: true, researchVersion: 2 });
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/onboarding/scan"))).toHaveLength(1);
    expect(JSON.parse(String(fetch.mock.calls.find(([path]) => path.endsWith("/claim"))![1]?.body))).toEqual({ permission: true });
    expect(container.querySelectorAll(".briefing-card")).toHaveLength(1);
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>(".briefing-sections button")).find((button) => button.textContent?.startsWith("Next moves"))!.click());
    expect(container.querySelector(".briefing-card")?.textContent).toContain(review.briefing!.nextSteps[0].action);
    expect(container.querySelector(".briefing-card")?.textContent).not.toContain(review.briefing!.nextSteps[1].action);
    await click(".briefing-navigation .primary-link");
    expect(container.querySelector(".briefing-card")?.textContent).toContain(review.briefing!.nextSteps[1].action);
    expect(container.querySelector('.first-visit a[href="#business"]')?.textContent).toBe("Business Profile");
    expect(container.querySelector(".agent-profile-editor")).toBeNull();
    expect(container.querySelector(".agent-profile-form")).toBeNull();
    expect(analyses(fetch)).toHaveLength(1);
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/apply"))).toHaveLength(0);
    await click(".session-actions button");
    expect(container.querySelector(".agent-review")).toBeNull();
    expect(container.querySelector(".public-findings")).toBeNull();
  });

  it("restores public findings on refresh without automatically claiming or calling AI", async () => {
    const fetch = fetcher({ restored: preview, authenticated: true }); await render();
    expect(container.querySelector<HTMLInputElement>('[name="onboardingUrl"]')?.value).toBe(business.website);
    expect(container.querySelector(".public-findings")?.textContent).toContain("Fixture shop");
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/claim") || path.endsWith("/onboarding/scan"))).toBe(false);
    expect(analyses(fetch)).toHaveLength(0);
  });

  it("loads an already completed same-scan briefing without paying for another analysis", async () => {
    const fetch = fetcher({ restored: preview, authenticated: true, previous: review }); await render();
    await click(".onboarding-continue button");
    expect(container.querySelector(".agent-briefing")?.textContent).toContain(review.briefing!.summary.text);
    expect(analyses(fetch)).toHaveLength(0);
  });

  it("keeps a newer briefing when returning to an older claimed public preview", async () => {
    const previous = { ...review, scanId: "aac3f63e-0b66-4cad-823e-dcd8d7e4f000", createdAt: "2026-11-16T12:01:00.000Z" };
    const fetch = fetcher({ restored: preview, authenticated: true, previous }); await render();
    await click(".onboarding-continue button");
    expect(container.querySelector(".agent-briefing")?.textContent).toContain(previous.briefing!.summary.text);
    expect(analyses(fetch)).toHaveLength(0);
  });

  it("keeps successful onboarding focused without another optional analysis section", async () => {
    const fetch = fetcher({ restored: preview, authenticated: true }); await render();
    await click(".onboarding-continue button");
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
    await click(".onboarding-continue button");
    expect(container.querySelector(".agent-review [role=alert]")?.textContent).toContain("response limit");
    expect(container.querySelector(".agent-profile-form")).toBeNull();
    expect(analyses(fetch)).toHaveLength(1);
    await click(".agent-controls button");
    expect(analyses(fetch)).toHaveLength(2);
    expect(JSON.parse(String(analyses(fetch)[1][1]?.body))).toEqual({ permission: true, scanId: review.scanId, research: true, researchVersion: 2 });
    expect(container.textContent).toContain("Your business, explained.");
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/onboarding/scan"))).toBe(false);
  });

  it("labels partial findings and does not present unavailable pages as analysed", async () => {
    fetcher({ restored: { ...preview, scan: { ...preview.scan, status: "partial", coverage: { attemptedPages: 2, discoveredPages: 10, sitemapsRead: 1, requests: 4, bytesRead: 2000, productRecords: 12, limited: true }, failures: [{ url: `${business.website}about`, message: "Publisher restriction." }] } } });
    await render();
    expect(container.querySelector(".public-findings")?.textContent).toContain("Discovery is partial");
    expect(container.querySelector(".public-findings")?.textContent).toContain("12 structured product records captured");
    expect(container.querySelector(".public-findings details")?.hasAttribute("open")).toBe(false);
    expect(container.querySelector(".onboarding-continue button")).not.toBeNull();
  });

  it("previews three pages and keeps the remaining expanded discovery collapsed", async () => {
    fetcher({ restored: { ...preview, scan: { ...preview.scan, pages: Array.from({ length: 20 }, (_, index) => ({
      ...preview.scan.pages[0], url: `${business.website}products/item-${index}`, title: `Fixture product ${index}`,
    })) } } });
    await render();
    expect(container.querySelectorAll(".public-findings > .public-finding")).toHaveLength(3);
    expect(container.querySelectorAll(".public-findings-more .public-finding")).toHaveLength(17);
    expect(container.querySelector(".public-findings-more")?.hasAttribute("open")).toBe(false);
    expect(container.querySelector(".onboarding-continue button")).not.toBeNull();
  });

  it("blocks AI after failed public scans while retaining the manual sign-in fallback", async () => {
    const fetch = fetcher({ restored: { ...preview, scan: { ...preview.scan, status: "failed", pages: [], failures: [{ url: business.website, message: "Publisher restriction." }] } } });
    await render();
    expect(container.querySelector(".public-findings")?.textContent).toContain("AI analysis will not start");
    expect(container.querySelector(".public-findings")?.textContent).toContain("Publisher restriction.");
    expect(container.querySelector(".onboarding-continue")).toBeNull();
    expect(container.querySelector(".first-visit > p a")?.getAttribute("href")).toBe("#business");
    expect(analyses(fetch)).toHaveLength(0);
  });

  it("reports an expired handoff without starting or retrying AI", async () => {
    const fetch = fetcher({ restored: preview, authenticated: true, claimStatus: 410 }); await render();
    await click(".onboarding-continue button");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("findings have expired");
    expect(analyses(fetch)).toHaveLength(0);
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("/claim"))).toHaveLength(1);
  });

  it("does not mistake an empty scan response for success or leave stale findings on screen", async () => {
    const fetch = fetcher({ restored: preview, scanReply: null }); await render();
    await click('[name="onboardingPermission"]');
    await submit(".first-visit form");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("unexpected response");
    expect(container.querySelector(".public-findings")).toBeNull();
    expect(analyses(fetch)).toHaveLength(0);
  });
});
