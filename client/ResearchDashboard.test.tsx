// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchReport } from "./ResearchReport";
import type { ResearchReport as Report } from "../shared/research";
import type { Understanding } from "../shared/understanding";

const source = { id: "e_1111111111111111", url: "https://shop.example.com/products", quote: "Our cotton shirts are available in five sizes.", capturedAt: "2026-11-16T12:00:00.000Z" };
const briefing: NonNullable<Understanding["briefing"]> = {
  summary: { text: "A shop presenting cotton clothing.", sources: [source] },
  insights: [{ area: "offering", text: "The website describes five sizes.", whyItMatters: "Published sizing helps shoppers compare fit.", sources: [source] }],
  unknowns: [{ question: "How do shoppers choose their size?", whyItMatters: "The captured pages do not establish this." }],
  nextSteps: [{ action: "Review size guidance.", reason: "Confirm what a shopper can establish before buying." }],
};
const report: Report = {
  version: 1, status: "partial", enabled: true, usage: { modelCalls: 2, searches: 1, competitorScans: 0 },
  steps: [0, 1, 2].map((index) => ({
    key: `opportunity-${index}`, agent: "opportunity", status: "completed", findings: [
      { kind: "observation" as const, title: "Published sizes", detail: "The site publishes five sizes.", sources: [source] },
      { kind: "hypothesis" as const, title: "An untested idea", detail: "This is not a recommendation or established fact.", sources: [source] },
      ...Array.from({ length: 7 }, (_, index) => ({ kind: "suggestion" as const, title: `Review buying detail ${index + 1}`, detail: `Check published detail ${index + 1} before deciding.`, sources: [source] })),
    ].slice(index * 4, index * 4 + 4), limitations: [], diagnostic: null, startedAt: source.capturedAt, completedAt: source.capturedAt, reused: false,
  })),
};

describe("conclusion-first research dashboard", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Browsing saved research must not make a request."); }));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(value = report, accepted = true, previousBriefing?: Understanding) {
    await act(async () => root.render(<ResearchReport report={value} businessName="Fixture shop" initialView="overview"
      briefing={briefing} evidence={accepted ? briefing : undefined} briefingKey="fixture" previousBriefing={previousBriefing} />));
  }
  function visiblePanel() { return container.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!; }
  async function tab(label: string) {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((item) => item.textContent === label)!;
    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  }

  it("shows a conclusion and one move without the duplicate specialist archive, and keeps market research available", async () => {
    await render();
    const panel = visiblePanel();
    expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("At a glance");
    expect(panel.querySelectorAll('[data-slot="card"]')).toHaveLength(2);
    expect(panel.textContent).toContain(briefing.insights[0].text);
    expect(panel.textContent).toContain("Review buying detail 1");
    expect(panel.textContent).not.toContain("Review buying detail 2");
    expect(panel.textContent).not.toContain("An untested idea");
    expect(container.querySelector(".specialist-archive")).toBeNull();
    expect(container.textContent).not.toContain("Store briefing and saved specialist details");
    expect(container.textContent).not.toContain("Saved research archive");
    expect(container.querySelector('[aria-label="Research specialists"]')).toBeNull();
    expect(panel.querySelector(".research-overview")?.getAttribute("style")).not.toContain("opacity: 0");
    expect(panel.textContent).toContain("Partial research saved");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await tab("Market intelligence");
    expect(visiblePanel().querySelector('[aria-label="Research specialists"]')).toBeNull();
    expect(visiblePanel().querySelector('[aria-label="Explore market research"]')).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens exact, untruncated evidence in a keyboard-dismissable drawer and restores focus", async () => {
    const title = `${"A very long accepted finding. ".repeat(20)}Keep this final sentence.`;
    const value = { ...briefing, insights: [{ ...briefing.insights[0], text: title }] };
    await act(async () => root.render(<ResearchReport report={report} businessName="Fixture shop" initialView="overview"
      briefing={value} evidence={value} briefingKey="long" />));
    const trigger = visiblePanel().querySelector<HTMLButtonElement>(".dashboard-detail-trigger")!;
    await act(async () => { trigger.focus(); trigger.click(); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain(title);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => dialog.querySelector("summary")!.click());
    expect(dialog.querySelector("blockquote p")?.textContent).toContain(source.quote);
    expect(dialog.querySelector("a")?.href).toBe(source.url);
    expect(dialog.querySelector("time")?.dateTime).toBe(source.capturedAt);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes planning to Growth rather than duplicating an Opportunities tab", async () => {
    await render();
    expect(Array.from(container.querySelectorAll('[role="tab"]')).map((item) => item.textContent)).toEqual(["At a glance", "Market intelligence"]);
    expect(visiblePanel().querySelector('.dashboard-paths a[href="#growth"]')?.textContent).toContain("Build your growth plan");
    expect(container.querySelector('[aria-label="Saved opportunities"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not promote unverified streamed prose or invent recommendations for an empty report", async () => {
    await render({ ...report, status: "running", steps: [] }, false);
    expect(visiblePanel().textContent).not.toContain(briefing.insights[0].text);
    expect(visiblePanel().textContent).toContain("Your first supported finding will appear here.");
    expect(visiblePanel().textContent).toContain("Gathering evidence before your next move.");
    expect(visiblePanel().textContent).not.toContain("No accepted recommendation");
    expect(visiblePanel().textContent).not.toContain("A recommendation, not an action already taken.");
    await tab("Market intelligence");
    expect(visiblePanel().querySelector(".opportunity-card")).toBeNull();
    expect(visiblePanel().textContent).toContain("Market research is still running");
    await render({ ...report, status: "partial", steps: [] }, false);
    expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Market intelligence");
    expect(visiblePanel().textContent).toContain("Not enough external evidence for a market conclusion yet.");
  });

  it("retains the last accepted Store context after a failed refresh without mixing its sources", async () => {
    const retained: Understanding = {
      id: "63243bee-1f3a-40db-a516-93b04d40f797", businessId: "02a221ee-41f1-46c9-bc96-12401d8dcf73",
      scanId: "bdc0f304-3b01-4542-824a-7995d482b81c", scanStatus: "complete", reviewedAt: null,
      createdAt: source.capturedAt, warnings: [], suggestions: [], productImportId: null, briefing,
    };
    await act(async () => root.render(<ResearchReport report={{ ...report, steps: [] }} businessName="Fixture shop"
      initialView="overview" briefingKey="failed" previousBriefing={retained} />));
    expect(visiblePanel().textContent).toContain("Showing the last successful Store briefing");
    expect(visiblePanel().querySelector("time")?.dateTime).toBe(source.capturedAt);
    expect(visiblePanel().textContent).toContain(briefing.insights[0].text);
    expect(fetch).not.toHaveBeenCalled();
  });
});
