// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchReport as Report, ResearchStep } from "../shared/research";
import { ResearchReport } from "./ResearchReport";

const source = { id: "e_1111111111111111", url: "https://brand.example/products", quote: "Our cotton shirts come in five sizes. A two-pack costs GBP 40.", capturedAt: "2026-11-16T12:00:00.000Z" };
const observation = { kind: "observation" as const, title: "A published cotton range", detail: "The captured brand offers cotton shirts in five sizes.", sources: [source] };
const hypothesis = { kind: "hypothesis" as const, title: "A sizing question to investigate", detail: "This captured sample might leave a sizing need unresolved; customer demand is not established.", sources: [source] };
const suggestion = { kind: "suggestion" as const, title: "Run a merchandising experiment", detail: "This recommendation belongs in Growth intelligence.", sources: [source] };
const base: ResearchStep = { key: "competitor", agent: "competitor", status: "completed", findings: [observation, suggestion],
  limitations: [], diagnostic: null, startedAt: source.capturedAt, completedAt: source.capturedAt, reused: false };
const brand: NonNullable<ResearchStep["profile"]> = {
  name: "Fixture Brand", url: "https://brand.example/", relevance: "Publishes a related cotton clothing range.", marketVerified: false,
  facts: [{ dimension: "products", text: "Cotton shirts in five sizes.", sourceId: source.id },
    { dimension: "pricing", text: "Two-pack GBP 40.", sourceId: source.id }],
  sources: [source], limitations: ["Delivery market overlap is not confirmed.", "Unsupported or duplicate comparison quotes were omitted.",
    "Published claims are not independently verified sales, demand or market-share evidence."],
};
const report: Report = { version: 1, status: "partial", enabled: true, usage: { modelCalls: 4, searches: 1, competitorScans: 1 },
  steps: [base, { ...base, key: "competitor-brand-0", findings: [], profile: brand },
    { ...base, key: "store", agent: "store", findings: [{ ...observation, title: "Private Store context" }] },
    { ...base, key: "opportunity", agent: "opportunity", findings: [hypothesis, suggestion,
      { ...hypothesis, title: "Store-only idea", sources: [{ ...source, url: "https://merchant.example/" }] }] },
    { ...base, key: "pricing", agent: "pricing", findings: [], limitations: ["Quantities and delivery costs have not all been established."] },
    { ...base, key: "competitor-brand-1", status: "failed", profile: { ...brand, name: "Unaccepted Brand", url: "https://failed.example/" },
      findings: [{ ...observation, title: "Do not promote this failed result" }] }],
};

describe("research-first market intelligence", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Browsing market evidence must not start a request."); }));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(value = report) {
    await act(async () => root.render(<ResearchReport report={value} businessName="Fixture Shop" briefingKey="market" initialView="intelligence" />));
  }
  function panel() { return container.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!; }
  async function click(label: string) {
    const button = Array.from(panel().querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.startsWith(label))!;
    expect(button, label).toBeDefined();
    await act(async () => button.click());
  }

  it("leads with accepted external evidence and labels AI suggestions without exposing Store context", async () => {
    await render();
    expect(panel().querySelectorAll('[data-slot="card"]')).toHaveLength(3);
    expect(panel().querySelectorAll(".market-area-link")).toHaveLength(6);
    expect(panel().textContent).toContain(observation.title);
    expect(panel().textContent).toContain("1 verified brand");
    expect(panel().textContent).toContain("1 hypothesis to validate");
    expect(panel().textContent).not.toContain("Private Store context");
    expect(panel().querySelector(".market-summary")?.textContent).toContain(observation.detail);
    expect(panel().querySelector(".market-summary")?.textContent).not.toContain(suggestion.title);
    expect(panel().querySelector(".market-signals")?.textContent).toContain(suggestion.detail);
    expect(panel().querySelector(".market-signals")?.textContent).toContain("AI suggestion");
    expect(panel().querySelector(".market-signals")?.textContent).toContain("Hypothesis / needs validation");
    expect(panel().textContent).not.toContain("Do not promote this failed result");
    expect(panel().querySelector(".research-agent-nav")).toBeNull();
    expect(panel().querySelector('a[href="#growth"]')).not.toBeNull();
    await click("Competitors");
    expect(panel().querySelectorAll(".market-brand")).toHaveLength(1);
    expect(panel().textContent).toContain("Market overlap unconfirmed");
    expect(panel().textContent).not.toContain(suggestion.title);
    expect(panel().textContent).not.toContain("Unaccepted Brand");
    const fullComparison = panel().querySelector<HTMLDetailsElement>(".market-full-comparison")!;
    await act(async () => fullComparison.querySelector("summary")!.click());
    expect(fullComparison.open).toBe(true);
    expect(fullComparison.querySelector("summary")?.textContent).toBe("Full comparison");
    expect(fullComparison.querySelector("table")?.textContent).toContain(brand.facts[0].text);
    expect(panel().textContent).not.toContain(brand.relevance);
    for (const limitation of brand.limitations) expect(panel().textContent).not.toContain(limitation);
    expect(panel().textContent).not.toContain("Not captured means unknown, not absent.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("compares one published topic at a time without claiming a unit-price advantage", async () => {
    await render(); await click("Pricing");
    expect(document.activeElement?.textContent).toBe("Pricing");
    expect(panel().querySelector(".market-topics [aria-pressed=true]")?.textContent).toBe("Published prices and packs");
    expect(panel().querySelectorAll(".market-topics button")).toHaveLength(2);
    expect(panel().querySelector(".market-product-fact")?.textContent).toBe("Two-pack GBP 40.");
    expect(panel().textContent).toContain("not a cheapest-to-most-expensive ranking");
    await click("View source");
    expect(panel().querySelector(".market-selected-fact a")?.getAttribute("href")).toBe(source.url);
    expect(panel().querySelector(".market-selected-fact time")?.getAttribute("datetime")).toBe(source.capturedAt);
    await click("Market overview"); await click("Product landscape");
    expect(panel().querySelector(".market-topics [aria-pressed=true]")?.textContent).toBe("Products and customer need");
    expect(panel().querySelector(".market-product-fact")?.textContent).toBe("Cotton shirts in five sizes.");
    expect(panel().textContent).not.toContain("not sales rankings");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes technical pricing paragraphs from saved market research without changing evidence", async () => {
    const technicalNotes = [
      "Pricing coverage is unavailable: captured structured products include 5 merchant and 0 verified-competitor record(s).",
      "Cross-store SKUs and similar names do not establish an exact match; only matching valid GTINs are identified here.",
      "GTINs and offer values must appear in retained product quotes. Fields outside those excerpts are not presented as cited pricing evidence.",
      "No price delta or unit-price advantage is calculated: market, quantities, tax, shipping and promotion conditions have not all been established.",
      "At most 5 structured products per scanned site are sampled. No match in this sample does not mean there is no competing product.",
    ];
    const value: Report = { ...report, steps: report.steps.map((step) => step.agent === "pricing"
      ? { ...step, status: "limited", limitations: technicalNotes } : step) };
    await render(value); await click("Pricing");
    expect(panel().querySelector(".agent-sources > ul")?.textContent).toBe("We couldn't find enough matching product prices to compare.");
    for (const text of technicalNotes) expect(container.textContent).not.toContain(text);
    const finding = { ...observation, title: "Matching published offers", detail: "The captured offers share a product identifier." };
    await render({ ...value, steps: value.steps.map((step) => step.agent === "pricing" ? { ...step, findings: [finding] } : step) });
    expect(panel().querySelector(".agent-sources > ul")?.textContent).toBe("Published prices are available, but we can't yet make a like-for-like comparison.");
    expect(panel().textContent).toContain(finding.detail);
    expect(value.steps.find((step) => step.agent === "pricing")?.limitations).toEqual(technicalNotes);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("states missing marketplace context and trend capabilities without inventing sentiment or Radar alerts", async () => {
    await render(); await click("Customer voice");
    expect(panel().textContent).toContain("No marketplace sample loaded.");
    expect(panel().querySelectorAll(".market-signals [data-slot=card]")).toHaveLength(0);
    await click("Market overview"); await click("Market trends");
    expect(panel().textContent).toContain("No trend dataset or continuous monitoring is connected.");
    expect(panel().textContent).toContain("Market Radar alerts and price-change tracking are not running.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps market-gap hypotheses distinct from recommendations and opens exact supporting evidence", async () => {
    await render(); await click("Market gaps");
    expect(panel().textContent).toContain("Hypothesis / needs validation");
    expect(panel().textContent).toContain(hypothesis.title);
    expect(panel().textContent).not.toContain(suggestion.title);
    expect(panel().textContent).not.toContain(observation.title);
    expect(panel().textContent).not.toContain("Store-only idea");
    await click("Read evidence");
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain(hypothesis.detail);
    await act(async () => dialog.querySelector("summary")!.click());
    expect(dialog.querySelector("blockquote p")?.textContent).toContain(source.quote);
    expect(dialog.querySelector("a")?.getAttribute("href")).toBe(source.url);
    expect(dialog.querySelector("time")?.getAttribute("datetime")).toBe(source.capturedAt);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not promote running or failed hypotheses or mistake no evidence for no competition", async () => {
    await render({ ...report, steps: report.steps.map((step) => ({ ...step, status: "failed" })) });
    expect(panel().textContent).toContain("No market findings saved yet.");
    expect(panel().textContent).toContain("does not mean your business has no competitors");
    expect(panel().textContent).toContain("0 verified brands");
    await click("Market gaps");
    expect(panel().textContent).toContain("No accepted market-gap hypothesis yet.");
    expect(panel().textContent).not.toContain(hypothesis.title);
    await render({ ...report, status: "running", steps: [{ ...base, agent: "opportunity", status: "running", findings: [hypothesis] }] });
    expect(panel().textContent).toContain("Research is still running. Accepted hypotheses will appear when saved.");
    expect(panel().textContent).not.toContain(hypothesis.title);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows saved AI suggestions when there is no market observation and preserves their exact evidence", async () => {
    const value: Report = { ...report, steps: [
      { ...base, key: "competitor-brand-0", findings: [], profile: brand },
      { ...base, agent: "opportunity", findings: [suggestion,
        { ...suggestion, title: "Store-only recommendation", sources: [{ ...source, url: "https://merchant.example/" }] }] },
      { ...base, status: "running", findings: [{ ...suggestion, title: "Unfinished recommendation" }] },
    ] };
    const saved = JSON.stringify(value);
    await render(value);
    const summary = panel().querySelector(".market-summary")!;
    expect(summary.textContent).toContain(suggestion.title);
    expect(summary.textContent).toContain(suggestion.detail);
    expect(summary.textContent).toContain("AI suggestion");
    expect(summary.textContent).not.toContain("Captured observation");
    expect(panel().textContent).not.toContain("Not enough external evidence");
    expect(panel().textContent).not.toContain("Store-only recommendation");
    expect(panel().textContent).not.toContain("Unfinished recommendation");
    await click("Read evidence");
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("AI suggestion");
    expect(dialog.textContent).toContain(suggestion.detail);
    await act(async () => dialog.querySelector("summary")!.click());
    expect(dialog.querySelector("blockquote p")?.textContent).toContain(source.quote);
    expect(dialog.querySelector("a")?.getAttribute("href")).toBe(source.url);
    expect(JSON.stringify(value)).toBe(saved);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the AI's captured brand profiles instead of a negative market-conclusion placeholder", async () => {
    await render({ ...report, steps: [
      { ...base, key: "competitor-brand-0", findings: [], profile: brand },
      { ...base, key: "competitor-brand-1", status: "limited", findings: [],
        profile: { ...brand, name: "Another Brand", url: "https://another.example/", relevance: "Publishes related shirts and two-packs." } },
    ] });
    const summary = panel().querySelector(".market-summary")!;
    expect(summary.textContent).toContain("Brands to explore.");
    expect(summary.textContent).toContain(brand.name);
    expect(summary.textContent).toContain(brand.relevance);
    expect(summary.textContent).toContain("Another Brand");
    expect(summary.textContent).toContain("Publishes related shirts and two-packs.");
    expect(summary.textContent).not.toContain("Not enough external evidence");
    expect(summary.textContent).not.toContain("no accepted market observation");
    expect(summary.querySelector("blockquote p")?.textContent).toContain(source.quote);
    await click("Explore captured brands");
    expect(panel().querySelectorAll(".market-brand")).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows research in progress instead of empty market counts while competitor evidence is being checked", async () => {
    await render({ ...report, status: "running", steps: [
      { ...base, key: "discovery-search-0", findings: [] },
      { ...base, key: "competitor-site-0", status: "running", findings: [] },
    ] });
    expect(panel().textContent).toContain("Market research is still running.");
    expect(panel().textContent).toContain("Comparisons will appear as their evidence is verified.");
    expect(panel().textContent).toContain("Checking competitor websites");
    expect(panel().textContent).not.toContain("0 verified brands");
    expect(panel().textContent).not.toContain("0 brands with published pricing");
    expect(panel().textContent).not.toContain("0 brands with product claims");
    expect(panel().textContent).not.toContain("0 hypotheses to validate");
    expect(panel().textContent).not.toContain(observation.title);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains rejected candidate evidence and unreadable sites without exposing diagnostics or accepting leads", async () => {
    const checked: Report = { ...report, steps: [
      { ...base, key: "competitor-site-0", findings: [] },
      { ...base, key: "competitor-brand-0", status: "limited", findings: [],
        diagnostic: { code: "brand_validation", paths: ["categorySourceId"] },
        limitations: ["The selected category quote did not contain all meaningful words of a merchant product category."] },
    ] };
    await render(checked);
    expect(panel().textContent).toContain("Potential competitors were found, but their published product information couldn't be verified");
    expect(panel().textContent).toContain("0 verified brands");
    expect(panel().textContent).not.toContain("categorySourceId");
    expect(panel().textContent).not.toContain("brand_validation");
    expect(panel().textContent).not.toContain(observation.title);
    await render({ ...checked, steps: [{ ...base, key: "competitor-site-0", status: "failed", findings: [] }] });
    expect(panel().textContent).toContain("Competitor websites couldn't be read");
    expect(panel().querySelector('a[href="#overview?view=business"]')?.textContent).toContain("Manage website analysis");
    await render({ ...checked, steps: [{ ...base, key: "discovery-search-0", status: "failed", findings: [] }] });
    expect(panel().textContent).toContain("The competitor search couldn't be completed.");
    await render({ ...checked, steps: [{ ...base, key: "competitor", status: "failed", findings: [] }] });
    expect(panel().textContent).not.toContain("The competitor search couldn't be completed.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not claim market research is running when only the store analysis was enabled", async () => {
    await render({ ...report, enabled: false, status: "running", steps: [{ ...base, agent: "store", status: "running", findings: [] }] });
    expect(panel().textContent).toContain("Start building your market view.");
    expect(panel().textContent).toContain("Start a website analysis to gather competitor information");
    expect(panel().textContent).toContain("No market research saved");
    expect(panel().textContent).not.toContain("Market research is still running.");
    expect(panel().textContent).not.toContain("Checking competitor websites");
    expect(fetch).not.toHaveBeenCalled();
  });
});
