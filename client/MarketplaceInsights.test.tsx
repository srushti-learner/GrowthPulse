// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplaceInsights } from "./MarketplaceInsights";
import { MarketplaceResearchProvider } from "./MarketplaceResearchContext";
import { MarketIntelligence } from "./MarketIntelligence";
import { BusinessWorkspace } from "./BusinessWorkspace";
import { emptyProduct, type Product } from "../shared/products";
import type { MarketplaceResponse } from "../shared/marketplace";

const businessId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const createdAt = "2026-11-18T05:30:00.000Z";
const product: Product = { id: productId, businessId, name: "Fixture hair oil", description: "Owner-provided description", sku: "", gtin: "",
  createdAt, updatedAt: createdAt, listings: [{ id: "33333333-3333-4333-8333-333333333333", source: "manual", sourceName: "Owner",
    sourceKey: "fixture", reference: "Manual record", capturedAt: createdAt, data: { ...emptyProduct, name: "Fixture hair oil" } }] };
const endpoint = `/api/businesses/${businessId}/products/${productId}/marketplace`;
const initial: MarketplaceResponse = {
  configured: true, discoveryConfigured: true, running: false, stale: false, error: null,
  report: {
    id: "44444444-4444-4444-8444-444444444444", productId, productName: product.name, fingerprint: "a".repeat(64), createdAt,
    analysedAt: null, themes: [], limitations: ["A bounded sample, not the whole market."],
    listings: [{
      id: "m_1111111111111111", url: "https://www.amazon.in/dp/B000000001", marketplace: "Amazon India",
      title: product.name, description: "A captured listing description", capturedAt: createdAt, method: "owner_export",
      status: "captured", limitation: "Owner-supplied export, not independently fetched.", gtin: "", variants: "100 ml", seller: "",
      price: "399", currency: "INR", rating: null, reviewCount: null, relation: "unconfirmed", identifierMatch: false, sources: [],
      reviews: [{ id: "r_1111111111111111", text: "The bottle leaks during dispensing.", rating: 2, date: "2026-10-01" },
        { id: "r_2222222222222222", text: "Packaging leaks every time I pour.", rating: 1, date: null }],
    }],
  },
};
describe("product-focused Marketplace Insights", () => {
  let container: HTMLDivElement, root: Root, state: MarketplaceResponse;
  const fetcher = vi.fn<typeof fetch>();
  const expired = vi.fn();
  beforeEach(() => {
    state = structuredClone(initial); fetcher.mockReset(); expired.mockReset();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fetcher.mockImplementation(async (path, options) => {
      if (String(path).endsWith("/products")) return Response.json({ products: [product] });
      if (options?.method === "PATCH") {
        const body = JSON.parse(String(options.body));
        state = { ...state, report: { ...state.report!, listings: state.report!.listings.map((item) => ({ ...item, relation: body.relation })) } };
      }
      if (options?.method === "POST") state = { ...state, running: true };
      return Response.json(state);
    });
    vi.stubGlobal("fetch", fetcher);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  async function render(id = businessId, standalone = true, marketRunning = false) {
    await act(async () => root.render(<MarketplaceResearchProvider businessId={id} onSessionExpired={expired}>
      {standalone && <MarketplaceInsights businessId={id} />}
      <MarketIntelligence businessName="Fixture shop" renderComparison={() => null}
        report={{ version: 1, status: marketRunning ? "running" : "complete", enabled: true, steps: [], usage: { modelCalls: 0, searches: 0, competitorScans: 0 } }} />
    </MarketplaceResearchProvider>));
  }
  function button(text: string) { return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === text)!; }
  it("opens saved evidence without paid calls and keeps unknown metrics and ownership explicit", async () => {
    await render();
    expect(container.textContent).toContain("Your product in the marketplace");
    expect(container.textContent).toContain("Owner-supplied export");
    expect(container.textContent).toContain("Needs confirmation");
    expect(container.textContent).toContain("Review counts are not orders");
    expect(container.textContent).toContain("Not captured");
    expect(button("Analyse confirmed reviews").disabled).toBe(true);
    expect(button("Research again").disabled).toBe(false);
    expect(container.querySelector('.marketplace-insights input[type="checkbox"]')).toBeNull();
    const options = container.querySelector<HTMLDetailsElement>(".marketplace-research-controls > details")!;
    expect(options.open).toBe(false);
    expect(options.querySelector("summary")?.textContent).toBe("Research options and details");
    expect(options.textContent).toContain("product details to Anthropic and Tavily");
    expect(options.textContent).toContain("Reopening saved results starts no paid research");
    expect(container.querySelector(".marketplace-research-controls > .field-note")).toBeNull();
    expect(container.querySelector(".marketplace-product > .field-note")).toBeNull();
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    expect(container.textContent).not.toContain("m_1111111111111111");
    expect(container.querySelectorAll("h1")).toHaveLength(0);
  });
  it("keeps disclosures and manual research options available without starting paid work", async () => {
    state.report = null;
    await render();
    const options = container.querySelector<HTMLDetailsElement>(".marketplace-research-controls > details")!;
    await act(async () => options.querySelector("summary")!.click());
    expect(options.open).toBe(true);
    expect(options.textContent).toContain("Provider charges may apply");
    expect(options.querySelector("textarea")).not.toBeNull();
    expect(options.querySelector('input[type="file"]')).not.toBeNull();
    expect(button("Research marketplaces").disabled).toBe(false);
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it("saves an explicit listing relationship before admitting review analysis", async () => {
    await render();
    await act(async () => button("My product, another seller").click());
    const request = fetcher.mock.calls.find(([path]) => String(path).endsWith("/match"))!;
    expect(request[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(request[1]?.body))).toEqual({ reportId: initial.report!.id, listingId: initial.report!.listings[0].id, relation: "other_seller" });
    expect(button("My product, another seller").getAttribute("aria-pressed")).toBe("true");
    expect(button("Analyse confirmed reviews").disabled).toBe(false);
    await act(async () => button("Analyse confirmed reviews").click());
    expect(fetcher.mock.calls.find(([path]) => String(path).endsWith("/analyse"))?.[1]?.body)
      .toBe(JSON.stringify({ reportId: initial.report!.id, consent: true }));
    expect(container.textContent).toContain("Loading your marketplace research progress");
  });
  it("starts discovery only on the disclosed action click and reconnects through saved status", async () => {
    state.report = null;
    await render(); expect(button("Research marketplaces").disabled).toBe(false);
    await act(async () => button("Customer voiceNo feedback saved").click());
    expect(container.querySelector(".marketplace-customer-voice")?.textContent).toContain("No customer feedback saved yet");
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    await act(async () => button("Research marketplaces").click());
    const mutation = fetcher.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(JSON.parse(String(mutation[1]?.body))).toMatchObject({ consent: true, urls: [], refresh: false });
    expect(mutation[0]).toBe(endpoint);
    expect(container.textContent).toContain("Research continues if you leave this page");
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });
  it("does not apply an old product's late mutation after switching businesses", async () => {
    let finish!: (value: Response) => void;
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => options?.method === "POST"
      ? new Promise((resolve) => { finish = resolve; }) : original(path, options));
    await render();
    await act(async () => button("Research again").click());
    await render("55555555-5555-4555-8555-555555555555");
    expect(fetcher.mock.calls.some(([, options]) => options?.method === "POST" && options.signal?.aborted)).toBe(true);
    await act(async () => finish(Response.json({ ...initial, running: true })));
    expect(container.querySelector(".workflow-activity")).toBeNull();
  });
  it("preserves visible errors and refuses stale confirmations", async () => {
    state.stale = true; state.error = "Marketplace research was interrupted. No automatic retry was made.";
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("interrupted");
    expect(container.textContent).toContain("Your catalogue product changed");
    expect(button("My listing").closest("fieldset")?.disabled).toBe(true);
    expect(button("Analyse confirmed reviews").disabled).toBe(true);
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it("distinguishes saved-status reloads from explicit retries and retains saved feedback", async () => {
    state.error = "The marketplace search category was not grounded in your saved product. No search was made.";
    state.report!.listings[0].relation = "my_listing";
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, options) => {
      if (options?.method === "POST") state = { ...state, error: null };
      return original(path, options);
    });
    await render();
    await act(async () => button("Customer voiceFeedback research needs attention").click());
    expect(container.querySelector(".marketplace-customer-voice")?.textContent).toContain("The bottle leaks during dispensing.");
    expect(button("Retry marketplace research").disabled).toBe(false);
    expect(container.textContent).toContain("Reload saved status only refreshes this saved message");
    await act(async () => button("Reload saved status").click());
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    await act(async () => button("Retry marketplace research").click());
    const requests = fetcher.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0][1]?.body))).toMatchObject({ consent: true, refresh: true, urls: [] });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Loading your marketplace research progress");
    expect(container.querySelector(".marketplace-customer-voice")?.textContent).toContain("The bottle leaks during dispensing.");
  });

  it("connects confirmed feedback to Customer voice and keeps own-product and comparable samples separate", async () => {
    const listing = state.report!.listings[0];
    listing.relation = "other_seller";
    state.report!.analysedAt = createdAt;
    state.report!.listings.push({
      ...listing, id: "m_2222222222222222", relation: "alternative", method: "public_page",
      title: "Comparable oil", url: "https://www.flipkart.com/comparable/p/item123",
      reviews: [{ id: "r_3333333333333333", text: "The fragrance is pleasantly mild.", rating: 5, date: "2026-10-03" },
        { id: "r_4444444444444444", text: "I like the very subtle fragrance.", rating: 4, date: "2026-10-04" }],
    }, {
      ...listing, id: "m_3333333333333333", relation: "unconfirmed",
      reviews: [{ id: "r_5555555555555555", text: "Unconfirmed feedback must stay out.", rating: 1, date: null }],
    }, {
      ...listing, id: "m_4444444444444444", relation: "excluded",
      reviews: [{ id: "r_6666666666666666", text: "Excluded feedback must stay out.", rating: 1, date: null }],
    }, {
      ...listing, id: "m_5555555555555555", status: "unavailable",
      reviews: [{ id: "r_7777777777777777", text: "Unavailable feedback must stay out.", rating: 1, date: null }],
    });
    state.report!.themes = [
      { scope: "own_product", title: "Packaging complaints", sentiment: "negative", reviewIds: listing.reviews.map((value) => value.id), experiment: "Test a different dispenser." },
      { scope: "alternatives", title: "Mild fragrance praise", sentiment: "positive", reviewIds: ["r_3333333333333333", "r_4444444444444444"], experiment: "Ask buyers about fragrance preference." },
      { scope: "own_product", title: "Do not mix product feedback", sentiment: "mixed", reviewIds: ["r_1111111111111111", "r_3333333333333333"], experiment: "Should not be displayed." },
    ];
    await render();
    expect(button("Customer voice4 sampled review excerpts")).toBeDefined();
    await act(async () => button("Customer voice4 sampled review excerpts").click());
    const feedback = container.querySelector('[aria-label="Saved marketplace customer feedback"]')!;
    const own = feedback.querySelector('[aria-label="Your product feedback"]')!;
    const alternatives = feedback.querySelector('[aria-label="Comparable product feedback"]')!;
    expect(own.textContent).toContain("Packaging complaints");
    expect(own.textContent).toContain("My product, another seller");
    expect(own.textContent).toContain("Owner-supplied export, not independently fetched");
    expect(own.textContent).toContain("1 undated excerpt");
    expect(own.textContent).not.toContain("Mild fragrance praise");
    expect(alternatives.textContent).toContain("Mild fragrance praise");
    expect(alternatives.textContent).toContain("Captured public page");
    expect(alternatives.textContent).not.toContain("Packaging complaints");
    const quote = own.querySelector(":scope > .feedback-quote")!;
    expect(quote.closest("details")).toBeNull();
    expect(quote.querySelector("a")?.getAttribute("href")).toBe(listing.url);
    expect(own.querySelector(".feedback-takeaway")!.compareDocumentPosition(quote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(quote.compareDocumentPosition(feedback.querySelector(".marketplace-feedback-tools")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(feedback.querySelector<HTMLDetailsElement>(".marketplace-source-review")?.open).toBe(false);
    expect(feedback.querySelector(".feedback-progress")).toBeNull();
    expect(own.querySelector("time")?.getAttribute("datetime")).toBe(createdAt);
    expect(feedback.textContent).not.toMatch(/Unconfirmed feedback|Excluded feedback|Unavailable feedback|Do not mix product feedback/);
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("updates Customer voice after match confirmation and explicit analysis without a second data loader", async () => {
    await render(businessId, false);
    await act(async () => button("Customer voiceConfirm listing matches").click());
    const feedback = () => container.querySelector('[aria-label="Saved marketplace customer feedback"]')!;
    expect(feedback().textContent).toContain("waiting for listing confirmation");
    expect(feedback().textContent).not.toContain("The bottle leaks during dispensing.");
    const sources = feedback().querySelector<HTMLDetailsElement>(".marketplace-source-review")!;
    expect(sources.open).toBe(false);
    expect(button("Analyse confirmed reviews")).toBeUndefined();
    await act(async () => button("Review product matches").click());
    expect(sources.open).toBe(true);
    expect(document.activeElement).toBe(sources.querySelector("summary"));
    expect(fetcher.mock.calls).toHaveLength(2);
    await act(async () => button("My listing").click());
    expect(feedback().textContent).toContain("The bottle leaks during dispensing.");
    expect(feedback().textContent).toContain("not an AI sentiment summary");
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, options) => {
      if (String(path).endsWith("/analyse")) {
        state = { ...state, report: { ...state.report!, analysedAt: createdAt, themes: [{
          title: "Packaging complaints", scope: "own_product", sentiment: "negative",
          reviewIds: ["r_1111111111111111", "r_2222222222222222"], experiment: "Test a different dispenser.",
        }] } };
        return Response.json(state);
      }
      return original(path, options);
    });
    await act(async () => button("Analyse confirmed reviews").click());
    expect(feedback().textContent).toContain("Packaging complaints");
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    await act(async () => button("Not relevant").click());
    expect(feedback().textContent).not.toContain("Packaging complaints");
    expect(feedback().textContent).not.toContain("The bottle leaks during dispensing.");
  });

  it("does not present stale evidence as current customer feedback or invent trend data", async () => {
    state.stale = true;
    state.report!.listings[0].relation = "my_listing";
    await render();
    await act(async () => button("Customer voicePrevious product evidence").click());
    const feedback = container.querySelector('[aria-label="Saved marketplace customer feedback"]')!;
    expect(feedback.textContent).toContain("not presented as current customer feedback");
    expect(feedback.textContent).not.toContain("The bottle leaks during dispensing.");
    await act(async () => button("Market overview").click());
    await act(async () => button("Market trendsTrend data not configured").click());
    expect(container.querySelector(".market-data-gap")?.textContent).toContain("do not establish trends");
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("clears Customer voice on product and business switches and ignores late saved results", async () => {
    const other = { ...product, id: "66666666-6666-4666-8666-666666666666", name: "Other product" };
    let finish!: (value: Response) => void;
    fetcher.mockImplementation(async (path) => {
      if (String(path).endsWith("/products")) return Response.json({ products: [product, other] });
      if (String(path).includes(other.id)) return new Promise((resolve) => { finish = resolve; });
      return Response.json({ ...initial, report: { ...initial.report!, listings: initial.report!.listings.map((item) => ({ ...item, relation: "my_listing" })) } });
    });
    await render();
    await act(async () => button("Customer voice2 sampled review excerpts").click());
    const feedback = () => container.querySelector('[aria-label="Saved marketplace customer feedback"]')!;
    expect(feedback().textContent).toContain("The bottle leaks during dispensing.");
    const select = feedback().querySelector("select")!;
    await act(async () => { select.value = other.id; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(feedback().textContent).toContain("Loading saved customer feedback");
    expect(feedback().textContent).not.toContain("The bottle leaks during dispensing.");
    await render("55555555-5555-4555-8555-555555555555");
    await act(async () => finish(Response.json({ ...initial, report: { ...initial.report!, productId: other.id } })));
    expect(container.textContent).not.toContain("Loading saved customer feedback");
    expect(fetcher.mock.calls.some(([, options]) => options?.signal?.aborted)).toBe(true);
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("shows customer feedback for businesses without website research", async () => {
    state.report!.listings[0].relation = "my_listing";
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, options) => String(path) === "/api/businesses"
      ? Response.json({ businesses: [{ id: businessId, name: "Social seller", website: "", category: "", description: "", createdAt, updatedAt: createdAt }] })
      : original(path, options));
    await act(async () => root.render(<BusinessWorkspace activityOnly={false} researchOnly researchView="intelligence" onSessionExpired={expired} />));
    expect(container.querySelectorAll(".marketplace-insights")).toHaveLength(0);
    expect(container.querySelectorAll(".marketplace-customer-voice")).toHaveLength(1);
    expect(button("Find fresh customer feedback")).toBeDefined();
    expect(container.querySelector(".marketplace-customer-voice")?.textContent).toContain("The bottle leaks during dispensing.");
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("runs collection, source confirmation and analysis entirely inside Customer voice with independent real progress", async () => {
    vi.useFakeTimers();
    state.report = null;
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, options) => {
      if (options?.method === "POST") {
        state = { ...state, running: true, progress: { stage: String(path).endsWith("/analyse") ? "analysing" : "discovering", completed: 0, total: 0 } };
        return Response.json(state);
      }
      return original(path, options);
    });
    await render(businessId, false, true);
    await act(async () => button("Customer voiceNo feedback saved").click());
    const feedback = () => container.querySelector<HTMLElement>(".marketplace-customer-voice")!;
    expect(container.querySelector(".dashboard-intro [data-slot=badge]")?.textContent).toBe("No feedback saved");
    expect(feedback().textContent).not.toContain("Marketplace Insights above");
    expect(feedback().textContent).toContain("Provider charges may apply");
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    await act(async () => button("Find customer feedback").click());
    const started = fetcher.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(started).toHaveLength(1);
    expect(JSON.parse(String(started[0][1]?.body))).toMatchObject({ consent: true, urls: [], refresh: false });
    expect(container.querySelector(".dashboard-intro [data-slot=badge]")?.textContent).toBe("Collecting customer feedback");
    expect(feedback().textContent).toContain("Finding product listings");
    expect(feedback().textContent).not.toContain("No customer feedback saved yet");
    state = { ...state, progress: { stage: "collecting", completed: 1, total: 2 } };
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(feedback().textContent).toContain("1 of 2 listings checked");
    state = structuredClone(initial);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(feedback().textContent).toContain("waiting for listing confirmation");
    expect(feedback().textContent).not.toContain("The bottle leaks during dispensing.");
    await act(async () => button("Review product matches").click());
    await act(async () => button("My product, another seller").click());
    expect(feedback().textContent).toContain("The bottle leaks during dispensing.");
    expect(button("Analyse confirmed reviews").disabled).toBe(false);
    await act(async () => button("Analyse confirmed reviews").click());
    expect(container.querySelector(".dashboard-intro [data-slot=badge]")?.textContent).toBe("Analysing customer feedback");
    expect(feedback().textContent).toContain("Analysing confirmed review excerpts.");
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(2);
  });

  it.each(["captured", "unavailable"] as const)("explains %s source gaps without passing off listing facts as customer insights", async (status) => {
    state.report!.listings[0] = { ...state.report!.listings[0], status, reviews: [], rating: 4.5, reviewCount: 499,
      limitation: "robots.txt does not allow GrowthPulseBot to read this page." };
    await render(businessId, false);
    await act(async () => button("Customer voiceNo confirmed review text").click());
    if (status === "unavailable") {
      expect(container.textContent).toContain("Some sources could not be read");
    }
    const empty = container.querySelector(".feedback-empty")!;
    expect(empty.textContent).toContain("No customer review text available yet");
    expect(empty.textContent).toContain("Star ratings, published review counts and product descriptions are not review text");
    expect(empty.textContent).toContain("Confirming a match does not collect missing review text");
    expect(empty.textContent).not.toContain("499");
    expect(container.querySelector(".feedback-takeaway")).toBeNull();
    expect(container.querySelector(".feedback-quote")).toBeNull();
    const sources = container.querySelector<HTMLDetailsElement>(".marketplace-source-review")!;
    expect(sources.open).toBe(false);
    expect(empty.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => sources.querySelector("summary")!.click());
    const notes = sources.querySelector<HTMLDetailsElement>(".feedback-listing-details")!;
    expect(notes.open).toBe(false);
    await act(async () => notes.querySelector("summary")!.click());
    expect(notes.open).toBe(true);
    expect(notes.textContent).toContain("robots.txt does not allow");
    const options = container.querySelector<HTMLDetailsElement>(".marketplace-research-controls > details")!;
    expect(options.querySelector("textarea")).not.toBeNull();
    expect(options.querySelector('input[type="file"]')).not.toBeNull();
    expect(button("Analyse confirmed reviews")).toBeUndefined();
    expect(container.querySelector(".feedback-progress")).toBeNull();
    expect(fetcher.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
  });

  it("keeps a confirmed sample readable when analysis accepts no recurring takeaway", async () => {
    state.report!.listings[0].relation = "my_listing";
    state.report!.analysedAt = createdAt;
    await render(businessId, false);
    await act(async () => button("Customer voice2 sampled review excerpts").click());
    const feedback = container.querySelector(".marketplace-customer-voice")!;
    expect(feedback.textContent).toContain("No recurring theme was accepted");
    expect(feedback.querySelector(".feedback-takeaway")).toBeNull();
    const quotes = feedback.querySelectorAll('[aria-label="Your product feedback"] > .feedback-quote');
    expect(quotes).toHaveLength(2);
    expect(quotes[0].textContent).toContain("The bottle leaks during dispensing.");
    expect(quotes[0].closest("details")).toBeNull();
    expect(button("Analyse confirmed reviews")).toBeUndefined();
    expect(fetcher.mock.calls).toHaveLength(2);
  });

  it("shows a single confirmed quote without admitting analysis or inventing a pattern", async () => {
    state.report!.listings[0].relation = "my_listing";
    state.report!.listings[0].reviews.pop();
    await render(businessId, false);
    await act(async () => button("Customer voice1 sampled review excerpt").click());
    const feedback = container.querySelector(".marketplace-customer-voice")!;
    expect(feedback.querySelectorAll('[aria-label="Your product feedback"] > .feedback-quote')).toHaveLength(1);
    expect(feedback.querySelector(".feedback-takeaway")).toBeNull();
    expect(button("Analyse confirmed reviews").disabled).toBe(true);
    expect(feedback.textContent).toContain("at least two distinct review excerpts");
    expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
});
