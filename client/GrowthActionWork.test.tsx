// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrowthActionWork } from "./GrowthActionWork";
import { BusinessWorkspace } from "./BusinessWorkspace";
import type { GrowthWorkResponse } from "../shared/growth";

const businessId = "02a221ee-41f1-46c9-bc96-12401d8dcf73", productId = "509e12ce-3028-4ed1-bdf7-329a26d470d8";
const timestamp = "2026-11-17T12:00:00.000Z", actionId = "a".repeat(64);
const source = { id: "e_1111111111111111", url: "https://shop.example.com/", quote: "Recorded cotton clothing.", capturedAt: timestamp };
const opportunity = {
  id: actionId, title: "Review seasonal clothing", detail: "Test a small seasonal presentation.", agents: ["growth" as const], sources: [source],
  reviewReason: "Owner validation required.", strategy: { objective: "Clarify choice", actions: ["Review a small test."], metric: "Enquiries", hypothesis: "Choice may be clearer.", measurement: "Record a baseline." },
};
const item = { opportunity, revision: 0, status: "planned" as const, impact: "unknown" as const, effort: "unknown" as const,
  timeToValue: "unknown" as const, createdAt: timestamp, updatedAt: timestamp };
const initial: GrowthWorkResponse = {
  opportunity, item, configured: true, catalogueFingerprint: "fixture", stale: false,
  products: [{ id: productId, businessId, name: "Cotton tee", description: "Recorded tee.", sku: "", gtin: "", listings: [], createdAt: timestamp, updatedAt: timestamp }],
  decision: { scope: "product", reason: "The saved description supports this candidate, subject to owner review.", sources: [source],
    candidates: [{ productId, reason: "Recorded clothing fits the proposed season.", sources: [source] }], createdAt: timestamp, catalogueFingerprint: "fixture" },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("connected action review and manual onboarding", () => {
  let container: HTMLDivElement, root: Root;
  const expired = vi.fn(), saved = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); expired.mockReset(); saved.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render() { await act(async () => root.render(<GrowthActionWork businessId={businessId} actionId={actionId} onSessionExpired={expired} onSaved={saved} />)); }
  async function click(text: string) {
    const button = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
    expect(button, text).toBeDefined(); await act(async () => button!.click());
  }
  async function change(selector: string, value: string) {
    await act(async () => {
      const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!;
      const prototype = element.tagName === "SELECT" ? HTMLSelectElement.prototype : element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  }
  it("shows evidence-backed suggestions without paid calls and requires confirmation before contextual generation", async () => {
    let snapshot = structuredClone(initial);
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (options?.method) {
        const input = JSON.parse(String(options.body));
        expect(input.revision).toBe(snapshot.item!.revision);
        const work = snapshot.opportunity.work ?? { decision: snapshot.decision, selection: null, steps: [] };
        if (path.endsWith("/selection")) {
          expect(input).toEqual({ revision: 0, catalogueFingerprint: "fixture", scope: "product", productIds: [productId] });
          work.selection = { scope: "product", products: [{ productId, fingerprint: "current" }], confirmedAt: timestamp };
        } else if (path.endsWith("/proposals")) {
          expect(input.consent).toBe(true);
          work.steps = [{ id: "b".repeat(64), title: "Validate the seasonal display", detail: "Approve a small test after reviewing the baseline.", sources: [source],
            status: "draft", outcome: "", origin: "action" }];
        } else if (path.endsWith("/steps")) {
          work.steps[0] = { ...work.steps[0], status: input.status, outcome: input.outcome };
        } else throw new Error(`Unexpected mutation ${path}`);
        snapshot = { ...snapshot, opportunity: { ...opportunity, work }, item: { ...item, opportunity: { ...opportunity, work }, revision: snapshot.item!.revision + 1 } };
      }
      return json(snapshot);
    });
    vi.stubGlobal("fetch", fetch); await render();
    expect(container.textContent).toContain(initial.decision!.reason);
    expect(container.textContent).toContain(initial.decision!.candidates[0].reason);
    expect(container.querySelector<HTMLInputElement>('input[name="actionProduct"]')?.checked).toBe(true);
    expect(container.textContent).not.toContain("Generate action-specific steps");
    expect(fetch).toHaveBeenCalledOnce();
    await click("Confirm scope and targets");
    expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1 }));
    expect(container.textContent).toContain("No product or website was changed");
    await click("Generate action-specific steps");
    expect(container.textContent).toContain("Validate the seasonal display");
    expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2 }));
    await change(".action-supporting-step select", "measured");
    expect(container.querySelector<HTMLTextAreaElement>(".action-supporting-step textarea")?.required).toBe(true);
    await change(".action-supporting-step textarea", "Observed five enquiries in the recorded window.");
    await click("Save step progress");
    expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 3 }));
    expect(container.textContent).toContain("owner-reported, not automatically verified");
    expect(fetch.mock.calls.filter(([, options]) => options?.method).map(([path]) => path.split("/").pop())).toEqual(["selection", "proposals", "steps"]);
  });
  it.each(["business", "new_product", "unclear"] as const)("does not force product selection or automatically call AI for %s scope", async (scope) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ...initial, products: [], decision: { ...initial.decision, scope, candidates: [] },
    })));
    await render(); expect(container.querySelector('input[name="actionProduct"]')).toBeNull();
    expect(container.textContent).toContain(initial.decision!.reason);
    expect(saved).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });
  it("does not silently add an unsaved recommendation or show successful work after a revision conflict", async () => {
    const fetch = vi.fn(async (_path: string, options?: RequestInit) => options?.method
      ? json({ error: "This action changed. Reload before updating." }, 409) : json({ ...initial, item: null }));
    vi.stubGlobal("fetch", fetch); await render();
    expect(container.textContent).toContain("Add this recommendation to your plan");
    expect(container.querySelector("form")).toBeNull(); expect(fetch).toHaveBeenCalledOnce();
    await click("Add to my growth plan");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("This action changed");
    expect(saved).not.toHaveBeenCalled();
  });
  it("shows a usable no-website form with Back and saves without analysis or a second website request", async () => {
    const business = { id: businessId, name: "Owner shop", website: "", category: "Clothing", description: "Local clothing business.", createdAt: timestamp, updatedAt: timestamp };
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path !== "/api/businesses") throw new Error(`Unexpected request ${path}`);
      return json(options?.method ? { business } : { businesses: [] });
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<BusinessWorkspace activityOnly={false} profileOnly manualEntry businessManaged onSessionExpired={expired} onBusinessSelected={saved} />));
    expect(container.querySelector('input[name="website"]')).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector('a[href="#overview?view=setup&new=1"]')?.textContent).toContain("Back to website setup");
    await change('[name="businessName"]', business.name); await change('[name="category"]', business.category); await change('[name="description"]', business.description);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(JSON.parse(String(fetch.mock.calls.find(([, options]) => options?.method === "POST")![1]?.body))).toEqual({
      name: business.name, website: "", category: business.category, description: business.description,
    });
    expect(container.textContent).toContain("Business profile saved");
    expect(fetch.mock.calls.every(([path]) => path === "/api/businesses")).toBe(true);
    expect(saved).toHaveBeenCalledWith(businessId);
  });
});
