// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsWorkspace } from "./AnalyticsWorkspace";
import type { AnalyticsData, SalesImport } from "../shared/analytics";
import { nextDate } from "../shared/analytics-math";

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
const headers = { headers: ["order_id", "date", "quantity", "unit_price"], suggestions: ["order", "date", "quantity", "price"], issues: [] };
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
  function fetcher(data: AnalyticsData, handler?: (path: string, options?: RequestInit) => Response | Promise<Response>) {
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
  async function select(selector: string, value: string) {
    await act(async () => {
      const input = container.querySelector<HTMLSelectElement>(selector)!;
      input.value = value; input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  async function chooseFile(name = "fixture.csv") {
    const file = new File(["order_id,date,quantity,unit_price"], name, { type: "text/csv" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("order_id,date,quantity,unit_price").buffer });
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Sales file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  it("shows a real empty state without fabricated metrics or forecasts", async () => {
    fetcher(empty); await render();
    expect(container.textContent).toContain("Your next chapter starts");
    expect(container.querySelector(".a-kpi-grid")).toBeNull();
    expect(container.textContent).toContain("No website or AI key needed");
  });
  it("opens real sales rather than projections when returning from progress review", async () => {
    window.history.replaceState(null, "", `/#simulator?business=${id}&view=sales`);
    const fetch = fetcher(loaded);
    await act(async () => root.render(<AnalyticsWorkspace studio businessManaged selectedBusinessId={id} onSessionExpired={expired} />));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("My sales");
    expect(container.querySelector(".a-kpi-grid")).not.toBeNull();
    expect(container.querySelector('select[aria-label="Analytics business"]')).toBeNull();
    expect(fetch.mock.calls.some(([, options]) => options?.method)).toBe(false);
  });
  it("automatically previews recognised CSV without importing, requires rejected-row acknowledgement and confirms replacement", async () => {
    const note = "Missing dates are unknown, not zero sales.";
    const reviewedDraft = { ...draft, snapshot: { ...draft.snapshot, warnings: [note] } };
    const fetch = fetcher(empty, (path) => path.includes("/commit") ? json({ analytics: loaded }) : path.includes("mode=headers") ? json(headers) : json({ draft: reviewedDraft }, 201));
    await render(); await click("Import sales");
    await chooseCurrency();
    await chooseFile();
    expect(container.querySelector('[aria-label="Sales column mapping"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Review sales import"]')).not.toBeNull();
    expect(container.querySelectorAll('[aria-label^="Map column"]')).toHaveLength(0);
    expect(fetch.mock.calls.some(([path]) => path.includes("/commit"))).toBe(false);
    const preview = fetch.mock.calls.find(([path]) => path.includes("mode=preview"))!;
    expect(JSON.parse(new URL(preview[0], window.location.origin).searchParams.get("mapping")!)).toEqual(headers.suggestions);
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Confirm sales import"))!;
    expect(confirm.disabled).toBe(true);
    expect(container.textContent).toContain("Row 4: invalid price.");
    expect(container.textContent).toContain("replaces your imported sales history; it does not add");
    const notes = container.querySelector<HTMLDetailsElement>(".a-import-notes")!;
    expect(notes.open).toBe(false);
    expect(notes.querySelector("li")?.textContent).toBe(note);
    expect(container.querySelector(".a-row-errors")?.closest("details")).toBeNull();
    expect(confirm.closest("details")).toBeNull();
    await act(async () => notes.querySelector("summary")!.click());
    expect(notes.open).toBe(true);
    expect(fetch.mock.calls.some(([, options]) => options?.headers && new Headers(options.headers).get("Content-Type") === "text/csv")).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('.a-review input[type="checkbox"]')!.click());
    await click("Confirm sales import");
    const commit = fetch.mock.calls.find(([path]) => path.includes("/commit"))!;
    expect(JSON.parse(String(commit[1]?.body))).toEqual({ expectedVersion: version, confirmRejected: true });
    expect(container.textContent).toContain("Sales baseline saved");
    expect(container.textContent).toContain("£85.00");
    expect(container.textContent).toContain("£45.00");
  });
  it("lets owners correct suggestions, blocks missing/duplicate fields, and invalidates previews on edits", async () => {
    const customHeaders = { headers: ["Ticket", "When", "Count", "Each", "Email"], suggestions: [null, null, null, null, null], issues: [] };
    const fetch = fetcher(empty, (path) => path.includes("mode=headers") ? json(customHeaders) : json({ draft }, 201));
    await render(); await click("Import sales"); await chooseCurrency(); await chooseFile();
    const approve = () => [...container.querySelectorAll("button")].find((item) => item.textContent === "Preview sales")!;
    expect(approve().disabled).toBe(true);
    expect(container.textContent).toContain("Match required fields");
    expect(container.textContent).toContain("YYYY-MM-DD");
    expect(container.textContent).toContain("daily totals");
    for (const [index, field] of ["order", "date", "quantity", "price"].entries()) await select(`[aria-label^="Map column ${index + 1}:"]`, field);
    expect(approve().disabled).toBe(false);
    await select('[aria-label^="Map column 5:"]', "price");
    expect(approve().disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("only once");
    await select('[aria-label^="Map column 5:"]', "");
    await click("Preview sales");
    const preview = fetch.mock.calls.find(([path]) => path.includes("mode=preview"))!;
    expect(JSON.parse(new URL(preview[0], window.location.origin).searchParams.get("mapping")!)).toEqual(["order", "date", "quantity", "price", null]);
    expect(container.querySelector('[aria-label="Review sales import"]')).not.toBeNull();
    await click("Edit column matching");
    await select('[aria-label^="Map column 4:"]', "");
    expect(container.querySelector('[aria-label="Review sales import"]')).toBeNull();
    expect(approve().disabled).toBe(true);
    expect(fetch.mock.calls.some(([path]) => path.includes("/commit"))).toBe(false);
  });
  it("surfaces header syntax and mapping validation errors rather than creating a successful preview", async () => {
    let inspectError = true;
    fetcher(empty, (path) => path.includes("mode=headers")
      ? inspectError ? json({ error: "CSV syntax error near row 3. Check quoting and column counts." }, 400) : json(headers)
      : json({ error: "Column mapping must match every source column." }, 400));
    await render(); await click("Import sales"); await chooseCurrency(); await chooseFile();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("CSV syntax error");
    expect(container.querySelector('[aria-label="Sales column mapping"]')).toBeNull();
    inspectError = false; await chooseFile();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Column mapping");
    expect(container.querySelector('[aria-label="Review sales import"]')).toBeNull();
  });
  it("only asks about an unclear price while retaining other matches and skipped private columns", async () => {
    const fetch = fetcher(empty, (path) => path.includes("mode=headers") ? json({
      headers: ["order_id", "date", "quantity", "Price", "Email"],
      suggestions: ["order", "date", "quantity", null, null],
      issues: [{ column: 3, field: "price", reason: "unit_price" }],
    }) : json({ draft }, 201));
    await render(); await click("Import sales"); await chooseCurrency(); await chooseFile();
    expect(fetch.mock.calls.some(([path]) => path.includes("mode=preview"))).toBe(false);
    const questions = container.querySelector('[aria-label="Sales column mapping"] > fieldset')!;
    expect(questions.querySelectorAll("select")).toHaveLength(1);
    expect(questions.textContent).toContain("price of one unit");
    const other = container.querySelector<HTMLDetailsElement>('[aria-label="Sales column mapping"] details')!;
    expect(other.open).toBe(false);
    await select('[aria-label^="Map column 4:"]', "price");
    await click("Preview sales");
    const preview = fetch.mock.calls.find(([path]) => path.includes("mode=preview"))!;
    expect(JSON.parse(new URL(preview[0], window.location.origin).searchParams.get("mapping")!)).toEqual(["order", "date", "quantity", "price", null]);
    expect(fetch.mock.calls.some(([path]) => path.includes("/commit"))).toBe(false);
  });
  it("clears file/mapping/draft on currency changes and ignores aborted header responses", async () => {
    let finish!: (response: Response) => void;
    const fetch = fetcher(empty, (path) => path.includes("mode=headers")
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : json({ draft }, 201));
    await render(); await click("Import sales"); await chooseCurrency(); await chooseFile();
    const request = fetch.mock.calls.find(([path]) => path.includes("mode=headers"))!;
    await select(".a-currency select", "USD");
    expect(request[1]?.signal?.aborted).toBe(true);
    await act(async () => finish(json(headers)));
    expect(container.querySelector('[aria-label="Sales column mapping"]')).toBeNull();
    expect(container.querySelector('[aria-label="Review sales import"]')).toBeNull();
    expect(container.querySelector<HTMLSelectElement>(".a-currency select")!.value).toBe("USD");
  });
  it("ignores replaced-file responses and clears the old preview before reading the replacement", async () => {
    let finish!: (response: Response) => void;
    let hold = false;
    fetcher(empty, (path) => path.includes("mode=headers")
      ? hold ? new Promise<Response>((resolve) => { finish = resolve; }) : json(headers)
      : json({ draft }, 201));
    await render(); await click("Import sales"); await chooseCurrency(); await chooseFile();
    hold = true; await chooseFile("old.csv");
    expect(container.querySelector('[aria-label="Review sales import"]')).toBeNull();
    expect(container.querySelector('[aria-label="Sales column mapping"]')).toBeNull();
    hold = false; await chooseFile("replacement.csv");
    await act(async () => finish(json({ headers: ["Stale"], suggestions: [null], issues: [] })));
    expect(container.textContent).not.toContain("Stale");
    expect(container.querySelector('[aria-label="Review sales import"]')).not.toBeNull();
    await click("Edit column matching");
    expect(container.querySelectorAll('[aria-label^="Map column"]')).toHaveLength(4);
  });
  it("ignores an in-flight mapped preview when the selected business changes", async () => {
    const secondId = "02a221ee-41f1-46c9-bc96-12401d8dcf74";
    let finish!: (response: Response) => void;
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/businesses") return json({ businesses: [id, secondId].map((businessId) => ({ id: businessId, name: "Fixture", category: "", description: "", website: "", createdAt: timestamp, updatedAt: timestamp })) });
      if (!options?.method) return json({ analytics: empty });
      if (path.includes("mode=headers")) return json(headers);
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<AnalyticsWorkspace selectedBusinessId={id} onSessionExpired={expired} />));
    await click("Import sales"); await chooseCurrency(); await chooseFile();
    const preview = fetch.mock.calls.find(([path]) => path.includes("mode=preview"))!;
    await act(async () => root.render(<AnalyticsWorkspace selectedBusinessId={secondId} onSessionExpired={expired} />));
    expect(preview[1]?.signal?.aborted).toBe(true);
    await act(async () => finish(json({ draft }, 201)));
    await click("Import sales");
    expect(container.querySelector('[aria-label="Review sales import"]')).toBeNull();
    expect(container.querySelector('[aria-label="Sales column mapping"]')).toBeNull();
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
  it("separates historical sales from dated forecasts and keeps traffic optional", async () => {
    fetcher({ ...loaded, days: Array.from({ length: 28 }, (_, index) => ({ ...record, date: nextDate(record.date, index * 2) })) });
    await render();
    expect(container.querySelector(".a-forecast-card")).toBeNull();
    expect(container.querySelector<HTMLDetailsElement>(".a-optional-traffic")?.open).toBe(false);
    await click("Forecast");
    expect(container.querySelectorAll(".a-kpi")).toHaveLength(0);
    expect(container.querySelector(".a-optional-traffic")).toBeNull();
    expect(container.querySelector('[aria-label="Forecast period"]')?.textContent).toContain("25 Feb 2025 – 26 Mar 2025");
    expect(container.textContent).toContain("not a forecast starting today");
    expect(container.textContent).toContain("27 calendar days in this range have no sales record");
  });
  it("distinguishes existing same-name saves and restores their own assumptions and save date", async () => {
    const input = { name: "My growth scenario", start: record.date, end: record.date, ordersPct: 10, aovPct: 0, costPct: 0 };
    const secondId = "63243bee-1f3a-40db-a516-93b04d40f798";
    const fetch = fetcher({ ...loaded, scenarios: [
      { id: importId, createdAt: timestamp, baselineVersion: loaded.version, days: loaded.days, input },
      { id: secondId, createdAt: timestamp, baselineVersion: version, days: loaded.days, input: { ...input, ordersPct: 0, aovPct: 5 } },
      { id: "63243bee-1f3a-40db-a516-93b04d40f799", createdAt: timestamp, baselineVersion: loaded.version, days: loaded.days, input },
    ] });
    await render(); await click("What if?");
    const options = [...container.querySelectorAll(".a-scenario-controls select option")].map((item) => item.textContent);
    expect(options).toEqual(["Unsaved scenario", "#3 My growth scenario · Orders +10%", "#2 My growth scenario · Spend/order +5% · older baseline", "#1 My growth scenario · Orders +10%"]);
    await select(".a-scenario-controls select", secondId);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Average order value change (%)"]')?.value).toBe("5");
    expect(container.textContent).toContain("Saved 16 Nov 2026");
    expect(container.textContent).toContain("belongs to an older baseline");
    await select(".a-scenario-controls select", importId);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Order volume change (%)"]')?.value).toBe("10");
    expect(fetch.mock.calls.some(([, options]) => options?.method)).toBe(false);
  });
  it("prevents repeated saves and re-enables saving only for a different scenario", async () => {
    const input = { name: "My growth scenario", start: record.date, end: record.date, ordersPct: 10, aovPct: 0, costPct: 0 };
    const fetch = fetcher(loaded, (_path, options) => json({ analytics: { ...loaded, scenarios: [{
      id: importId, createdAt: timestamp, baselineVersion: loaded.version, days: loaded.days,
      input: JSON.parse(String(options?.body)).scenario,
    }] } }, 201));
    await render(); await click("What if?");
    await set('[aria-label="Order volume change (%)"]', String(input.ordersPct));
    await click("Save separate scenario");
    const saveButton = () => [...container.querySelectorAll("button")].find((item) => item.textContent === "Save separate scenario")!;
    expect(saveButton().disabled).toBe(true);
    expect(container.textContent).toContain("These settings are already saved");
    await click("Save separate scenario");
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    await set('[aria-label="Order volume change (%)"]', "20");
    expect(saveButton().disabled).toBe(false);
    await set('[aria-label="Order volume change (%)"]', "10");
    expect(saveButton().disabled).toBe(true);
    await set('.a-scenario-controls input[maxlength="80"]', "  My growth scenario  ");
    expect(saveButton().disabled).toBe(true);
    await set('.a-scenario-controls input[maxlength="80"]', "A different scenario");
    expect(saveButton().disabled).toBe(false);
  });
  it("allows saving the same settings on a new baseline without overwriting the old snapshot", async () => {
    fetcher({ ...loaded, scenarios: [{
      id: importId, createdAt: timestamp, baselineVersion: version, days: loaded.days,
      input: { name: "My growth scenario", start: record.date, end: record.date, ordersPct: 0, aovPct: 0, costPct: 0 },
    }] });
    await render(); await click("What if?");
    expect([...container.querySelectorAll("button")].find((item) => item.textContent === "Save separate scenario")?.disabled).toBe(false);
    expect(container.textContent).not.toContain("These settings are already saved");
  });
  it("guides the chosen assumption without inventing uplift, supports exact inputs and suppresses invalid comparisons", async () => {
    const fetch = fetcher(loaded); await render(); await click("What if?");
    await click("Higher spending per order");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Average order value change (%)");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Average order value change (%)"]')?.value).toBe("0");
    await set('[aria-label="Average order value change (%)"]', "20");
    expect(container.querySelector('[aria-label="Net sales comparison"]')?.textContent).toContain("What-if net sales£102.00Difference in net sales+£17.00");
    expect(container.textContent).toContain("does not predict the future effect");
    await click("Changed product costs");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Unit cost of goods change (%)");
    expect(container.textContent).toContain("Unknown costs stay unknown");
    await set('[aria-label="Average order value change (%)"]', "300");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Average order value"]')?.value).toBe("300");
    await set('[aria-label="Average order value change (%)"]', "");
    expect(container.querySelector('[aria-label="Net sales comparison"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("-100% and 300%");
    expect([...container.querySelectorAll("button")].find((item) => item.textContent?.includes("Save separate scenario"))?.disabled).toBe(true);
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it("compares only the historical period being changed and rejects periods with no observations", async () => {
    fetcher({ ...loaded, days: [record, { ...record, date: "2025-01-02" }] });
    await render(); await click("What if?");
    await set('.a-two-fields label:last-child input', "2025-01-01");
    await set('[aria-label="Average order value change (%)"]', "100");
    expect(container.querySelector('[aria-label="Net sales comparison"]')?.textContent).toContain("Original net sales£85.00What-if net sales£170.00Difference in net sales+£85.00");
    await set('.a-two-fields label:last-child input', "2025-02-02");
    await set('.a-two-fields label:first-child input', "2025-02-01");
    expect(container.querySelector('[aria-label="Net sales comparison"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("containing recorded sales");
    expect([...container.querySelectorAll("button")].find((item) => item.textContent?.includes("Save separate scenario"))?.disabled).toBe(true);
  });
  it("restores the growth-action link from a saved scenario without requiring the original deep link", async () => {
    const opportunityId = "b".repeat(64);
    fetcher({ ...loaded, scenarios: [{
      id: importId, createdAt: timestamp, baselineVersion: loaded.version, days: loaded.days,
      input: { name: "Saved action scenario", start: record.date, end: record.date, ordersPct: 0, aovPct: 0, costPct: 0, opportunityId },
    }] });
    await render(); await click("What if?");
    await select(".a-scenario-controls select", importId);
    expect(container.querySelector('a.a-linked-action')?.getAttribute("href")).toBe(`#actions?business=${id}&action=${opportunityId}`);
    await set('[aria-label="Order volume change (%)"]', "15");
    expect(container.querySelector('a.a-linked-action')?.getAttribute("href")).toContain(opportunityId);
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
    expect(container.querySelector('.analytics-alert a[href^="#actions"]')?.getAttribute("href")).toBe(`#actions?business=${id}&action=${opportunity.id}`);
    expect(container.querySelector<HTMLInputElement>('.a-field input[maxlength="80"]')?.value).toBe(opportunity.title);
    for (const label of ["Order volume", "Average order value", "Unit cost of goods"]) {
      expect(container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value).toBe("0");
    }
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    await click("Save separate scenario");
    const saved = fetch.mock.calls.find(([path]) => path.endsWith("/scenarios"))!;
    expect(JSON.parse(String(saved[1]?.body)).scenario).toMatchObject({ name: opportunity.title, opportunityId: opportunity.id, ordersPct: 0, aovPct: 0, costPct: 0 });
    expect(container.querySelector('a.a-linked-action')?.getAttribute("href")).toBe(`#actions?business=${id}&action=${opportunity.id}`);
    expect(container.textContent).toContain("Original sales records are unchanged");
  });
});
