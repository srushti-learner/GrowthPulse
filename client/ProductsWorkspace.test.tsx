// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductsWorkspace } from "./ProductsWorkspace";
import { emptyProduct, type ImportDraft, type Product } from "../shared/products";
import type { Understanding } from "../shared/understanding";

const businessId = "02a221ee-41f1-46c9-bc96-12401d8dcf73";
const productId = "4c54b43b-8191-4f3d-af8f-607937219267";
const importId = "63243bee-1f3a-40db-a516-93b04d40f797";
const scanId = "bdc0f304-3b01-4542-824a-7995d482b81c";
const timestamp = "2026-11-16T12:00:00.000Z";
const business = { id: businessId, name: "Synthetic shop", website: "", category: "", description: "", createdAt: timestamp, updatedAt: timestamp };
const data = { ...emptyProduct, name: "Fixture tee", sku: "TEE-1", price: "499.00", currency: "INR" };
const product: Product = {
  id: productId, businessId, name: data.name, description: "", sku: data.sku, gtin: "", createdAt: timestamp, updatedAt: timestamp,
  listings: [{ id: importId, source: "csv", sourceName: "channel", sourceKey: "sku:TEE-1", reference: "CSV row 2", capturedAt: timestamp, data }],
};
const draft: ImportDraft = {
  id: importId, businessId, source: "csv", sourceName: "channel", createdAt: timestamp, committed: false,
  rows: [
    { row: 2, sourceKey: "id:one", reference: "CSV row 2", capturedAt: timestamp, data: { ...data, sku: "" }, errors: [], notes: [] },
    { row: 3, sourceKey: "", reference: "CSV row 3", capturedAt: timestamp, data: null, errors: ["name: Product name is required."], notes: [] },
  ], matches: [{ row: 2, kind: "review", productId: null, candidates: [] }, { row: 3, kind: "new", productId: null, candidates: [] }],
};
const understanding: Understanding = {
  id: productId, businessId, scanId, createdAt: timestamp, scanStatus: "complete", reviewedAt: null,
  suggestions: [], briefing: null, warnings: [], productImportId: importId,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("product workspace", () => {
  let container: HTMLDivElement, root: Root;
  const expired = vi.fn();
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); expired.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const render = async () => { await act(async () => root.render(<ProductsWorkspace onSessionExpired={expired} />)); };
  async function set(name: string, value: string) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(text: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
    expect(button).toBeDefined(); await act(async () => button!.click());
  }
  function fetcher(handler: (path: string, options?: RequestInit) => Response, saved: Understanding | null = null) {
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/businesses") return json({ businesses: [business] });
      if (path.endsWith("/scans")) return json({ scans: [{ id: scanId, businessId, requestedUrl: "https://shop.example.com/", status: "complete", startedAt: timestamp, completedAt: timestamp, pageCount: 1 }] });
      if (path.endsWith("/understanding")) return json({ understanding: saved });
      if (path.endsWith("/product-intelligence")) return json({ analyses: [] });
      return handler(path, options);
    });
    vi.stubGlobal("fetch", fetch); return fetch;
  }

  it("adds and edits owner listings without borrowing or overwriting imported offer data", async () => {
    const fetch = fetcher((_path, options) => {
      if (options?.method) {
        const input = JSON.parse(String(options.body));
        return json({ product: { ...product, name: input.name, listings: [...product.listings, { ...product.listings[0], id: scanId, source: "manual", sourceName: "Owner", data: input }] } });
      }
      return json({ products: [product] });
    });

    await render();
    expect(container.querySelector<HTMLDetailsElement>(".product-tools")?.open).toBe(false);
    await click("Add a product manually");
    expect(container.querySelector<HTMLDetailsElement>(".product-tools")?.open).toBe(true);
    expect(document.activeElement).toBe(container.querySelector('[name="name"]'));
    expect(container.textContent).toContain("Optional CSV upload");
    const listing = container.querySelector<HTMLDetailsElement>(".catalogue-listings details")!;
    expect(listing.open).toBe(false);
    expect(listing.querySelector("summary")?.textContent).toContain("499.00 INR");
    await act(async () => listing.querySelector("summary")!.click());
    expect(listing.open).toBe(true);
    expect(listing.textContent).toContain("CSV row 2");
    await click("Edit product");
    expect(container.querySelector<HTMLInputElement>('[name="price"]')?.value).toBe("");
    await set("name", "Owner name"); await set("price", "525"); await set("currency", "INR");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/products/${productId}`, expect.objectContaining({ method: "PUT" }));
    expect(container.textContent).toContain("Product saved locally");
    expect(container.querySelector(".catalogue-listings")?.textContent).toContain("499.00 INR");
    expect(container.querySelector(".catalogue-listings")?.textContent).toContain("525 INR");
    await set("name", "Another product");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/products`, expect.objectContaining({ method: "POST" }));
  });

  it("shows readable listing variants and availability instead of internal references and JSON", async () => {
    const savedProduct: Product = {
      ...product, listings: [{ ...product.listings[0], source: "manual", sourceName: "Owner",
        reference: `products/${productId}`, data: { ...data, availability: "https://schema.org/InStock", variants: '{"color":"Blue","size":"M"}' } }],
    };
    const fetch = fetcher(() => json({ products: [savedProduct] }));
    await render();
    const listing = container.querySelector(".catalogue-listings")!;
    expect(listing.textContent).toContain("Saved catalogue");
    expect(listing.textContent).toContain("ColourBlue");
    expect(listing.textContent).toContain("SizeM");
    expect(listing.textContent).toContain("In stock");
    for (const technical of [productId, '{"color"', "schema.org/InStock"]) expect(listing.textContent).not.toContain(technical);
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("searches and filters the saved catalogue and opens a product without starting paid work", async () => {
    const fetch = fetcher((path) => path.endsWith("/intelligence")
      ? json({ configured: true, analysis: null, stale: false, running: false, error: null })
      : json({ products: [product, { ...product, id: scanId, name: "Different shirt", sku: "OTHER" }] }));
    await render(); await set("productSearch", "TEE-1");
    expect(container.querySelectorAll(".catalogue-product")).toHaveLength(1);
    await click("Analysed");
    expect(container.textContent).toContain("No products match this search and filter");
    await click("Needs review");
    expect(container.querySelectorAll(".catalogue-product")).toHaveLength(1);
    await click("Open product workspace");
    expect(container.querySelector('[aria-label="Fixture tee product workspace"]')).not.toBeNull();
    expect(container.querySelector(".catalogue-list")).toBeNull();
    expect(window.location.hash).toContain(`product=${productId}`);
    expect(fetch.mock.calls.some(([, options]) => options?.method)).toBe(false);
    await click("All products");
    expect(container.querySelector(".catalogue-list")).not.toBeNull();
    expect(window.location.hash).not.toContain("product=");
    await act(async () => {
      window.history.replaceState(null, "", `/#products?business=${businessId}&product=${scanId}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector('[aria-label="Different shirt product workspace"]')).not.toBeNull();
    expect(container.querySelector(".product-tools")).toBeNull();
  });

  it.each([false, true])("carries an exact recommendation through product selection and back (saved action: %s), without applying it or starting AI", async (savedAction) => {
    const actionId = "a".repeat(64);
    const opportunity = {
      id: actionId, title: "Clarify sizing", detail: "Check measurements.", agents: ["growth"], reviewReason: "Requires validation.",
      sources: [{ id: "e_1111111111111111", url: "https://shop.example.com/", quote: "Five sizes are available.", capturedAt: timestamp }],
      strategy: { objective: "Clarify sizing", actions: ["Check measurements."], metric: "Enquiries", hypothesis: "Check sizing.", measurement: "Choose a baseline." },
    };
    window.history.replaceState(null, "", `/#products?business=${businessId}&action=${actionId}`);
    const fetch = fetcher((path) => path.endsWith("/growth") ? json({
      opportunities: [opportunity], plan: savedAction ? [{
        opportunity, status: "planned", impact: "unknown", effort: "unknown", timeToValue: "unknown", revision: 0, createdAt: timestamp, updatedAt: timestamp,
      }] : [], researchStatus: "partial", evidenceSavedAt: timestamp,
    }) : path.endsWith("/intelligence") ? json({ configured: true, analysis: null, stale: false, running: false, error: null })
      : json({ products: [product] }));
    await render();
    expect(container.querySelector(".journey-task h2")?.textContent).toBe(opportunity.title);
    expect(container.querySelector(".journey-task")?.textContent).toContain("no product has been selected for you");
    expect(container.querySelector(".journey-task .agent-sources")?.textContent).toContain("Five sizes are available");
    expect(container.querySelector(".product-intelligence")).toBeNull();
    await click("Open product workspace");
    expect(window.location.hash).toContain(`action=${actionId}`);
    expect(window.location.hash).toContain(`product=${productId}`);
    await click("All products");
    expect(window.location.hash).toBe(`#products?business=${businessId}&action=${actionId}`);
    expect(container.querySelector(".journey-task .journey-actions a")?.getAttribute("href")).toBe(`#${savedAction ? "actions" : "growth"}?business=${businessId}&action=${actionId}`);
    expect(fetch.mock.calls.some(([, options]) => options?.method)).toBe(false);
    await act(async () => {
      window.history.replaceState(null, "", `/#products?business=${businessId}&action=${"b".repeat(64)}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector(".journey-task [role='alert']")?.textContent).toContain("no longer available");
    expect(container.querySelector(".journey-task h2")).toBeNull();
  });

  it("requires a decision for uncertain matches and explicitly skips invalid preview rows", async () => {
    const fetch = fetcher((path, options) => {
      if (path.endsWith("/csv")) return json({ draft }, 201);
      if (path.endsWith("/commit")) return json({ result: { imported: 1, skipped: 1, created: 0, updated: 0 } });
      if (options?.method) throw new Error("Unexpected mutation");
      return json({ products: [product] });
    });
    await render(); await set("csv", "listing_id,name\none,Fixture tee\ntwo,");
    await click("Preview CSV");
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/product-imports/csv`, expect.objectContaining({ method: "POST" }));
    expect(container.querySelector(".import-review")?.textContent).toContain("name: Product name is required");
    expect([...container.querySelectorAll(".import-summary dd")].map((count) => count.textContent)).toEqual(["1", "1"]);
    expect(container.querySelectorAll(".import-rows .import-row")).toHaveLength(1);
    const sourceDetails = container.querySelector<HTMLDetailsElement>(".import-source-details")!;
    expect(sourceDetails.open).toBe(false);
    expect(sourceDetails.textContent).toContain("CSV row 2");
    expect(sourceDetails.parentElement?.querySelector(":scope > p")?.textContent).toBe("499.00 INR");
    await act(async () => sourceDetails.querySelector("summary")!.click());
    expect(sourceDetails.open).toBe(true);
    expect(container.querySelector<HTMLDetailsElement>(".import-skipped")?.open).toBe(false);
    expect(container.querySelector(".import-skipped select")).toBeNull();
    expect(container.querySelector(".import-review .form-error")).toBeNull();
    expect(container.querySelector(".import-review [role=alert]")).toBeNull();
    await click("Confirm import");
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/commit"))).toBe(false);
    expect(container.textContent).toContain("explicitly choose");
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(".import-row select")!;
      select.value = `id:${productId}`; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Confirm import");
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/product-imports/${importId}/commit`, expect.objectContaining({
      body: JSON.stringify({ decisions: [{ row: 2, action: "link", productId }, { row: 3, action: "skip" }] }),
    }));
    expect(container.textContent).toContain("Import saved: 1 listings");
    expect(container.querySelector(".import-review")).toBeNull();
  });

  it("imports only a selected owned scan ID and renders untrusted names inertly", async () => {
    const fetch = fetcher((path) => path.endsWith("/website") ? json({ draft: { ...draft, source: "website" } }, 201) : json({ products: [{ ...product, name: "<script>not executable</script>" }] }));
    await render(); await click("Preview website products");
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/product-imports/website`, expect.objectContaining({ body: JSON.stringify({ scanId }) }));
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>not executable</script>");
    expect(container.textContent).toContain("Nothing is imported");
    await click("Cancel import");
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/commit"))).toBe(false);
  });

  it("shows product names and images in previews and saved cards, with a fallback for failed or missing images", async () => {
    const imageUrl = "https://cdn.example.com/products/tee.jpg?v=1";
    fetcher((path) => path.endsWith("/website") ? json({
      draft: { ...draft, source: "website", rows: [{ ...draft.rows[0], data: { ...data, imageUrl } }, draft.rows[1]] },
    }) : json({ products: [{ ...product, listings: [{ ...product.listings[0], data: { ...data, imageUrl } }] }, {
      ...product, id: scanId, name: "Older product", listings: [{ ...product.listings[0], data }],
    }] }));
    await render(); await click("Preview website products");
    expect(container.querySelector(".import-rows h3")?.textContent).toBe("Fixture tee");
    expect(container.querySelector(".import-row label")?.textContent).toContain("Import action for Fixture tee");
    expect([...container.querySelectorAll(".import-review h3")].some((heading) => /^Row \d/.test(heading.textContent ?? ""))).toBe(false);
    const image = container.querySelector<HTMLImageElement>(".import-rows img")!;
    expect(image.getAttribute("src")).toBe(imageUrl);
    expect(image.alt).toBe("Fixture tee");
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(container.querySelector(".catalogue-product img")?.getAttribute("src")).toBe(imageUrl);
    expect(container.querySelector('[aria-label="Image unavailable for Older product"]')).not.toBeNull();
    await act(async () => image.dispatchEvent(new Event("error")));
    expect(container.querySelector(".import-rows img")).toBeNull();
    expect(container.querySelector('.import-rows [aria-label="Image unavailable for Fixture tee"]')).not.toBeNull();
    expect(container.querySelector(".import-review .form-error")).toBeNull();
  });

  it("explains an entirely skipped website draft without enabling an empty import or flooding alerts", async () => {
    const fetch = fetcher((path) => path.endsWith("/website") ? json({
      draft: { ...draft, source: "website", rows: [draft.rows[1]], matches: [draft.matches[1]] },
    }, 201) : json({ products: [] }));
    await render(); await click("Preview website products");
    expect([...container.querySelectorAll(".import-summary dd")].map((count) => count.textContent)).toEqual(["0", "1"]);
    expect(container.querySelector(".import-review")?.textContent).toContain("No importable records in this draft");
    expect(container.querySelectorAll(".import-rows .import-row")).toHaveLength(0);
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Confirm import")?.disabled).toBe(true);
    const details = container.querySelector<HTMLDetailsElement>(".import-skipped")!;
    expect(details.open).toBe(false);
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("website's published Product JSON-LD");
    expect(details.textContent).toContain("name: Product name is required");
    expect(details.textContent).not.toContain("fix the CSV");
    expect(container.querySelector(".import-review [role=alert]")).toBeNull();
    await click("Confirm import");
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/commit"))).toBe(false);
    await click("Cancel import");
    expect(container.querySelector(".import-review")).toBeNull();
  });

  it("distinguishes incomplete source entries from usable records on the same captured page without merging them", async () => {
    const reference = "https://shop.example.com/products/tee";
    const rows: ImportDraft["rows"] = [
      { ...draft.rows[0], row: 1, reference, data },
      { ...draft.rows[1], row: 2, reference, data: { ...data, sku: "" }, errors: ["identity: No usable product identifier was supplied."] },
      { ...draft.rows[1], row: 3, reference: "https://shop.example.com/products/other", preview: { name: data.name } },
      { ...draft.rows[1], row: 4, reference, capturedAt: "2026-11-15T12:00:00.000Z", preview: { name: data.name } },
    ];
    const fetch = fetcher((path) => path.endsWith("/website") ? json({
      draft: { ...draft, source: "website", rows, matches: rows.map((row) => ({ row: row.row, kind: "new", productId: null, candidates: [] })) },
    }) : path.endsWith("/commit") ? json({ result: { imported: 1, skipped: 3, created: 1, updated: 0 } }) : json({ products: [] }));
    await render(); await click("Preview website products");
    expect(container.querySelector(".import-review")?.textContent).toContain("not counts of missing products");
    expect([...container.querySelectorAll(".import-summary dd")].map((count) => count.textContent)).toEqual(["1", "3"]);
    const skipped = container.querySelectorAll(".import-skipped .import-row");
    expect(skipped[0].querySelector(".import-page-context")?.textContent).toContain("Usable records from this same captured page: Fixture tee");
    expect(skipped[0].textContent).toContain("has not been merged");
    expect(skipped[0].textContent).toContain("identity: No usable product identifier");
    expect(skipped[1].querySelector(".import-page-context")).toBeNull();
    expect(skipped[2].querySelector(".import-page-context")).toBeNull();
    expect(container.querySelectorAll(".import-rows select")).toHaveLength(1);
    await click("Confirm import");
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/product-imports/${importId}/commit`, expect.objectContaining({
      body: JSON.stringify({ decisions: [{ row: 1, action: "new" }, { row: 2, action: "skip" }, { row: 3, action: "skip" }, { row: 4, action: "skip" }] }),
    }));
  });

  it("refreshes old previews explicitly, retains validated fields on rejected records, and resets decisions", async () => {
    window.history.replaceState(null, "", `/#products?business=${businessId}&import=${importId}`);
    const refreshed: ImportDraft = {
      ...draft, id: scanId, source: "website", rows: [
        { ...draft.rows[0], data: { ...data, name: "Refreshed tee", imageUrl: "https://cdn.example.com/tee.jpg" } },
        { ...draft.rows[1], errors: ["price: Use a nonnegative decimal price."], preview: { name: "Recognizable rejected tee", sku: "BAD", imageUrl: "https://cdn.example.com/rejected.jpg" } },
      ],
    };
    let failed = true;
    const fetch = fetcher((path) => path.endsWith("/refresh")
      ? failed ? json({ error: "Original saved evidence unavailable." }, 409) : json({ draft: refreshed }, 201)
      : path.endsWith(`/product-imports/${importId}`) ? json({ draft: { ...draft, source: "website" } })
      : path.endsWith(`/product-imports/${scanId}`) ? json({ draft: refreshed })
      : json({ products: [] }));
    await render();
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(".import-rows select")!;
      select.value = "new"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Refresh from saved scan");
    expect(container.textContent).toContain("Original saved evidence unavailable");
    expect(container.querySelector<HTMLSelectElement>(".import-rows select")?.value).toBe("new");
    failed = false;
    await click("Refresh from saved scan");
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/product-imports/${importId}/refresh`, expect.objectContaining({ method: "POST", body: "{}" }));
    expect(container.querySelector(".import-rows h3")?.textContent).toBe("Refreshed tee");
    expect(container.querySelector<HTMLSelectElement>(".import-rows select")?.value).toBe("review");
    expect(container.querySelector(".import-rows img")?.getAttribute("src")).toBe("https://cdn.example.com/tee.jpg");
    expect(container.querySelector(".import-skipped h3")?.textContent).toBe("Recognizable rejected tee");
    expect(container.querySelector(".import-skipped img")?.getAttribute("src")).toBe("https://cdn.example.com/rejected.jpg");
    expect(container.querySelector(".import-skipped")?.textContent).toContain("Fields requiring attention");
    expect(container.querySelector(".import-skipped")?.textContent).toContain("price: Use a nonnegative decimal price");
    expect(container.querySelector(".import-skipped select")).toBeNull();
    expect(container.textContent).toContain("No new scan or AI call was made");
    expect(window.location.hash).toContain(`import=${scanId}`);
    await click("Confirm import");
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/commit"))).toBe(false);
    await click("Reload catalogue");
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/product-imports/${scanId}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.querySelector(".import-rows h3")?.textContent).toBe("Refreshed tee");
  });

  it("opens the agent's saved product draft for its business without committing it", async () => {
    window.history.replaceState(null, "", `/#products?business=${businessId}&import=${importId}`);
    const fetch = fetcher((path) => path.endsWith(`/product-imports/${importId}`) ? json({ draft: { ...draft, source: "website" } }) : json({ products: [] }));
    const selected = vi.fn();
    await act(async () => root.render(<ProductsWorkspace selectedBusinessId={scanId} onBusinessSelected={selected} onSessionExpired={expired} />));
    expect(selected).toHaveBeenCalledWith(businessId);
    expect(container.querySelector(".import-review")?.textContent).toContain("Products found on your website");
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/product-imports/${importId}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("can reload a product review when the agent draft initially fails to load", async () => {
    window.history.replaceState(null, "", `/#products?business=${businessId}&import=${importId}`);
    let failed = true;
    const fetch = fetcher((path) => path.endsWith(`/product-imports/${importId}`)
      ? failed ? json({ error: "Review temporarily unavailable" }, 503) : json({ draft })
      : json({ products: [] }));
    await render();
    expect(container.textContent).toContain("Review temporarily unavailable");
    failed = false;
    await click("Reload catalogue");
    expect(container.querySelector(".import-review")).not.toBeNull();
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("makes legacy website discoveries ready without an import review, scan or AI call", async () => {
    const fetch = fetcher((path) => path.endsWith(`/scans/${scanId}/catalogue`)
      ? json({ catalogue: { created: 1, updated: 0, unchanged: 0, skipped: 0, issues: [] }, products: [{ ...product, listings: [{ ...product.listings[0], source: "website", data: { ...data, imageUrl: "https://cdn.example.com/tee.jpg" } }] }] })
      : json({ products: [] }), understanding);
    await render();
    expect(container.querySelector(".import-review")).toBeNull();
    expect(container.querySelector(".catalogue-product h3")?.textContent).toBe(data.name);
    expect(container.querySelector(".catalogue-product")?.textContent).toContain("499.00 INR");
    expect(container.querySelector(".catalogue-product img")?.getAttribute("src")).toBe("https://cdn.example.com/tee.jpg");
    expect(container.querySelector<HTMLDetailsElement>(".product-tools")?.open).toBe(false);
    expect(container.textContent).toContain("No import confirmation is needed");
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/scans/${scanId}/catalogue`, expect.objectContaining({ method: "POST", body: "{}" }));
    expect(fetch.mock.calls.filter(([, options]) => options?.method).map(([path]) => path)).toEqual([`/api/businesses/${businessId}/scans/${scanId}/catalogue`]);
  });

  it("does not reopen an already imported discovery as an unconfirmed product review", async () => {
    const fetch = fetcher((path) => path.endsWith(`/scans/${scanId}/catalogue`)
      ? json({ catalogue: { created: 0, updated: 0, unchanged: 1, skipped: 0, issues: [] }, products: [product] })
      : json({ products: [product] }), understanding);
    await render();
    expect(container.querySelector(".import-review")).toBeNull();
    expect(container.querySelector(".catalogue-product h3")?.textContent).toBe(data.name);
    expect(container.textContent).toContain("No import confirmation is needed");
    expect(fetch.mock.calls.some(([path]) => path.includes("/product-imports/"))).toBe(false);
  });

  it("keeps the catalogue visible if saved-scan synchronization fails and retries without paid calls", async () => {
    let failed = true;
    const fetch = fetcher((path) => path.endsWith(`/scans/${scanId}/catalogue`)
      ? failed ? json({ error: "Saved discovery temporarily unavailable" }, 503) : json({ catalogue: { created: 0, updated: 0, unchanged: 1, skipped: 1, issues: [{ reference: "https://shop.example.com/invalid", name: "Skipped tee", message: "Invalid price." }] }, products: [product] })
      : json({ products: [product] }), understanding);
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Saved discovery temporarily unavailable");
    expect(container.querySelector(".catalogue-product h3")?.textContent).toBe(data.name);
    failed = false;
    await click("Reload catalogue");
    expect(container.querySelector(".import-review")).toBeNull();
    expect(container.textContent).toContain("Skipped tee");
    expect(container.textContent).toContain("Invalid price.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(fetch.mock.calls.filter(([, options]) => options?.method).every(([path]) => path.endsWith(`/scans/${scanId}/catalogue`))).toBe(true);
  });

  it("loads discoveries for the active business and never follows another business's import link", async () => {
    const second = { ...business, id: productId, name: "Second shop" };
    window.history.replaceState(null, "", `/#products?business=${scanId}&import=${importId}`);
    const selected = vi.fn();
    const fetch = vi.fn(async (path: string, _options?: RequestInit) => {
      if (path === "/api/businesses") return json({ businesses: [business, second] });
      if (path.endsWith("/products")) return json({ products: [] });
      if (path.endsWith("/scans")) return json({ scans: [] });
      if (path.endsWith("/understanding")) return json({ understanding: null });
      if (path.endsWith("/product-intelligence")) return json({ analyses: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<ProductsWorkspace selectedBusinessId={second.id} onBusinessSelected={selected} onSessionExpired={expired} />));
    expect(container.querySelector<HTMLSelectElement>(".business-toolbar select")?.value).toBe(second.id);
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${second.id}/understanding`, expect.anything());
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(".business-toolbar select")!;
      select.value = businessId; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(selected).toHaveBeenCalledWith(businessId);
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${businessId}/understanding`, expect.anything());
    expect(fetch.mock.calls.some(([path]) => path.includes("/product-imports/"))).toBe(false);
    expect(fetch.mock.calls.some(([, options]) => options?.method)).toBe(false);
  });

  it("keeps commit failures retryable, displays loading errors and expires private sessions", async () => {
    const fetch = fetcher((path) => path.endsWith("/csv") ? json({ draft: { ...draft, matches: draft.matches.map((match) => ({ ...match, kind: "new", productId: null })) } })
      : path.endsWith("/commit") ? json({ error: "Source snapshot is stale; preview again." }, 409) : json({ products: [] }));
    await render(); await set("csv", "listing_id,name\none,Fixture");
    await click("Preview CSV"); await click("Confirm import");
    expect(container.textContent).toContain("Source snapshot is stale");
    expect(container.querySelector('.products-workspace > .form-error[role="alert"]')?.textContent).toContain("Source snapshot is stale");
    expect(container.querySelector(".import-review")).not.toBeNull();
    expect(container.textContent).not.toContain("Import saved:");
    fetch.mockResolvedValue(json({ error: "Please log in" }, 401));
    await click("Confirm import");
    expect(expired).toHaveBeenCalledOnce();
  });
});
