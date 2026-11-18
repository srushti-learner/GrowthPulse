// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductIntelligence } from "./ProductIntelligence";
import { emptyProduct, type Product } from "../shared/products";
import { productDimensions, type ProductIntelligenceResponse, type SavedProductAnalysis } from "../shared/product-intelligence";

const businessId = "02a221ee-41f1-46c9-bc96-12401d8dcf73", id = "4c54b43b-8191-4f3d-af8f-607937219267";
const timestamp = "2026-11-17T12:00:00.000Z";
const reference = "e_1111111111111111";
const product: Product = {
  id, businessId, name: "Fixture cotton tee", description: "Cotton tee.", sku: "TEE-1", gtin: "", createdAt: timestamp, updatedAt: timestamp,
  listings: [{ id, source: "csv", sourceName: "Owner CSV", reference: "CSV row 1", sourceKey: "tee", capturedAt: timestamp, data: { ...emptyProduct, name: "Fixture cotton tee", price: "0", currency: "INR" } }],
};
const analysis: SavedProductAnalysis = {
  id, productId: id, fingerprint: "a".repeat(64), createdAt: timestamp,
  evidence: [{ id: reference, source: "csv", sourceName: "Owner CSV", reference: "CSV row 1", quote: '{"description":"Cotton tee."}', capturedAt: timestamp }],
  result: {
    summary: { text: "Confirm the tee's care information before rewriting it.", references: [reference] },
    dimensions: productDimensions.map((dimension) => ({
      dimension, status: "not_assessed", diagnosis: "Review the available information before making claims.", references: [reference],
    })),
    rewrite: { title: "Cotton tee for review", description: "A tee in cotton.", seoTitle: "Cotton tee", metaDescription: "Review cotton tee details and options.", references: [reference] },
    recommendations: [{ title: "Check care information", detail: "Ask the owner to confirm which care guidance belongs in this listing.", priority: "first", references: [reference] }],
  },
};
const snapshot: ProductIntelligenceResponse = { configured: true, analysis, stale: false, running: false, error: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("focused product intelligence workspace", () => {
  let container: HTMLDivElement, root: Root;
  const saved = vi.fn(), analysed = vi.fn(), expired = vi.fn(), back = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    saved.mockReset(); analysed.mockReset(); expired.mockReset(); back.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  async function render(products = [product]) {
    await act(async () => root.render(<ProductIntelligence businessId={businessId} product={product} products={products} thumbnail={<span>Fixture image</span>}
      onBack={back} onAnalysed={analysed} onProductSaved={saved} onSessionExpired={expired} />));
  }
  async function click(text: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
    expect(button, text).toBeDefined(); await act(async () => button!.click());
  }
  it("reopens saved diagnosis and evidence on demand without paid requests or unsupported performance claims", async () => {
    const fetch = vi.fn(async () => json(snapshot)); vi.stubGlobal("fetch", fetch);
    await render();
    expect(container.textContent).toContain(analysis.result.summary.text);
    expect(container.querySelectorAll(".product-dimensions > details")).toHaveLength(6);
    expect(container.querySelector(".product-citations dt")?.textContent).toBe("Description");
    expect(container.querySelector(".product-citations dd")?.textContent).toBe("Cotton tee.");
    expect(container.textContent).not.toContain(analysis.evidence[0].quote);
    expect(container.querySelector<HTMLDetailsElement>(".product-citations")?.open).toBe(false);
    expect(container.querySelector(".product-checklist")?.textContent).toContain("Price and currency recordedRecorded");
    await click("Performance");
    expect(container.textContent).toContain("No store transactions or product analytics are connected");
    expect(container.textContent).not.toContain(analysis.result.summary.text);
    expect(container.textContent).not.toContain("68/100");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toHaveLength(2);
    await click("All products"); expect(back).toHaveBeenCalledOnce();
  });
  it("uses readable sources across product areas without exposing internal catalogue references", async () => {
    const savedSnapshot = structuredClone(snapshot);
    savedSnapshot.analysis!.evidence[0] = {
      ...analysis.evidence[0], source: "manual", sourceName: "Reviewed catalogue",
      reference: `products/${id}`, quote: '{"description":"Cotton tee.\\nCare instructions recorded."}',
    };
    const fetch = vi.fn(async () => json(savedSnapshot)); vi.stubGlobal("fetch", fetch);
    await render();
    for (const area of ["Product analysis", "Listing optimizer", "SEO readiness", "Product opportunities"]) {
      await click(area);
      const citation = container.querySelector(".product-citations")!;
      expect(citation.querySelector("dd")?.textContent).toBe("Cotton tee.\nCare instructions recorded.");
      expect(citation.textContent).toContain("Saved catalogue");
      expect(citation.textContent).not.toContain("products/");
      expect(citation.textContent).not.toContain("\\n");
      expect(citation.textContent).not.toContain('{"description"');
      expect(citation.textContent).not.toContain(reference);
    }
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("authorizes one analysis on the disclosed action click without changing or publishing the catalogue", async () => {
    const fetch = vi.fn(async (_url: string, options?: RequestInit) => json(options?.method ? snapshot : { ...snapshot, analysis: null }));
    vi.stubGlobal("fetch", fetch);
    await render();
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Analyse this product")!;
    expect(button.disabled).toBe(false);
    expect(container.querySelector('.product-analysis-callout input[type="checkbox"]')).toBeNull();
    expect(container.querySelector(".product-analysis-callout")?.textContent).toContain("saved catalogue excerpts to Anthropic");
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    await click("Analyse this product");
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/products/${id}/intelligence`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ consent: true }) }));
    expect(container.textContent).toContain(analysis.result.summary.text);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("your catalogue and website have not changed");
    expect(saved).not.toHaveBeenCalled();
    expect(analysed).toHaveBeenCalledWith(analysis);
  });
  it("supports edited before-and-after copy, resets approval after edits and saves only the approved local listing", async () => {
    const fetch = vi.fn(async (url: string) => json(url.endsWith("/approve-listing") ? { product: { ...product, name: "Owner wording" } } : snapshot));
    vi.stubGlobal("fetch", fetch); await render(); await click("Listing optimizer");
    expect(container.querySelector(".product-rewrite-grid")?.textContent).toContain(product.description);
    const approval = container.querySelector<HTMLInputElement>(".product-approval input")!;
    const saveButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save approved local listing")!;
    expect(saveButton.disabled).toBe(true);
    await act(async () => approval.click());
    const title = container.querySelector<HTMLInputElement>(".product-rewrite-grid input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Owner wording");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(approval.checked).toBe(false);
    expect(saveButton.disabled).toBe(true);
    await act(async () => approval.click()); await click("Save approved local listing");
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/products/${id}/approve-listing`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ analysisId: id, title: "Owner wording", description: analysis.result.rewrite.description }) }));
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ name: "Owner wording" }));
    expect(container.textContent).toContain("live website are unchanged");
  });
    it("waits beyond the ordinary request timeout for product analysis", async () => {
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("signal timed out", "TimeoutError")), milliseconds);
        return controller.signal;
      });
      const fetch = vi.fn((_url: string, options?: RequestInit) => {
        if (!options?.method) return Promise.resolve(json({ ...snapshot, analysis: null }));
        return new Promise<Response>((resolve, reject) => {
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
          setTimeout(() => resolve(json(snapshot)), 44_000);
        });
      });
      vi.stubGlobal("fetch", fetch);
      await render();
      await click("Analyse this product");
      await act(async () => vi.advanceTimersByTimeAsync(11_000));
      expect(container.textContent).toContain("Analysing product...");
      expect(container.querySelector<HTMLButtonElement>(".product-analysis-callout button")?.disabled).toBe(true);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(33_000));
      expect(container.textContent).toContain(analysis.result.summary.text);
      expect(analysed).toHaveBeenCalledWith(analysis);
      expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    });
    it("explains a genuine browser timeout and reloads saved results without repeating paid work", async () => {
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("signal timed out", "TimeoutError")), milliseconds);
        return controller.signal;
      });
      let completed = false;
      const fetch = vi.fn((_url: string, options?: RequestInit) => {
        if (!options?.method) return Promise.resolve(json(completed ? snapshot : { ...snapshot, analysis: null }));
        return new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
        });
      });
      vi.stubGlobal("fetch", fetch);
      await render();
      await click("Analyse this product");
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("The server may still finish and save it");
      expect(container.textContent).not.toContain("signal timed out");
      completed = true;
      await click("Reload saved status");
      expect(container.textContent).toContain(analysis.result.summary.text);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    });
  it("identifies catalogue duplicates without claiming a live SEO audit and hands a chosen recommendation to Growth", async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith("/growth-plan") ? json({
      item: { opportunity: { id: "b".repeat(64), title: "Check care information", detail: "Ask the owner", agents: ["store"],
        sources: [{ id: reference, url: "http://127.0.0.1:5173/#products", quote: analysis.evidence[0].quote, capturedAt: timestamp }],
        reviewReason: "Catalogue evidence", strategy: { objective: "Check", actions: ["Review"], metric: "Conversion", hypothesis: "Test", measurement: "Set a baseline" } },
      status: "planned", impact: "unknown", effort: "unknown", timeToValue: "unknown", revision: 0, createdAt: timestamp, updatedAt: timestamp },
    }) : json(snapshot));
    vi.stubGlobal("fetch", fetch);
    await render([product, { ...product, id: businessId, name: "Another tee" }]);
    await click("SEO readiness");
    expect(container.textContent).toContain("Same catalogue description also used by: Another tee");
    expect(container.textContent).toContain("not a ranking, indexing or technical SEO audit");
    expect(container.querySelector(".product-seo-drafts textarea")?.textContent).toBe(analysis.result.rewrite.seoTitle);
    await click("Product opportunities"); await click("Add to growth plan");
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/products/${id}/growth-plan`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ analysisId: id, index: 0 }) }));
    expect(container.textContent).toContain("Added to growth plan");
    expect(container.querySelector('a[href="#growth"]')).not.toBeNull();
  });
  it("blocks stale drafts and unconnected analysis, exposes errors and never retries paid work automatically", async () => {
    const fetch = vi.fn(async () => json({ ...snapshot, stale: true, configured: false }));
    vi.stubGlobal("fetch", fetch); await render(); await click("Listing optimizer");
    expect(container.textContent).toContain("Product evidence has changed");
    expect(container.textContent).toContain("not configured");
    expect(container.querySelector<HTMLInputElement>(".product-rewrite-grid input")?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>(".product-approval input")?.disabled).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockResolvedValue(json({ error: "Please log in" }, 401));
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(expired).toHaveBeenCalledOnce();
  });
});
