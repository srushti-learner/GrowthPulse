// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsWorkspace } from "./AnalyticsWorkspace";
import type { AnalyticsData, SalesImport } from "../shared/analytics";

vi.mock("./AnalyticsCharts", () => ({
  SalesChart: () => <div data-testid="sales-chart">Sales chart</div>,
  OrdersChart: () => <div>Orders chart</div>,
  ForecastComparison: () => <div>Forecast comparison</div>,
  TrafficChart: () => <div>Traffic chart</div>,
}));
const id = "02a221ee-41f1-46c9-bc96-12401d8dcf73";
const importId = "63243bee-1f3a-40db-a516-93b04d40f797";
const version = "1234567890abcdef12345678";
const timestamp = "2026-11-16T12:00:00.000Z";
const record = { date: "2025-01-01", gross: 1_000_000, discounts: 100_000, reversals: 50_000, orders: 2, units: 3, sessions: null, purchasingSessions: null, cogs: null, operatingExpenses: null };
const empty: AnalyticsData = { currency: null, version, days: [], products: [], sources: [], imports: [], scenarios: [], warnings: [], traffic: null };
const loaded: AnalyticsData = { ...empty, version: "abcdef1234567890abcdef12", currency: "GBP", days: [record], sources: [{ name: "fixture.csv", kind: "import", createdAt: timestamp }] };
const draft: SalesImport = { id: importId, filename: "fixture.csv", createdAt: timestamp, committed: false, snapshot: { currency: "GBP", days: [record], accepted: 2, rejected: 1, excluded: 0, products: [], errors: ["Row 4: invalid price."], warnings: [] } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("analytics owner workflows", () => {
  let container: HTMLDivElement, root: Root;
  const expired = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.history.replaceState(null, "", "/#simulator");
    expired.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render() { await act(async () => root.render(<AnalyticsWorkspace onSessionExpired={expired} />)); }
  function fetcher(data: AnalyticsData, handler?: (path: string, options?: RequestInit) => Response) {
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/businesses") return json({ businesses: [{ id, name: "Fixture business", category: "", description: "", website: "", createdAt: timestamp, updatedAt: timestamp }] });
      if (path.endsWith("/analytics") && !options?.method) return json({ analytics: data });
      return handler ? handler(path, options) : json({ error: "Unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", fetch); return fetch;
  }
  async function click(text: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
    expect(button, text).toBeDefined(); await act(async () => button!.click());
  }
  async function set(selector: string, value: string) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(selector)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  it("shows a real empty state without fabricated metrics or forecasts", async () => {
    fetcher(empty); await render();
    expect(container.textContent).toContain("Your next chapter starts");
    expect(container.querySelector(".a-kpi-grid")).toBeNull();
    expect(container.textContent).toContain("No website or AI key needed");
  });
  it("previews raw CSV, requires rejected-row acknowledgement and confirms before replacing history", async () => {
    const fetch = fetcher(empty, (path) => path.includes("/commit") ? json({ analytics: loaded }) : json({ draft }, 201));
    await render(); await click("Import sales");
    await chooseCurrency();
    const file = new File(["order_id,date,quantity,unit_price"], "fixture.csv", { type: "text/csv" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("order_id,date,quantity,unit_price").buffer });
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Confirm baseline"))!;
    expect(confirm.disabled).toBe(true);
    expect(container.textContent).toContain("Row 4: invalid price.");
    expect(fetch.mock.calls.some(([, options]) => options?.headers && new Headers(options.headers).get("Content-Type") === "text/csv")).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('.a-review input[type="checkbox"]')!.click());
    await click("Confirm baseline import");
    const commit = fetch.mock.calls.find(([path]) => path.includes("/commit"))!;
    expect(JSON.parse(String(commit[1]?.body))).toEqual({ expectedVersion: version, confirmRejected: true });
    expect(container.textContent).toContain("Sales baseline saved");
    expect(container.textContent).toContain("£85.00");
    expect(container.textContent).toContain("£45.00");
  });
  it("saves owner entries with unknown costs left null rather than zero", async () => {
    const fetch = fetcher(empty, () => json({ analytics: loaded }, 201));
    await render(); await click("Owner entry");
    await chooseCurrency();
    await set('[name="date"]', "2025-01-01"); await set('[name="gross"]', "100");
    await set('[name="orders"]', "2"); await set('[name="evidence"]', "Daily register");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const call = fetch.mock.calls.find(([path]) => path.endsWith("/manual"))!;
    expect(JSON.parse(String(call[1]?.body)).entry.day).toMatchObject({ gross: 1_000_000, cogs: null, sessions: null, operatingExpenses: null });
  });
  it("keeps historical scenario previews local until explicitly saved and preserves actual KPIs", async () => {
    const fetch = fetcher(loaded, () => json({ analytics: { ...loaded, scenarios: [] } }, 201));
    await render(); await click("What if?");
    await set('input[aria-label="Order volume"]', "100");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("£170.00");
    await click("Save separate scenario");
    const call = fetch.mock.calls.find(([path]) => path.endsWith("/scenarios"))!;
    expect(JSON.parse(String(call[1]?.body)).scenario.ordersPct).toBe(100);
    expect(JSON.parse(String(call[1]?.body)).scenario.start).toBe("2025-01-01");
  });
  it("keeps the main view simple while retaining optional details and data requirements", async () => {
    fetcher(loaded); await render();
    expect(container.querySelector(".analytics-heading h2")?.textContent).toBe("Explore a change. Keep the facts.");
    expect(container.querySelectorAll(".a-kpi")).toHaveLength(3);
    const breakdown = [...container.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent === "Sales breakdown, profit and monthly orders")!;
    expect(breakdown.open).toBe(false);
    const requirements = [...container.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent === "What other data do I need?")!;
    expect(requirements.textContent).toContain("Use Import website visits");
    await click("Owner entry");
    const optional = container.querySelector<HTMLDetailsElement>(".a-input-panel details")!;
    expect(optional.open).toBe(false);
    expect(optional.querySelector('[name="sessions"]')).not.toBeNull();
    expect(optional.querySelector('[name="cogs"]')).not.toBeNull();
  });
  it("surfaces API failures and session expiry instead of presenting empty successful data", async () => {
    fetcher(empty);
    await render(); await click("Owner entry");
    await chooseCurrency();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Please log in to continue." }, 401)));
    await set('[name="date"]', "2025-01-01"); await set('[name="gross"]', "100"); await set('[name="orders"]', "1"); await set('[name="evidence"]', "Daily register");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(expired).toHaveBeenCalledOnce();
  });
  async function chooseCurrency() {
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(".a-currency select")!;
      select.value = "GBP"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  it("keeps the shared business selected and follows a different business deep link without starting jobs", async () => {
    const secondId = "02a221ee-41f1-46c9-bc96-12401d8dcf74";
    const businesses = [id, secondId].map((businessId, index) => ({
      id: businessId, name: `Channel ${index}`, category: "", description: "", website: "",
      createdAt: timestamp, updatedAt: timestamp,
    }));
    const selected = vi.fn();
    const fetch = vi.fn(async (path: string, _options?: RequestInit) => path === "/api/businesses" ? json({ businesses }) : json({ analytics: empty }));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<AnalyticsWorkspace onSessionExpired={expired} selectedBusinessId={secondId} onBusinessSelected={selected} />));
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Analytics business"]')?.value).toBe(secondId);
    expect(fetch.mock.calls.map(([path]) => path)).not.toContain(`/api/businesses/${id}/analytics`);
    await act(async () => {
      window.history.replaceState(null, "", `/#simulator?business=${id}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Analytics business"]')?.value).toBe(id);
    expect(selected).toHaveBeenLastCalledWith(id);
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it("does not mistake an unreadable saved baseline for an empty successful workspace", async () => {
    const fetch = vi.fn(async (path: string) => path === "/api/businesses"
      ? json({ businesses: [{ id, name: "Fixture", category: "", description: "", website: "", createdAt: timestamp, updatedAt: timestamp }] })
      : json({ error: "Saved sales could not be loaded." }, 500));
    vi.stubGlobal("fetch", fetch); await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Saved sales could not be loaded");
    expect(container.querySelector(".a-empty")).toBeNull();
    expect(container.textContent).not.toContain("Import sales history");
  });
  it("uses a saved growth recommendation only as context and keeps all uplift assumptions at zero", async () => {
    const opportunity = {
      id: "a".repeat(64), title: "Test clearer sizing", detail: "Check sizing questions with customers.", agents: ["growth"],
      sources: [{ id: "e_1111111111111111", url: "https://shop.example.test/", quote: "Five sizes.", capturedAt: timestamp }],
      reviewReason: "Saved evidence, not predicted uplift.",
      strategy: { objective: "Clearer sizing", actions: ["Review sizing."], metric: "Sales", hypothesis: "Test clearer sizing.", measurement: "Choose a control." },
    };
    window.history.replaceState(null, "", `/#simulator?business=${id}&action=${opportunity.id}`);
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/businesses") return json({ businesses: [{ id, name: "Fixture", category: "", description: "", website: "", createdAt: timestamp, updatedAt: timestamp }] });
      if (path.endsWith("/growth")) return json({ opportunities: [], plan: [{
        opportunity, status: "planned", impact: "unknown", effort: "unknown", timeToValue: "unknown", revision: 0, createdAt: timestamp, updatedAt: timestamp,
      }], researchStatus: "unavailable", evidenceSavedAt: null });
      if (path.endsWith("/scenarios")) return json({ analytics: { ...loaded, scenarios: [{
        id: importId, createdAt: timestamp, baselineVersion: loaded.version, days: loaded.days,
        input: JSON.parse(String(options?.body)).scenario,
      }] } }, 201);
      return json({ analytics: loaded });
    });
    vi.stubGlobal("fetch", fetch); await render();
    expect(container.textContent).toContain(`Exploring: ${opportunity.title}`);
    expect(container.querySelector<HTMLInputElement>('.a-field input[maxlength="80"]')?.value).toBe(opportunity.title);
    for (const label of ["Order volume", "Average order value", "Unit cost of goods"]) {
      expect(container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value).toBe("0");
    }
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    await click("Save separate scenario");
    const saved = fetch.mock.calls.find(([path]) => path.endsWith("/scenarios"))!;
    expect(JSON.parse(String(saved[1]?.body)).scenario).toMatchObject({ name: opportunity.title, ordersPct: 0, aovPct: 0, costPct: 0 });
    expect(container.textContent).toContain("Original sales records are unchanged");
  });
});
