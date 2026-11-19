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
    expect(container.querySelector("[role=status]")?.textContent).toBe("Reading a candidate's public website");
    expect(container.textContent).not.toContain("Checking sources and saving");
    expect(container.querySelector('[aria-label="Research specialists"] li[data-status=completed]')?.textContent).toContain("Store intelligence");
    expect(container.querySelector('[aria-label="Research specialists"] li[data-status=running]')?.textContent).toContain("Competitor intelligence");
    expect(container.textContent).toContain(search.search.query);
    expect(container.textContent).toContain("A candidate is not a verified competitor");
    expect(container.querySelector(".analysis-background")?.textContent).toContain("Returning does not start another paid analysis");
    expect(container.querySelector(".agent-progress-details")).toBeNull();
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(container.querySelector("[role=status]")?.textContent).toBe("Reading a candidate's public website");
    await render(withSteps(step("store", "store"), search, { ...capture, status: "completed", completedAt: timestamp }, step("competitor-brand-0", "competitor", "running")));
    expect(container.querySelector("[role=status]")?.textContent).toBe("Checking a candidate brand's relevance");
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
    expect(container.textContent).toContain("No new progress update has arrived for 46s");
    expect(container.textContent).toContain("no retry is started automatically");
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
    expect(container.textContent).toContain(limited.limitations[0]);
    expect(container.textContent).toContain(failed.limitations[0]);
    expect(container.textContent).toContain("0 public pages captured");
    expect(container.textContent).not.toContain("No pages captured yet");
    expect([...container.querySelectorAll(".analysis-counts dd")].map((node) => node.textContent)).toEqual(["2", "1", "1"]);
    expect(container.querySelector(".analysis-stages li:nth-child(2)")?.textContent).toContain("More checks pending");
    expect(container.querySelector(".analysis-stages li:last-child")?.textContent).toContain("Not started");
  });

  it("keeps earlier failures inspectable as activity grows and does not promise disabled specialists", async () => {
    const values = [step("store", "store", "failed"), ...Array.from({ length: 5 }, (_, i) => step(`discovery-search-${i}`, "competitor"))];
    values[0].limitations = ["The Store briefing could not be validated."];
    const value = withSteps(...values);
    value.research!.enabled = false;
    await render(value);
    expect(container.querySelector(".analysis-recent details summary")?.textContent).toBe("All recorded steps (6)");
    expect(container.querySelector(".analysis-recent details")?.textContent).toContain(values[0].limitations[0]);
    expect(container.querySelectorAll(".analysis-stages li")).toHaveLength(2);
    await render(null);
    expect(container.querySelector(".analysis-background")).toBeNull();
    expect(container.querySelector(".agent-progress button")).toBeNull();
  });
});
