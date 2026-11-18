// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BriefingPreview, Understanding } from "../shared/understanding";
import { BusinessBriefing } from "./BusinessBriefing";

const sources = [{ url: "https://shop.example.com/", quote: "Cotton clothing for everyday wear." }];
const briefing = {
  summary: { text: "A shop presenting everyday cotton clothing.", sources },
  insights: [
    { area: "offering", text: "Cotton is the stated fabric.", whyItMatters: "Fabric helps buyers evaluate product fit.", sources },
    { area: "positioning", text: "The range is positioned for everyday use.", whyItMatters: "This explains the stated use case.", sources },
  ],
  unknowns: [
    { question: "What are the delivery costs?", whyItMatters: "These pages do not establish the full purchase cost." },
    { question: "What is the returns window?", whyItMatters: "This affects the buying commitment." },
  ],
  nextSteps: [
    { action: "Review delivery information.", reason: "Confirm the total buying commitment." },
    { action: "Check sizing information.", reason: "Confirm how shoppers choose a size." },
  ],
} satisfies NonNullable<Understanding["briefing"]>;

describe("guided business briefing cards", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(value: BriefingPreview = briefing, live = false) {
    await act(async () => root.render(<BusinessBriefing businessName="Fixture shop" briefing={value} evidence={live ? undefined : briefing} />));
  }
  async function click(selector: string) { await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click()); }
  async function section(label: string) {
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>(".briefing-sections button")).find((button) => button.textContent?.startsWith(label))!.click());
  }

  it("shows one card, keeps details secondary, and makes every finding reachable in reading order", async () => {
    await render();
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.querySelector("article")?.textContent).toContain(briefing.summary.text);
    expect(container.textContent).not.toContain(briefing.insights[0].text);
    expect(container.textContent).not.toContain(briefing.nextSteps[0].action);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Card 1 of 7");
    expect(container.querySelector<HTMLButtonElement>(".briefing-navigation .secondary-button")?.disabled).toBe(true);
    for (const text of [
      ...briefing.insights.map((item) => item.text),
      ...briefing.unknowns.map((item) => item.question),
      ...briefing.nextSteps.map((item) => item.action),
    ]) {
      await click(".briefing-navigation .primary-link");
      expect(container.querySelectorAll("article")).toHaveLength(1);
      expect(container.querySelector("article")?.textContent).toContain(text);
      expect(document.activeElement).toBe(container.querySelector("article h3"));
    }
    expect(container.querySelector<HTMLButtonElement>(".briefing-navigation .primary-link")?.disabled).toBe(true);
    await click(".briefing-navigation .secondary-button");
    expect(container.querySelector("article")?.textContent).toContain(briefing.nextSteps[0].action);
  });

  it("lets readers jump to observations, gaps or recommendations without turning advice into a completed action", async () => {
    await render();
    await section("Findings");
    expect(container.querySelector("article")?.textContent).toContain(briefing.insights[0].text);
    expect(container.querySelector<HTMLDetailsElement>(".briefing-card-detail")?.open).toBe(false);
    await click(".briefing-card-detail summary");
    expect(container.querySelector<HTMLDetailsElement>(".briefing-card-detail")?.open).toBe(true);
    expect(container.querySelector(".briefing-card-detail")?.textContent).toContain(briefing.insights[0].whyItMatters);
    expect(container.querySelector(".agent-sources a")?.getAttribute("href")).toBe(sources[0].url);
    await section("Unknowns");
    expect(container.querySelector("article")?.textContent).toContain(briefing.unknowns[0].question);
    expect(container.querySelector("article")?.textContent).toContain("Missing evidence is not proof");
    expect(container.querySelector(".agent-sources")).toBeNull();
    await section("Next moves");
    expect(container.querySelector("article")?.textContent).toContain(briefing.nextSteps[0].action);
    expect(container.querySelector("article")?.textContent).toContain("not a change already made");
    expect(container.querySelector<HTMLDetailsElement>(".briefing-card-detail")?.open).toBe(false);
    expect(container.querySelector(".briefing-sections [aria-pressed=true]")?.textContent).toContain("Next moves");
  });

  it("keeps the selected live card and DOM stable as text streams, more cards arrive and sources are validated", async () => {
    await render({ summary: briefing.summary, insights: [briefing.insights[0]] }, true);
    await section("Findings");
    const card = container.querySelector("article");
    expect(container.querySelector(".agent-sources")).toBeNull();
    await render({ ...briefing, insights: [{ ...briefing.insights[0], text: "A growing observation about cotton." }, briefing.insights[1]] }, true);
    expect(container.querySelector("article")).toBe(card);
    expect(container.querySelector("article")?.textContent).toContain("A growing observation about cotton.");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Card 2 of 7 available");
    expect(container.querySelector(".agent-sources")).toBeNull();
    await render();
    expect(container.querySelector("article")).toBe(card);
    expect(container.querySelector("article")?.textContent).toContain(briefing.insights[0].text);
    expect(container.querySelector(".agent-sources")).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Card 2 of 7");
  });

  it("preserves the first arriving card when earlier sections arrive later, without inventing missing content", async () => {
    await render({ insights: [{}], unknowns: [{}], nextSteps: [{}] }, true);
    expect(container.querySelector("article")).toBeNull();
    expect(container.textContent).toContain("Waiting for the first finding");
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>(".briefing-sections button")).every((button) => button.disabled)).toBe(true);
    await render({ nextSteps: [{ reason: "A reason arriving before the action." }] }, true);
    expect(container.querySelector("article")?.textContent).toContain("A reason arriving before the action.");
    await render(briefing, true);
    expect(container.querySelector("article")?.textContent).toContain(briefing.nextSteps[0].action);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Card 6 of 7 available");
  });
});
