// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisJob } from "../shared/analysis";
import type { ResearchStep } from "../shared/research";
import { AnalysisProgress } from "./AnalysisProgress";

const timestamp = "2026-11-19T06:00:00.000Z";
const step = (key: string, agent: ResearchStep["agent"], status: ResearchStep["status"] = "completed"): ResearchStep => ({
  key, agent, status, findings: [], limitations: [], diagnostic: null, reused: false,
  startedAt: timestamp, completedAt: status === "running" ? null : timestamp,
});
const job: AnalysisJob = {
  id: "9f1fb19f-04dc-41d7-ae01-8b5e238266fe", businessId: "02a221ee-41f1-46c9-bc96-12401d8dcf73",
  requestedUrl: "https://shop.example.com/", scanId: null, status: "running", phase: "validating",
  preview: null, understanding: null, error: null, createdAt: timestamp, updatedAt: timestamp, revision: 1,
  research: { version: 1, status: "running", enabled: true, steps: [], usage: { searches: 2, competitorScans: 1, modelCalls: 3 } },
};

describe("truthful live analysis activity", () => {
  let container: HTMLDivElement, root: Root;
  const cancel = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(timestamp));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); cancel.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  });
  const render = (value: AnalysisJob | null = job, showDetails = true) => act(async () => root.render(
    <AnalysisProgress job={value} phase={value?.phase ?? "connecting"} reusingScan={false} showDetails={showDetails} onCancel={cancel} />,
  ));
  const withSteps = (...steps: ResearchStep[]): AnalysisJob => ({ ...job, research: { ...job.research!, steps } });

  it("uses real active research instead of a stale validating phase and updates when the server does", async () => {
    const search = { ...step("discovery-search-0", "competitor"), search: { query: "cotton clothing independent brands", domains: ["brand.example.com"] } };
    const capture = { ...step("competitor-site-0", "competitor", "running"), capture: { url: "https://brand.example.com/", pages: 0 } };
    await render(withSteps(step("store", "store"), search, capture), false);
    expect(container.querySelector("[role=status]")?.textContent).toBe("Reviewing potential competitors' websites");
    expect(container.textContent).not.toContain("Checking sources and saving");
    expect(container.querySelector('[aria-label="Research specialists"] li[data-status=completed]')?.textContent).toContain("Store intelligence");
    expect(container.querySelector('[aria-label="Research specialists"] li[data-status=running]')?.textContent).toContain("Competitor intelligence");
    expect(container.textContent).not.toContain(search.search.query);
    expect(container.textContent).not.toContain("A candidate is not a verified competitor");
    expect(container.querySelector(".analysis-background")?.textContent).toBe("Your analysis continues if you leave this page.");
    expect(container.querySelector(".agent-progress-details")).toBeNull();
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(container.querySelector("[role=status]")?.textContent).toBe("Reviewing potential competitors' websites");
    await render(withSteps(step("store", "store"), search, { ...capture, status: "completed", completedAt: timestamp }, step("competitor-brand-0", "competitor", "running")));
    expect(container.querySelector("[role=status]")?.textContent).toBe("Checking which brands are relevant");
    await act(async () => container.querySelector<HTMLButtonElement>(".agent-progress button")!.click());
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps queued work separate from research and does not invent activity, findings or a percentage", async () => {
    await render({ ...job, status: "queued", research: undefined });
    expect(container.querySelector("[role=status]")?.textContent).toBe("Waiting to start...");
    expect(container.textContent).toContain("Research has not started yet");
    expect(container.querySelector(".analysis-counts")).toBeNull();
    expect(container.querySelector(".analysis-stages")).toBeNull();
    expect(container.querySelector('[role=progressbar], progress')).toBeNull();
    await act(async () => vi.advanceTimersByTime(46_000));
    expect(container.querySelector(".analysis-quiet")?.textContent).toBe("No recent update. You can keep waiting or cancel the analysis.");
    expect(container.querySelector("[role=status]")?.textContent).toBe("Waiting to start...");
    expect(container.querySelector(".analysis-elapsed")?.textContent).toContain("46s since requested");
  });

  it("distinguishes partial checks and failures from success and counts only cited pages", async () => {
    const store = step("store", "store");
    store.findings = [{
      kind: "observation", title: "Cotton range", detail: "The store describes cotton clothing.",
      sources: [{ id: "e_1111111111111111", url: job.requestedUrl, quote: "Our cotton clothing range for everyday wear.", capturedAt: timestamp }],
    }];
    const limited = { ...step("customer", "customer", "limited"), limitations: ["No permitted individual customer-review source is connected."] };
    const failed = { ...step("competitor-site-0", "competitor", "failed"), capture: { url: "https://brand.example.com/", pages: 0 },
      limitations: ["This candidate could not be read within public-site safety rules."] };
    await render(withSteps(store, limited, failed));
    expect(container.querySelector('.analysis-stages li[data-status=limited]')?.textContent).toContain("Customer intelligenceLimited evidence");
    expect(container.textContent).not.toContain(limited.limitations[0]);
    expect(container.textContent).not.toContain(failed.limitations[0]);
    expect(container.textContent).not.toContain("0 public pages captured");
    expect(container.textContent).not.toContain("No pages captured yet");
    expect(container.querySelector(".analysis-check-failure")?.textContent).toBe("Some information couldn't be checked. Please review the available findings before deciding.");
    expect([...container.querySelectorAll(".analysis-counts dd")].map((node) => node.textContent)).toEqual(["1", "1"]);
    expect(container.querySelector(".analysis-stages li:nth-child(2)")?.textContent).toContain("More checks pending");
    expect(container.querySelector(".analysis-stages li:last-child")?.textContent).toContain("Not started");
  });

  it("keeps earlier failures visible as activity grows and does not promise disabled specialists", async () => {
    const values = [step("store", "store", "failed"), ...Array.from({ length: 5 }, (_, i) => step(`discovery-search-${i}`, "competitor"))];
    values[0].limitations = ["The Store briefing could not be validated."];
    const value = withSteps(...values);
    value.research!.enabled = false;
    await render(value);
    expect(container.querySelector(".analysis-recent")).toBeNull();
    expect(container.querySelector('.analysis-stages li[data-status=failed]')?.textContent).toContain("Store intelligenceCould not finish");
    expect(container.querySelector(".analysis-check-failure")?.textContent).toBe("Some information couldn't be checked. Please review the available findings before deciding.");
    expect(container.querySelector(".analysis-check-failure")?.closest("details")).toBeNull();
    expect(container.querySelectorAll(".analysis-stages li")).toHaveLength(2);
    await render(null);
    expect(container.querySelector(".analysis-background")).toBeNull();
    expect(container.querySelector(".agent-progress button")).toBeNull();
  });

  it("omits the technical details disclosure and raw step log while keeping live activity", async () => {
    const search = { ...step("discovery-search-0", "competitor"), search: { query: "pickles official store -site:marketplace.example", domains: [] } };
    const capture = { ...step("competitor-site-0", "competitor", "running"), capture: { url: "https://brand.example.com/", pages: 0 } };
    const limited = { ...step("competitor-brand-0", "competitor", "limited"), limitations: [
      "The selected category quote did not contain all meaningful words of a merchant product category.",
      "Static public HTML only: no JavaScript execution, authentication, or website changes.",
    ] };
    await render(withSteps(search, capture, limited), false);
    expect(container.querySelector(".analysis-recent")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("Technical details");
    expect(container.textContent).not.toContain("recorded steps");
    expect(container.textContent).not.toContain("Behind the scenes");
    expect(container.textContent).not.toContain("All recorded steps");
    expect(container.textContent).not.toContain(search.search.query);
    expect(container.textContent).not.toContain("Public searches used:");
    expect(container.querySelector(".analysis-counts")?.textContent).not.toContain("searches");
    expect(container.textContent).not.toContain("private AI reasoning");
    expect(container.textContent).not.toContain("recorded server activity");
    expect(container.textContent).not.toContain("brand.example.com");
    for (const text of limited.limitations) expect(container.textContent).not.toContain(text);
    expect(container.querySelector("[role=status]")?.textContent).toBe("Reviewing potential competitors' websites");
  });

  it("keeps pricing limitations and failures visible without exposing implementation notes", async () => {
    const pricing = { ...step("pricing", "pricing", "limited"), limitations: [
      "Pricing coverage is unavailable: captured structured products include 5 merchant and 0 verified-competitor record(s).",
      "Cross-store SKUs and similar names do not establish an exact match; only matching valid GTINs are identified here.",
      "No price delta or unit-price advantage is calculated: market, quantities, tax, shipping and promotion conditions have not all been established.",
    ] };
    await render(withSteps(pricing));
    for (const text of pricing.limitations) expect(container.textContent).not.toContain(text);
    expect(container.querySelector('.analysis-stages li[data-status=limited]')?.textContent).toContain("Pricing intelligenceLimited evidence");
    const failure = "The pricing check could not read the saved evidence.";
    await render(withSteps({ ...pricing, status: "failed", limitations: [failure] }));
    expect(container.textContent).not.toContain(failure);
    expect(container.querySelector('.analysis-stages li[data-status=failed]')?.textContent).toContain("Pricing intelligenceCould not finish");
    expect(container.querySelector(".analysis-check-failure")?.textContent).toBe("Some information couldn't be checked. Please review the available findings before deciding.");
  });
});
