// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GrowthOpportunity, GrowthPlanItem, GrowthResponse } from "../shared/growth";
import { GrowthIntelligence } from "./GrowthIntelligence";

const business = {
  id: "02a221ee-41f1-46c9-bc96-12401d8dcf73", name: "Fixture shop", website: "https://shop.example.com/",
  category: "", description: "", createdAt: "2026-11-17T12:00:00.000Z", updatedAt: "2026-11-17T12:00:00.000Z",
};
const opportunity: GrowthOpportunity = {
  id: "a".repeat(64), title: "Test clearer sizing guidance", detail: "Check sizing questions with shoppers.",
  agents: ["growth"], sources: [{ id: "e_1111111111111111", url: business.website, quote: "Five sizes are available.", capturedAt: business.createdAt }],
  reviewReason: "Saved Growth strategy recommendation. Source coverage is not predicted business impact.",
  strategy: {
    objective: "Make sizing easier to evaluate", actions: ["Validate sizing questions.", "Prepare a small approved test."],
    metric: "Purchase conversion rate", hypothesis: "Check whether clearer guidance helps eligible shoppers.",
    measurement: "Set a baseline and test duration before starting.",
  },
};
const empty: GrowthResponse = { opportunities: [], plan: [], researchStatus: "unavailable", evidenceSavedAt: null };
const snapshot: GrowthResponse = { ...empty, opportunities: [opportunity], researchStatus: "partial", evidenceSavedAt: business.createdAt };
const planned: GrowthPlanItem = {
  opportunity, status: "planned", impact: "unknown", effort: "unknown", timeToValue: "unknown", revision: 0,
  createdAt: business.createdAt, updatedAt: business.createdAt,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("growth decision workspace", () => {
  let container: HTMLDivElement, root: Root;
  const expired = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); expired.mockReset();
    window.history.replaceState(null, "", "/#growth");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(actionOnly = false, onPlanSaved?: () => void) {
    await act(async () => root.render(<GrowthIntelligence business={business} onSessionExpired={expired} actionOnly={actionOnly} onPlanSaved={onPlanSaved} />));
  }
  function button(text: string, scope: ParentNode = container) {
    return Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.includes(text))!;
  }
  async function click(text: string) { await act(async () => button(text).click()); }

  it("shows a suggested experiment, keeps strategy/evidence on demand and never starts research while browsing", async () => {
    const fetch = vi.fn(async (_path: string) => json(snapshot)); vi.stubGlobal("fetch", fetch);
    await render();
    expect(container.querySelector(".growth-next-move h2")?.textContent).toBe(opportunity.title);
    expect(container.querySelector('.growth-next-move [data-slot="card-description"]')?.textContent).toBe("Suggested experiment");
    expect(container.querySelector(".growth-next-move")!.compareDocumentPosition(container.querySelector(".growth-summary")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".growth-map")?.getAttribute("open")).toBeNull();
    expect([...container.querySelectorAll("h2, h4")].filter((heading) => heading.textContent === opportunity.title)).toHaveLength(1);
    expect(container.querySelectorAll(".opportunity-card")).toHaveLength(0);
    expect(container.querySelector("#growth-opportunities-heading")).toBeNull();
    expect(container.querySelectorAll(".growth-card-actions")).toHaveLength(1);
    expect(container.textContent).toContain("Partial evidence");
    expect(container.textContent).toContain("not assessed");
    expect(container.querySelector(".growth-footer .field-note")).toBeNull();
    expect(button("Reload saved findings")).toBeDefined();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click("Explore strategy");
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(opportunity.strategy.objective);
    expect(dialog.textContent).toContain("Nothing has been launched or changed for you");
    expect(dialog.textContent).not.toContain("There is no automatic outcome tracking");
    const toolLinks = dialog.querySelector(".strategy-tool-links")!;
    expect(Array.from(toolLinks.children, (element) => element.tagName)).toEqual(["A", "A"]);
    expect(toolLinks.children[0].nextElementSibling).toBe(toolLinks.children[1]);
    expect(dialog.querySelector<HTMLAnchorElement>('a[href^="#simulator"]')?.getAttribute("href"))
      .toBe(`#simulator?business=${business.id}&action=${opportunity.id}`);
    expect(dialog.querySelector<HTMLAnchorElement>('a[href^="#products"]')?.getAttribute("href"))
      .toBe(`#products?business=${business.id}&action=${opportunity.id}`);
    expect(dialog.querySelector('a[href^="#products"]')?.textContent).toContain("Review a product");
    expect(dialog.querySelector('a[href^="#products"]')?.getAttribute("data-slot")).toBe("button");
    const background = dialog.querySelector<HTMLDetailsElement>(".action-background")!;
    expect(background.open).toBe(false);
    await act(async () => background.querySelector("summary")!.click());
    const researchNotes = background.querySelector<HTMLDetailsElement>(".action-research-notes")!;
    expect(researchNotes.open).toBe(false);
    await act(async () => researchNotes.querySelector("summary")!.click());
    expect(researchNotes.textContent).toContain(opportunity.reviewReason);
    expect(researchNotes.textContent).toContain("Results are not tracked automatically");
    const evidence = background.querySelector<HTMLDetailsElement>(".agent-sources")!;
    expect(evidence.open).toBe(false);
    await act(async () => evidence.querySelector("summary")!.click());
    expect(evidence.querySelector("a")?.href).toBe(business.website);
    expect(evidence.textContent).toContain(opportunity.sources[0].quote);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(`/api/businesses/${business.id}/growth`);
  });

  it.each(["Experiment 2:", "Research 2:", "Experiment #2 -"])("removes the %s prefix from displayed recommendation titles without changing saved data", async (prefix) => {
    const numbered = { ...opportunity, title: `${prefix} ${opportunity.title}` };
    const fetch = vi.fn(async () => json({ ...snapshot, opportunities: [numbered], plan: [{ ...planned, opportunity: numbered }] }));
    vi.stubGlobal("fetch", fetch);
    await render();
    expect(container.querySelector(".growth-next-move")).toBeNull();
    expect(container.querySelector(".growth-plan-item summary")?.textContent).toContain(opportunity.title);
    expect(container.querySelector(".growth-plan-item summary")?.textContent).not.toContain(prefix);
    await click("Explore strategy");
    expect(document.querySelector('[data-slot="sheet-title"]')?.textContent).toBe(opportunity.title);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves meaningful numbers that are not experiment or research prefixes", async () => {
    const title = "Research 2026 customer buying patterns";
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...snapshot, opportunities: [{ ...opportunity, title }] })));
    await render();
    expect(container.querySelector(".growth-next-move h2")?.textContent).toBe(title);
  });

  it("reopens the exact saved action from a journey handoff without changing its status", async () => {
    const fetch = vi.fn(async () => json({ ...snapshot, plan: [planned] })); vi.stubGlobal("fetch", fetch);
    await render();
    const details = container.querySelector<HTMLDetailsElement>(".growth-plan-item")!;
    expect(details.open).toBe(false);
    await act(async () => {
      window.history.replaceState(null, "", `/#growth?business=${business.id}&action=${opportunity.id}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(details.querySelector("summary"));
    expect(fetch).toHaveBeenCalledOnce();
    expect(details.querySelector<HTMLSelectElement>('select[name="status"]')?.value).toBe("planned");
    expect(details.querySelector(".growth-plan-overview")?.textContent).toContain(opportunity.detail);
    const actions = details.querySelector(".growth-plan-actions")!;
    expect(button("Explore strategy", actions)).toBeDefined();
    expect(actions.querySelector("a")?.getAttribute("href")).toBe(`#actions?business=${business.id}&action=${opportunity.id}`);
    expect(details.querySelector<HTMLDetailsElement>(".growth-plan-notes")?.open).toBe(false);
  });

  it("shows recommendations once and still opens a linked opportunity beyond the initial selection", async () => {
    const opportunities = Array.from({ length: 6 }, (_, index) => ({
      ...opportunity, id: String(index + 1).repeat(64), title: `Review option ${index + 1}`,
    }));
    const fetch = vi.fn(async () => json({ ...snapshot, opportunities }));
    vi.stubGlobal("fetch", fetch); await render();
    expect(container.querySelector(".growth-next-move h2")?.textContent).toBe(opportunities[0].title);
    expect(container.querySelectorAll(".opportunity-card")).toHaveLength(3);
    expect(container.querySelectorAll('[id^="growth-opportunity-"]')).toHaveLength(4);
    await act(async () => {
      window.history.replaceState(null, "", `/#growth?business=${business.id}&action=${opportunities[5].id}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelectorAll(".opportunity-card")).toHaveLength(5);
    for (const item of opportunities) {
      expect([...container.querySelectorAll("h2, h4")].filter((heading) => heading.textContent === item.title)).toHaveLength(1);
    }
    expect(document.activeElement?.id).toBe(`growth-opportunity-${opportunities[5].id}`);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("saves a plan, assesses its priority and focuses its action from the map without changing the app route", async () => {
    let response: GrowthResponse = structuredClone(snapshot);
    const fetch = vi.fn(async (_path: string, options?: RequestInit) => {
      if (options?.method === "POST") { response = { ...response, plan: [planned] }; return json({ item: planned }, 201); }
      if (options?.method === "PATCH") {
        const next = { ...planned, ...JSON.parse(String(options.body)), revision: 1 };
        response = { ...response, plan: [next] }; return json({ item: next });
      }
      return json(response);
    });
    vi.stubGlobal("fetch", fetch); await render(); await click("Add to my growth plan");
    expect(container.querySelectorAll(".growth-plan-item")).toHaveLength(1);
    expect(container.querySelectorAll(".opportunity-card")).toHaveLength(0);
    expect(container.textContent).toContain("No website change or campaign has been made");
    const details = container.querySelector<HTMLDetailsElement>(".growth-plan-item")!;
    await act(async () => {
      details.open = true;
      for (const [name, value] of Object.entries({ status: "in_progress", impact: "high", effort: "low", timeToValue: "weeks" })) {
        const select = details.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!; select.value = value;
      }
      details.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(fetch.mock.calls.find(([, options]) => options?.method === "PATCH")?.[1]?.body)
      .toBe(JSON.stringify({ status: "in_progress", impact: "high", effort: "low", timeToValue: "weeks", revision: 0 }));
    expect(container.querySelector('.growth-matrix [aria-label="Quick wins"]')?.textContent).toContain(opportunity.title);
    details.open = false;
    await act(async () => container.querySelector<HTMLDetailsElement>(".growth-map")!.querySelector("summary")!.click());
    await act(async () => button(opportunity.title, container.querySelector(".growth-matrix")!).click());
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(details.querySelector("summary"));
    expect(window.location.hash).toBe("#growth");
    await click("Reload saved findings");
    expect(container.querySelectorAll(".growth-plan-item")).toHaveLength(1);
  });

  it("keeps earlier plans visible, handles stale edits and does not invent an assessment", async () => {
    const fetch = vi.fn(async (_path: string, options?: RequestInit) =>
      options?.method === "PATCH" ? json({ error: "This action changed in another view. Reload before updating it." }, 409)
        : json({ ...empty, plan: [planned] }));
    vi.stubGlobal("fetch", fetch); await render();
    expect(container.textContent).toContain("This action is from earlier research. Review its sources before starting.");
    expect(container.querySelector(".growth-map")?.textContent).toContain("0 assessed actions");
    const details = container.querySelector<HTMLDetailsElement>(".growth-plan-item")!;
    await act(async () => { details.open = true; details.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Reload before updating");
    expect(container.querySelector<HTMLSelectElement>('[name="impact"]')?.value).toBe("unknown");
    await click("Reload saved findings");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("offers a saved-data retry for loading errors and a truthful empty state", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ error: "Database unavailable." }, 503)).mockResolvedValueOnce(json(empty));
    vi.stubGlobal("fetch", fetch); await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Database unavailable");
    await click("Reload growth intelligence");
    expect(container.textContent).toContain("Gather evidence before choosing a growth move");
    expect(container.querySelector('a[href^="#overview?view=business"]')?.textContent).toContain("Manage website analysis");
    expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  });

  it("distinguishes a completed plan from having no evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...snapshot, plan: [{ ...planned, status: "completed" }] })));
    await render();
    expect(container.querySelector(".growth-next-move")).toBeNull();
    expect(container.textContent).toContain("No pending growth actions.");
    expect(container.textContent).not.toContain("No accepted growth suggestions are available");
    expect(container.querySelector(".growth-summary")?.textContent).toContain("1/1");
  });

  it("uses Act for chosen actions and next steps, with catalogue tools optional and status edits revision guarded", async () => {
    const saved = vi.fn();
    const assessed = { ...planned, impact: "high", effort: "low", timeToValue: "weeks", revision: 3 } as const;
    const fetch = vi.fn(async (_path: string, options?: RequestInit) => options?.method === "PATCH"
      ? json({ item: { ...assessed, status: "in_progress", revision: 4 } }) : json({ ...snapshot, plan: [assessed] }));
    vi.stubGlobal("fetch", fetch); await render(true, saved);
    expect(container.querySelector(".growth-opportunities-heading")).toBeNull();
    expect(container.querySelector(".growth-next-move")).toBeNull();
    const action = container.querySelector<HTMLDetailsElement>(".growth-plan-item")!;
    expect(action.open).toBe(true);
    expect(action.querySelector("ol")?.textContent).toContain(opportunity.strategy.actions[0]);
    expect(action.textContent).toContain("Suggested steps, not completed work");
    const tools = Array.from(action.querySelectorAll("details")).find((item) => item.querySelector("summary")?.textContent === "Optional tools for this action")!;
    expect(tools.open).toBe(false);
    expect(tools.querySelector("a")?.getAttribute("href")).toBe(`#products?business=${business.id}&action=${opportunity.id}`);
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () => {
      action.querySelector<HTMLSelectElement>('[name="status"]')!.value = "in_progress";
      action.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(fetch.mock.calls.find(([, options]) => options?.method === "PATCH")?.[1]?.body)
      .toBe(JSON.stringify({ status: "in_progress", impact: "high", effort: "low", timeToValue: "weeks", revision: 3 }));
    expect(saved).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("action status is saved");
    expect(container.querySelector(".growth-plan-item summary")?.textContent).toContain("In progress");
  });

  it("opens exact completed and dismissed actions from Review and filters them without inventing open work", async () => {
    const dismissed = { ...planned, opportunity: { ...opportunity, id: "b".repeat(64), title: "Dismissed action" }, status: "dismissed" };
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...empty, plan: [{ ...planned, status: "completed" }, dismissed] })));
    window.history.replaceState(null, "", `/#actions?business=${business.id}&action=${dismissed.opportunity.id}`);
    await render(true);
    expect(container.querySelectorAll(".growth-plan-item")).toHaveLength(1);
    expect(container.querySelector(".growth-plan-item")?.id).toBe(`growth-action-${dismissed.opportunity.id}`);
    expect(container.querySelector<HTMLDetailsElement>(".growth-plan-item")?.open).toBe(true);
    await click("To do & in progress");
    expect(container.textContent).toContain("No open actions");
    expect(container.querySelector(".growth-plan-item")).toBeNull();
    await act(async () => {
      window.history.replaceState(null, "", `/#actions?business=${business.id}&action=${opportunity.id}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector(".growth-plan-item summary")?.textContent).toContain("Marked complete by you");
    expect(document.activeElement).toBe(container.querySelector(".growth-plan-item summary"));
  });

  it("makes older plans readable without repeating the recommendation as the goal or a task", async () => {
    const legacy = {
      ...opportunity, strategy: {
        ...opportunity.strategy, objective: opportunity.title,
        hypothesis: `Test whether this recommendation improves the chosen metric: ${opportunity.title}`,
        actions: ["Confirm the issue with shoppers.", opportunity.detail, "Prepare a small approved test.",
          "  CONFIRM the issue with shoppers!  ", "Measure against a baseline."],
      },
    };
    const fetch = vi.fn(async (_path: string) => json({ ...snapshot, plan: [{ ...planned, opportunity: legacy }] }));
    vi.stubGlobal("fetch", fetch);
    await render(true);
    const action = container.querySelector(".growth-plan-item")!;
    expect(action.querySelector(".action-proposal")?.textContent).toBe(`What to try${opportunity.detail}`);
    expect(action.textContent?.split(opportunity.title)).toHaveLength(2);
    expect(action.textContent?.split(opportunity.detail)).toHaveLength(2);
    expect(action.querySelector(".action-plan")?.textContent).not.toContain("The goal");
    expect(action.querySelector(".action-background")?.textContent).not.toContain("Assumption to test");
    expect(Array.from(action.querySelectorAll(".action-next-steps li"), (item) => item.textContent))
      .toEqual(["Confirm the issue with shoppers.", "Prepare a small approved test.", "Measure against a baseline."]);
    expect(action.querySelector(".action-measurement")?.textContent).toContain(opportunity.strategy.metric);
    expect(action.querySelector(".action-measurement")?.textContent).toContain(opportunity.strategy.measurement);
    expect(action.querySelector<HTMLDetailsElement>(".action-background")?.open).toBe(false);
    expect(action.querySelector<HTMLSelectElement>('[name="status"]')?.value).toBe("planned");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(`/api/businesses/${business.id}/growth`);
  });

  it("preserves a distinct goal and does not invent tasks when the saved action list only repeats the proposal", async () => {
    const value = { ...opportunity, strategy: { ...opportunity.strategy, actions: [opportunity.detail] } };
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...snapshot, plan: [{ ...planned, opportunity: value }] })));
    await render(true);
    const plan = container.querySelector(".action-plan")!;
    expect(plan.textContent).toContain(`The goal${opportunity.strategy.objective}`);
    expect(plan.querySelector("ol")).toBeNull();
    expect(plan.querySelector(".action-proposal")?.textContent).toContain(opportunity.detail);
    expect(plan.querySelector(".action-measurement")).not.toBeNull();
    await act(async () => plan.querySelector<HTMLDetailsElement>(".action-background")!.querySelector("summary")!.click());
    expect(plan.querySelector<HTMLDetailsElement>(".action-background")?.open).toBe(true);
    expect(plan.querySelector(".action-background")?.textContent).toContain(opportunity.strategy.hypothesis);
    const evidence = plan.querySelector<HTMLDetailsElement>(".action-background .agent-sources")!;
    await act(async () => evidence.querySelector("summary")!.click());
    expect(evidence.querySelector("a")?.href).toBe(opportunity.sources[0].url);
    expect(evidence.textContent).toContain(opportunity.sources[0].quote);
  });

  it("keeps Act empty until an action is chosen, and reports missing or conflicting actions explicitly", async () => {
    const fetch = vi.fn(async (_path: string, options?: RequestInit) => options?.method === "PATCH"
      ? json({ error: "Reload before updating this action." }, 409) : json(snapshot));
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/#actions?business=${business.id}&action=${opportunity.id}`);
    await render(true);
    expect(container.textContent).toContain("No chosen actions yet");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("not in this business's saved plan");
    expect(container.querySelector(".growth-plan-item")).toBeNull();
    expect(container.querySelector('a[href^="#products"]')).toBeNull();
    fetch.mockResolvedValueOnce(json({ ...snapshot, plan: [planned] }));
    await click("Reload saved actions");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Reload before updating");
    expect(container.querySelector(".growth-plan-item summary")?.textContent).toContain("Planned");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
