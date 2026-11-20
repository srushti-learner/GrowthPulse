// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrowthJourney } from "./GrowthJourney";
import type { GrowthOpportunity, GrowthResponse } from "../shared/growth";
import { analyticsDataSchema } from "../shared/analytics";
import { weeklyReport } from "../shared/weekly-review";

const business = {
  id: "02a221ee-41f1-46c9-bc96-12401d8dcf73", name: "Fixture shop", website: "", category: "", description: "",
  createdAt: "2026-11-17T12:00:00.000Z", updatedAt: "2026-11-17T12:00:00.000Z",
};
const opportunity: GrowthOpportunity = {
  id: "a".repeat(64), title: "Check sizing information", detail: "Review recorded measurements with shoppers.", agents: ["growth"],
  sources: [{ id: "e_1111111111111111", url: "https://shop.example.com/", quote: "Five sizes are available.", capturedAt: business.createdAt }],
  reviewReason: "Requires owner validation.", strategy: {
    objective: "Clarify sizing", actions: ["Confirm measurements."], metric: "Customer enquiries",
    hypothesis: "Check whether sizing information helps.", measurement: "Choose a baseline before testing.",
  },
};
const empty: GrowthResponse = { opportunities: [], plan: [], researchStatus: "unavailable", evidenceSavedAt: null };
const saved: GrowthResponse = { ...empty, researchStatus: "partial", opportunities: [opportunity], plan: [{
  opportunity, status: "in_progress", impact: "unknown", effort: "unknown", timeToValue: "unknown", revision: 0,
  createdAt: business.createdAt, updatedAt: business.updatedAt,
}] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("connected growth journey", () => {
  let container: HTMLDivElement, root: Root;
  const expired = vi.fn(), selected = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); expired.mockReset(); selected.mockReset();
    window.history.replaceState(null, "", "/#overview");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(section = "overview", id: string | undefined = business.id) {
    await act(async () => root.render(<GrowthJourney section={section} selectedBusinessId={id}
      onBusinessSelected={selected} onSessionExpired={expired} />));
  }
  function fetcher(growth = saved) {
    const fetch = vi.fn(async (path: string, _options?: RequestInit) => {
      if (path === "/api/businesses") return json({ businesses: [business] });
      if (path.endsWith("/products")) return json({ products: [] });
      if (path.endsWith("/growth")) return json(growth);
      if (path.endsWith("/weekly-review")) return json({
        version: "empty", observedAt: null, coveredThrough: null, stale: true, observationCount: 0,
        current: weeklyReport(analyticsDataSchema.parse({
          version: "empty", currency: null, days: [], products: [], imports: [], sources: [], scenarios: [], warnings: [],
        }), "2026-11-19"), reviews: [], measurements: [],
      });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch); return fetch;
  }
  it("resumes a saved action, distinguishes partial research and never runs scans or AI", async () => {
    const fetch = fetcher(); await render();
    expect(container.querySelector(".journey-next h2")?.textContent).toBe(opportunity.title);
    expect(container.querySelector(".journey-next a")?.getAttribute("href")).toBe(`#actions?business=${business.id}&action=${opportunity.id}`);
    expect(container.querySelector(".journey-stages")?.textContent).toContain("Partial research saved");
    expect(container.querySelector(".journey-stages a:nth-child(2) svg")).toBeNull();
    expect(container.querySelector(".journey-summary")?.textContent).toContain("1Open plan actions");
    expect(container.querySelector(".journey-chapters")).toBeNull();
    expect(container.querySelector('[aria-label="Weekly Growth Review"]')).toBeNull();
    expect(container.querySelector(".journey-next")!.compareDocumentPosition(container.querySelector(".journey-stages")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll(".journey-stages a")[3].getAttribute("href")).toBe(`#actions?business=${business.id}`);
    expect(container.querySelector(".journey-stages a[href^='#products']")).toBeNull();
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    expect(fetch.mock.calls.every(([path]) => !/scans|understanding|analyses/.test(path))).toBe(true);
  });
  it("keeps a website-less business usable and makes manual catalogue entry a first step", async () => {
    fetcher(empty); await render();
    expect(container.querySelector(".journey-next")?.textContent).toContain("Give what you sell a place");
    expect(container.querySelector(".journey-next a")?.getAttribute("href")).toBe(`#products?business=${business.id}`);
    expect(container.querySelector(".journey-stages")?.textContent).toContain("No saved research");
    expect(container.textContent).not.toContain("100%");
  });
  it("starts an empty account with a profile rather than displaying invented counts", async () => {
    const fetch = vi.fn(async () => json({ businesses: [] })); vi.stubGlobal("fetch", fetch);
    await render("overview", "");
    expect(container.querySelector(".journey-next")?.textContent).toContain("Start with your business");
    expect(container.querySelector(".journey-summary")).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add a business"]')!.click());
    expect(selected).toHaveBeenCalledWith("");
    expect(window.location.hash).toBe("#overview?view=setup&new=1");
  });
  it("nests setup and profile views inside the journey instead of showing the dashboard", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ businesses: [] })));
    await act(async () => root.render(<GrowthJourney section="overview" selectedBusinessId=""
      onBusinessSelected={selected} onSessionExpired={expired} setup={<div data-setup>Website setup</div>}
      profile={<div data-profile>Business details</div>} />));
    expect(container.querySelector("[data-setup]")).not.toBeNull();
    expect(container.querySelector(".journey-next")).toBeNull();
    expect(container.querySelector(".journey-summary")).toBeNull();
    await act(async () => root.render(<GrowthJourney section="overview" selectedBusinessId="" view="business"
      onBusinessSelected={selected} onSessionExpired={expired} setup={<div data-setup>Website setup</div>}
      profile={<div data-profile>Business details</div>} />));
    expect(container.querySelector("[data-profile]")).not.toBeNull();
    expect(container.querySelector("[data-setup]")).toBeNull();
    expect(container.querySelector(".journey-next")).toBeNull();
  });
  it("keeps the profile mounted through business selection and refetch so approved analysis survives saving", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/businesses") return new Promise<Response>((resolve) => { finish = resolve; });
      if (path.endsWith("/products")) return json({ products: [] });
      return json(empty);
    }));
    const profile = <input aria-label="Profile draft" defaultValue="Keep my analysis state" />;
    await act(async () => root.render(<GrowthJourney section="overview" selectedBusinessId="" view="business"
      onBusinessSelected={selected} onSessionExpired={expired} profile={profile} />));
    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    await act(async () => finish(json({ businesses: [] })));
    await act(async () => root.render(<GrowthJourney section="overview" selectedBusinessId={business.id} view="business"
      onBusinessSelected={selected} onSessionExpired={expired} profile={profile} />));
    expect(container.querySelector("input")).toBe(input);
    await act(async () => finish(json({ businesses: [business] })));
    expect(container.querySelector("input")).toBe(input);
    expect(container.querySelector(".journey-next")).toBeNull();
    expect(container.querySelector(".journey-chapters")).toBeNull();
    expect(container.querySelector(".journey-stages")).toBeNull();
  });
  it("clears task-specific parameters when switching business, including the new-profile route", async () => {
    fetcher(); await render("products");
    window.history.replaceState(null, "", `/#products?new=1&business=${business.id}&action=${opportunity.id}&product=old&import=old`);
    await act(async () => container.querySelector<HTMLSelectElement>('[aria-label="Active business"]')!.dispatchEvent(new Event("change", { bubbles: true })));
    expect(selected).toHaveBeenCalledWith(business.id);
    expect(window.location.hash).toBe(`#products?business=${business.id}`);
  });
  it("shows owner-reported progress and links back to the exact saved action, not fictional sales results", async () => {
    fetcher({ ...saved, plan: [{ ...saved.plan[0], status: "completed" }] }); await render("progress");
    expect(container.querySelector(".journey-action-list")?.textContent).toContain("Marked complete by you");
    expect(container.querySelector(".journey-action-list a")?.getAttribute("href")).toBe(`#actions?business=${business.id}&action=${opportunity.id}`);
    expect(container.querySelector(".journey-review")?.textContent).toContain("not measured business growth");
    expect(container.querySelector(".journey-results")?.textContent).toContain("what-if projections are not actual results");
    expect(container.querySelector(".journey-stages")).toBeNull();
    expect(container.querySelectorAll('[aria-label="Weekly Growth Review"]')).toHaveLength(1);
  });
  it.each(["website", "products", "intelligence", "growth", "actions", "simulator", "activity"])("keeps %s focused without repeating the overview or fetching unrelated snapshots", async (section) => {
    const fetch = fetcher(); await render(section);
    expect(container.querySelectorAll('[aria-label="Active business"]')).toHaveLength(1);
    expect(container.querySelector(".journey-stages")).toBeNull();
    expect(container.querySelector(".journey-next")).toBeNull();
    expect(container.querySelector(".journey-summary")).toBeNull();
    expect(container.querySelector('[aria-label="Weekly Growth Review"]')).toBeNull();
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/businesses"]);
  });
  it("does not turn read failures into an empty plan, retries, and handles expired sessions", async () => {
    let failed = true, unauthorized = false;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/businesses") return json({ businesses: [business] });
      if (path.endsWith("/products")) return json({ products: [] });
      return unauthorized ? json({ error: "Please sign in." }, 401) : failed ? json({ error: "Database unavailable." }, 503) : json(saved);
    }));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Database unavailable");
    expect(container.querySelector(".journey-summary")).toBeNull();
    expect(container.querySelector(".journey-next")).toBeNull();
    failed = false;
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(container.querySelector(".journey-next h2")?.textContent).toBe(opportunity.title);
    unauthorized = true; await render("progress");
    expect(expired).toHaveBeenCalled();
  });
  it("never displays a stale response from a previously selected business", async () => {
    const second = { ...business, id: "509e12ce-3028-4ed1-bdf7-329a26d470d8", name: "Second shop" };
    let finishFirst!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/businesses") return json({ businesses: [business, second] });
      if (path.endsWith("/products")) return json({ products: [] });
      if (path === `/api/businesses/${business.id}/growth`) return new Promise<Response>((resolve) => { finishFirst = resolve; });
      return json(empty);
    }));
    await render();
    await render("overview", second.id);
    await act(async () => finishFirst(json(saved)));
    expect(container.querySelector(".journey-next")?.textContent).not.toContain(opportunity.title);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Active business"]')?.value).toBe(second.id);
    expect(container.querySelector(".journey-summary")?.textContent).toContain("0Open plan actions");
  });
});
