// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsDataSchema, moneyScale as M } from "../shared/analytics";
import { nextDate } from "../shared/analytics-math";
import { weeklyReport, type ActionMeasurement, type WeeklyReviewState } from "../shared/weekly-review";
import type { GrowthPlanItem } from "../shared/growth";
import { WeeklyGrowthReview } from "./WeeklyGrowthReview";

const business = "02a221ee-41f1-46c9-bc96-12401d8dcf73";
const secondBusiness = "12a221ee-41f1-46c9-bc96-12401d8dcf73";
const now = "2026-11-19T12:00:00.000Z";
const plan: GrowthPlanItem = {
  opportunity: { id: "a".repeat(64), title: "Clarify the product page", detail: "Check product details.", agents: ["growth"],
    sources: [], reviewReason: "Requires owner review.", strategy: {
      objective: "Clarify details.", actions: ["Review page."], metric: "Orders", hypothesis: "Check clarity.", measurement: "Compare records.",
    } },
  status: "planned", impact: "unknown", effort: "unknown", timeToValue: "unknown", revision: 0, createdAt: now, updatedAt: now,
};
function fixture(): WeeklyReviewState {
  const data = analyticsDataSchema.parse({
    currency: "GBP", version: "fixture", days: Array.from({ length: 14 }, (_, index) => ({
      date: nextDate("2026-11-02", index), gross: (index < 7 ? 100 : 110) * M, discounts: 0, reversals: 0, orders: 2, units: 2,
      cogs: null, operatingExpenses: null, sessions: null, purchasingSessions: null,
    })), products: [], imports: [], sources: [], scenarios: [], warnings: [],
  });
  return {
    version: "fixture", observedAt: now, coveredThrough: "2026-11-15", stale: false, observationCount: 1,
    current: weeklyReport(data, "2026-11-19"), reviews: [], measurements: [],
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("returning-owner weekly growth review", () => {
  let container: HTMLDivElement, root: Root;
  const expired = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); expired.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(businessId = business) {
    await act(async () => root.render(<WeeklyGrowthReview businessId={businessId} plan={[plan]} onSessionExpired={expired} expanded />));
  }
  it("shows a real complete-week pulse and saves a deduplicated report only after the owner asks", async () => {
    const state = fixture();
    const saved: WeeklyReviewState = { ...state, reviews: [{
      id: "23a221ee-41f1-46c9-bc96-12401d8dcf73", version: state.version, createdAt: now, report: state.current,
    }] };
    const fetch = vi.fn(async (_path: string, options?: RequestInit) => json(options?.method ? saved : state));
    vi.stubGlobal("fetch", fetch); await render();
    expect(container.textContent).toContain("Reporting weeks covered");
    expect(container.querySelector(".weekly-review-metrics")?.textContent).toContain("£770.00");
    expect(container.querySelector(".weekly-review-metrics")?.textContent).toContain("+10.0%");
    expect(container.textContent).toContain("do not prove causation");
    expect(fetch).toHaveBeenCalledOnce();
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save weekly review")!;
    await act(async () => save.click());
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({ expectedVersion: state.version, periodEnd: state.current.current.end });
    expect(container.textContent).toContain("Weekly review saved");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Weekly review saved")?.disabled).toBe(true);
    expect(container.textContent).toContain("Saved weekly reviews");
  });
  it("makes gaps and stale data actionable instead of displaying invented percentage changes", async () => {
    const state = fixture();
    state.current.current = { ...state.current.current, observedDates: 6, values: null };
    state.current.changes = []; state.stale = true;
    state.current.hasEstimates = true;
    vi.stubGlobal("fetch", vi.fn(async () => json(state)));
    await render();
    expect(container.textContent).toContain("Sales update needed");
    expect(container.textContent).toContain("Missing dates are unknown, not zero");
    expect(container.querySelector(".weekly-review-metrics")).toBeNull();
    expect(container.querySelector(".weekly-review-freshness a")?.getAttribute("href")).toBe(`#simulator?business=${business}&view=sales`);
    expect(container.textContent).toContain("includes owner estimates");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Save weekly review")).toBe(false);
  });
  it("starts a chosen saved action with an explicit metric and start date", async () => {
    const state = fixture();
    const fetch = vi.fn(async (_path: string, _options?: RequestInit) => json(state)); vi.stubGlobal("fetch", fetch);
    await render();
    const form = container.querySelector<HTMLFormElement>("form")!;
    form.querySelector<HTMLSelectElement>('[name="opportunityId"]')!.value = plan.opportunity.id;
    form.querySelector<HTMLSelectElement>('[name="metric"]')!.value = "orders";
    form.querySelector<HTMLInputElement>('[name="startDate"]')!.value = "2026-11-09";
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(fetch.mock.calls).toHaveLength(2);
    const call = fetch.mock.calls[1];
    expect(call[0]).toBe(`/api/businesses/${business}/action-measurements`);
    expect(JSON.parse(call[1]!.body as string)).toEqual({
      expectedVersion: "fixture", opportunityId: plan.opportunity.id, metric: "orders", startDate: "2026-11-09",
    });
    expect(container.textContent).toContain("Baseline saved");
  });
  it("records an owner decision against a due measurable outcome without calling it causal uplift", async () => {
    const state = fixture();
    const measurement: ActionMeasurement = {
      id: "23a221ee-41f1-46c9-bc96-12401d8dcf73", opportunityId: plan.opportunity.id, title: plan.opportunity.title,
      metric: "net", currency: "GBP", startDate: "2026-11-09", reviewDate: "2026-11-16", createdAt: now,
      baseline: { version: "original", period: state.current.previous, hasEstimates: false, warnings: [] },
      outcome: null, decision: null, note: "", decidedAt: null,
    };
    state.measurements = [{ measurement, status: "ready", observedDates: 7, value: 770 * M, percent: 10, hasEstimates: false, warnings: [] }];
    const saved = structuredClone(state);
    saved.measurements[0].status = "reviewed";
    saved.measurements[0].measurement = { ...measurement, decision: "revise", note: "Other campaigns also ran.", decidedAt: now,
      outcome: { version: "fixture", recordedAt: now, value: 770 * M, percent: 10, hasEstimates: false, warnings: [] } };
    const fetch = vi.fn(async (_path: string, options?: RequestInit) => json(options?.method ? saved : state));
    vi.stubGlobal("fetch", fetch); await render();
    const form = container.querySelector<HTMLFormElement>(".weekly-review-experiment form")!;
    form.querySelector<HTMLSelectElement>('[name="decision"]')!.value = "revise";
    form.querySelector<HTMLTextAreaElement>('[name="note"]')!.value = "Other campaigns also ran.";
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(fetch.mock.calls[1][0]).toContain(`action-measurements/${measurement.id}/decision`);
    expect(container.textContent).toContain("Decision recorded");
    expect(container.textContent).toContain("Outcome snapshot retained");
    expect(container.querySelector(".weekly-review-experiment form")).toBeNull();
  });
  it("surfaces stale-save failures and reloads explicitly without paid calls", async () => {
    const fetch = vi.fn(async (_path: string, options?: RequestInit) => options?.method
      ? json({ error: "Sales history changed. Reload the weekly review before saving." }, 409) : json(fixture()));
    vi.stubGlobal("fetch", fetch); await render();
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Save weekly review")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Sales history changed");
    expect(container.textContent).not.toContain("Weekly review saved");
    await act(async () => container.querySelector<HTMLButtonElement>(".form-error button")!.click());
    expect(fetch.mock.calls).toHaveLength(3);
    expect(fetch.mock.calls[2][1]?.method).toBeUndefined();
  });
  it("allows stopping an incomplete experiment without inventing an outcome or blocking a follow-up", async () => {
    const state = fixture();
    const measurement: ActionMeasurement = {
      id: "23a221ee-41f1-46c9-bc96-12401d8dcf73", opportunityId: plan.opportunity.id, title: plan.opportunity.title,
      metric: "net", currency: "GBP", startDate: "2026-11-09", reviewDate: "2026-11-16", createdAt: now,
      baseline: { version: "original", period: state.current.previous, hasEstimates: false, warnings: [] },
      outcome: null, decision: null, note: "", decidedAt: null,
    };
    state.measurements = [{ measurement, status: "needs_data", observedDates: 3, value: null, percent: null, hasEstimates: false, warnings: [] }];
    const saved = structuredClone(state);
    saved.measurements[0].status = "stopped";
    saved.measurements[0].measurement = { ...measurement, decision: "stop", note: "Could not continue.", decidedAt: now };
    const fetch = vi.fn(async (_path: string, options?: RequestInit) => json(options?.method ? saved : state));
    vi.stubGlobal("fetch", fetch); await render();
    const form = container.querySelector<HTMLFormElement>(".weekly-review-experiment form")!;
    form.querySelector<HTMLTextAreaElement>('[name="note"]')!.value = "Could not continue.";
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({ expectedVersion: "fixture", decision: "stop", note: "Could not continue." });
    expect(container.textContent).toContain("Stopped without outcome");
    expect(container.textContent).toContain("No measured outcome was recorded");
    expect(container.textContent).not.toContain("Observed outcome:");
    expect(container.querySelector('select[name="opportunityId"]')).not.toBeNull();
  });
  it("ignores an old business response and treats session expiry as authentication, not an empty review", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn((path: string) => path.includes(business)
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve(json({ error: "Please log in." }, 401)));
    vi.stubGlobal("fetch", fetch);
    await render(); await render(secondBusiness);
    await act(async () => finish(json(fixture())));
    expect(expired).toHaveBeenCalledOnce();
    expect(container.querySelector(".weekly-review-metrics")).toBeNull();
    expect(container.textContent).not.toContain("£770");
  });
});
