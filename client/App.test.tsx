// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

describe("workspace foundation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderApp() {
    await act(async () => root.render(<App />));
  }

  it("shows a real health response without claiming database or AI connectivity", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "ok", service: "growthpulse-api" })));
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(fetch).toHaveBeenCalledWith("/api/health", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Connected to the Express API");
    expect(container.textContent).toContain("No database or AI services are connected yet");
  });

  it("displays connection errors and can retry successfully", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", service: "growthpulse-api" })));
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Network unavailable");
    await act(async () => container.querySelector<HTMLButtonElement>(".status-card button")?.click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Connected");
  });

  it("does not display connected for an unexpected API response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "unhealthy" }))));
    await renderApp();
    expect(container.querySelector(".status-dot.error")).not.toBeNull();
    expect(container.querySelector(".status-dot.connected")).toBeNull();
  });

  it("navigates to honest module placeholders and preserves the section on skip-to-content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "ok", service: "growthpulse-api" }))));
    await renderApp();
    await act(async () => {
      window.history.replaceState(null, "", "/#products");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector("h1")?.textContent).toBe("Products");
    expect(container.textContent).toContain("This module is not implemented yet");
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain("Products");
    await act(async () => {
      window.history.replaceState(null, "", "/#main-content");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector("h1")?.textContent).toBe("Products");
  });

  it("explores sample sources and workflow stages without triggering real analysis", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "ok", service: "growthpulse-api" })));
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    const sourceButtons = container.querySelectorAll<HTMLButtonElement>(".source-card");
    await act(async () => sourceButtons[1].click());
    expect(sourceButtons[1].getAttribute("aria-pressed")).toBe("true");
    expect(sourceButtons[0].getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".preview-detail")?.textContent).toContain("This sample catalogue");

    const stages = container.querySelectorAll<HTMLButtonElement>(".pipeline button");
    await act(async () => stages[2].click());
    expect(stages[2].getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".preview-detail")?.textContent).toContain("current and proposed descriptions");
    await act(async () => stages[3].click());
    expect(container.querySelector(".preview-detail")?.textContent).toContain("Nothing has been scanned, generated, approved, or applied");
    expect(container.querySelector(".preview-disclaimer")?.textContent).toContain("No scans, AI calls, or business changes are running");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
