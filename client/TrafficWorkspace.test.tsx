// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrafficWorkspace } from "./TrafficWorkspace";
import type { AnalyticsData } from "../shared/analytics";
import type { TrafficImport } from "../shared/traffic";

vi.mock("./AnalyticsCharts", () => ({ TrafficChart: () => <div>Traffic chart</div> }));
const id = "02a221ee-41f1-46c9-bc96-12401d8dcf73";
const version = "1234567890abcdef12345678";
const draft: TrafficImport = { id, filename: "daily-traffic.csv", sourceName: "GA sample", createdAt: "2026-11-16T12:00:00.000Z", committed: false, snapshot: { days: [
  { date: "2020-11-01", sessions: 100, purchasingSessions: 10, eventCount: 400, userCount: 80, missingSessionEvents: 0 },
  { date: "2020-11-02", sessions: 900, purchasingSessions: 0, eventCount: 3000, userCount: 700, missingSessionEvents: 0 },
] } };
const empty: AnalyticsData = { currency: null, version, days: [], products: [], sources: [], imports: [], scenarios: [], warnings: [], traffic: null };
const loaded: AnalyticsData = { ...empty, traffic: { ...draft, committed: true } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("traffic file workflow", () => {
  let container: HTMLDivElement, root: Root;
  const updated = vi.fn(), expired = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); updated.mockReset(); expired.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(data = empty, start = "2020-11-01", end = start) {
    await act(async () => root.render(<TrafficWorkspace businessId={id} data={data} start={start} end={end} onUpdated={updated} onSessionExpired={expired} />));
  }
  async function click(text: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
    expect(button).toBeDefined(); await act(async () => button!.click());
  }
  async function upload() {
    const file = new File(["date,sessions,purchasing_sessions\n2020-11-01,100,10"], "daily-traffic.csv", { type: "text/csv" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("date,sessions,purchasing_sessions").buffer });
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  it("requires review and explicit same-business confirmation before saving traffic, with no sales mutation", async () => {
    const fetch = vi.fn(async (path: string) => path.endsWith("/commit") ? json({ analytics: loaded }) : json({ draft }, 201));
    vi.stubGlobal("fetch", fetch); await render(); await click("Import website visits"); await upload();
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Confirm traffic import")!;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("no sales, order counts or revenue will be invented");
    await act(async () => container.querySelector<HTMLInputElement>('.a-review input[type="checkbox"]')!.click());
    await click("Confirm traffic import");
    expect(updated).toHaveBeenCalledWith(loaded);
    expect(fetch.mock.calls.every(([path]) => path.includes("/traffic-imports"))).toBe(true);
    expect(container.textContent).toContain("Sales history is unchanged");
  });
  it("shows weighted conversion from traffic alone and can match the selected sales range", async () => {
    await render(loaded);
    expect(container.querySelector(".a-traffic-totals")?.textContent).toContain("1.00%");
    expect(container.textContent).toContain("2 of 2 traffic dates");
    await act(async () => container.querySelector<HTMLInputElement>('.a-traffic-range input')!.click());
    expect(container.querySelector(".a-traffic-totals")?.textContent).toContain("10.00%");
    expect(container.textContent).toContain("1 of 2 traffic dates");
    expect(container.textContent).not.toContain("780");
  });
  it("returns expired sessions to authentication without pretending import succeeded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Please log in." }, 401)));
    await render(); await click("Import website visits"); await upload();
    expect(expired).toHaveBeenCalledOnce();
    expect(updated).not.toHaveBeenCalled();
  });
  it("ignores an old business's pending commit after switching workspaces", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((path: string) => path.endsWith("/commit")
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve(json({ draft }, 201))));
    await render(); await click("Import website visits"); await upload();
    await act(async () => container.querySelector<HTMLInputElement>('.a-review input[type="checkbox"]')!.click());
    await click("Confirm traffic import");
    await act(async () => root.render(<TrafficWorkspace key="other" businessId="02a221ee-41f1-46c9-bc96-12401d8dcf74" data={empty} start="" end="" onUpdated={updated} onSessionExpired={expired} />));
    await act(async () => finish(json({ analytics: loaded })));
    expect(updated).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Website visits saved");
  });
  it("does not turn a date range without traffic into zero visits", async () => {
    await render(loaded, "2021-01-01");
    await act(async () => container.querySelector<HTMLInputElement>('.a-traffic-range input')!.click());
    expect(container.querySelector(".a-traffic-totals")?.textContent).toContain("Not available");
    expect(container.textContent).toContain("Missing traffic is unknown, not zero visits");
  });
});
