// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebsiteWorkspace } from "./WebsiteWorkspace";
import type { SavedScan, ScanResult } from "../shared/website";

const businessId = "02a221ee-41f1-46c9-bc96-12401d8dcf73";
const originalId = "4c54b43b-8191-4f3d-af8f-607937219267";
const nextId = "63243bee-1f3a-40db-a516-93b04d40f797";
const timestamp = "2026-11-16T12:00:00.000Z";
const business = { id: businessId, name: "Synthetic shop", website: "https://shop.example.com/", category: "", description: "", createdAt: timestamp, updatedAt: timestamp };
const preview: ScanResult = {
  requestedUrl: business.website, status: "complete", startedAt: timestamp, completedAt: timestamp,
  pages: [{
    url: business.website, capturedAt: timestamp, title: "Original page title", description: "",
    headings: [{ level: 1, text: "Our fixture business" }], text: "<script>This is untrusted page text, not executable code.</script>",
    contacts: ["mailto:fixture@example.test"], callsToAction: ["Contact us"], links: [], warnings: [],
  }], failures: [], notes: ["Static HTML only. No AI analysis."],
};
const saved: SavedScan = { ...preview, id: originalId, businessId };
const summary = { id: saved.id, businessId, requestedUrl: saved.requestedUrl, status: saved.status, startedAt: timestamp, completedAt: timestamp, pageCount: 1 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("website workspace", () => {
  let container: HTMLDivElement;
  let root: Root;
  const expired = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    expired.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = async (authenticated = false) => { await act(async () => root.render(<WebsiteWorkspace authenticated={authenticated} onSessionExpired={expired} />)); };
  const submit = async () => { await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); };
  async function permit() { await act(async () => container.querySelector<HTMLInputElement>('[name="scanPermission"]')!.click()); }
  async function setUrl(value: string) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('[name="scanUrl"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("requires explicit permission, shows progress, and renders an unsaved public preview safely", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const fetch = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetch);
    await render();
    await setUrl(business.website);
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("permission");
    expect(fetch).not.toHaveBeenCalled();
    await permit();
    await submit();
    expect(container.textContent).toContain("Scanning public pages...");
    expect(container.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
    expect(container.querySelector("#scan-result-heading")).toBeNull();
    await act(async () => finish(json({ scan: preview })));
    expect(fetch).toHaveBeenCalledWith("/api/website/scan", expect.objectContaining({ method: "POST", body: JSON.stringify({ url: business.website, permission: true }) }));
    expect(container.querySelector("#scan-result-heading")?.textContent).toBe("Scan complete");
    expect(document.activeElement).toBe(container.querySelector("#scan-result-heading"));
    expect(container.querySelector(".scan-meta")?.textContent).toContain("Preview only, not saved");
    expect(container.textContent).toContain("Review saved website findings without AI interpretation");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".scan-excerpt")).toBeNull();
    expect(container.textContent).not.toContain(preview.pages[0].text);
    expect(container.textContent).not.toContain("Text excerpt from HTML");
    expect(container.querySelector(".scan-page a")?.getAttribute("href")).toBe(business.website);
    expect(container.querySelector<HTMLDetailsElement>(".scan-details")?.open).toBe(false);
    const pageDetails = container.querySelector<HTMLDetailsElement>(".page-details")!;
    expect(pageDetails.open).toBe(false);
    await act(async () => pageDetails.querySelector("summary")!.click());
    expect(pageDetails.open).toBe(true);
    expect(pageDetails.textContent).toContain("Headings");
    await setUrl("https://another.example.com/");
    expect(container.querySelector<HTMLInputElement>('[name="scanPermission"]')?.checked).toBe(false);
  });

  it("shows partial and failed runs explicitly, and clears stale results when a rescan request fails", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ scan: { ...preview, status: "partial", failures: [{ url: `${business.website}blocked`, message: "Blocked by robots.txt" }] } }))
      .mockResolvedValueOnce(json({ scan: { ...preview, status: "failed", pages: [], failures: [{ url: business.website, message: "Connection failed" }] } }))
      .mockResolvedValueOnce(json({ error: "Scan limit reached. Try again in 10 minutes." }, 429));
    vi.stubGlobal("fetch", fetch);
    await render();
    await setUrl(business.website);
    await permit();
    await submit();
    expect(container.querySelector("#scan-result-heading")?.textContent).toBe("Partial scan");
    expect(container.textContent).toContain("Blocked by robots.txt");
    await submit();
    expect(container.querySelector("#scan-result-heading")?.textContent).toBe("Scan failed");
    expect(container.querySelector(".scan-result [role=alert]")?.textContent).toContain("0 HTML pages captured");
    expect(container.querySelectorAll(".scan-page")).toHaveLength(0);
    await submit();
    expect(container.querySelector("#scan-result-heading")).toBeNull();
    expect(container.querySelector(".scan-form [role=alert]")?.textContent).toContain("Scan limit");
    expect(container.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(false);
  });

  it("loads saved runs, saves a rescan to the selected business, and reopens older evidence", async () => {
    const updated: SavedScan = { ...saved, id: nextId, pages: [{ ...saved.pages[0], title: "Newly observed title" }] };
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/businesses") return json({ businesses: [business] });
      if (path === `/api/businesses/${businessId}/scans`) return options?.method === "POST" ? json({ scan: updated }, 201) : json({ scans: [summary] });
      if (path.endsWith(`/${originalId}`)) return json({ scan: saved });
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetch);
    await render(true);
    expect(container.querySelector<HTMLInputElement>('[name="scanUrl"]')?.value).toBe(business.website);
    expect(container.querySelector(".scan-meta")?.textContent).toContain("Saved locally");
    expect(container.querySelector(".scan-page h3")?.textContent).toBe("Original page title");
    await permit();
    await submit();
    expect(container.querySelector(".scan-page h3")?.textContent).toBe("Newly observed title");
    expect(container.querySelectorAll(".scan-picker option")).toHaveLength(3);
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/scans`, expect.objectContaining({ body: JSON.stringify({ url: business.website, permission: true }), method: "POST" }));
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(".scan-picker select")!;
      select.value = originalId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector(".scan-page h3")?.textContent).toBe("Original page title");
    expect(fetch.mock.calls.filter(([path]) => path.endsWith(`/${originalId}`))).toHaveLength(2);
  });

  it("does not mistake a business-load failure for an anonymous or empty workspace", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ error: "Could not load businesses" }, 500)).mockResolvedValueOnce(json({ businesses: [] }));
    vi.stubGlobal("fetch", fetch);
    await render(true);
    expect(container.querySelector('[role=alert]')?.textContent).toContain("Could not load businesses");
    expect(container.querySelector(".scan-form")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[role=alert] button')!.click());
    expect(container.querySelector(".scan-form")).not.toBeNull();
    expect(container.querySelector('[name="scanBusiness"]')?.textContent).toContain("Preview only");
  });

  it("makes failed saved-result loading retryable without triggering another scan", async () => {
    let failed = true;
    const fetch = vi.fn(async (path: string) => {
      if (path === "/api/businesses") return json({ businesses: [business] });
      if (path.endsWith("/scans")) return json({ scans: [summary] });
      return failed ? json({ error: "Could not read saved evidence" }, 500) : json({ scan: saved });
    });
    vi.stubGlobal("fetch", fetch);
    await render(true);
    expect(container.querySelector('[role=alert]')?.textContent).toContain("Could not read saved evidence");
    expect(container.querySelector("#scan-result-heading")).toBeNull();
    failed = false;
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Retry saved scan")!.click());
    expect(container.querySelector("#scan-result-heading")?.textContent).toBe("Scan complete");
    expect(fetch.mock.calls.filter(([path]) => path.endsWith(`/${originalId}`))).toHaveLength(2);
  });

  it("returns expired private sessions to the authentication boundary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Please log in to continue." }, 401)));
    await render(true);
    expect(expired).toHaveBeenCalledOnce();
    expect(container.querySelector("#scan-result-heading")).toBeNull();
  });
});
