import { describe, expect, it, vi } from "vitest";
import { createWebsiteScanner } from "./website-scanner.js";
import { ScanError, type PublicResponse } from "./public-http.js";
import { scanLimits } from "../shared/website.js";

const origin = "https://shop.example.com";
const html = (body: string): PublicResponse => ({
  status: 200, headers: { "content-type": 'text/html; charset="utf-8"' },
  body: `<html><head><title>Fixture shop</title><meta name="description" content="Synthetic test business"></head><body>${body}</body></html>`,
});
function transport(routes: Record<string, PublicResponse>, robots = "User-agent: *\nDisallow: /private") {
  return vi.fn(async (url: URL) => url.pathname === "/robots.txt"
    ? { status: 200, headers: { "content-type": "text/plain" }, body: robots }
    : routes[url.pathname] ?? { status: 404, headers: {}, body: "" });
}

describe("bounded static website scanner with isolated fixture transport", () => {
  it("supports a single-listing capture without following links or fetching sitemaps", async () => {
    const read = transport({ "/": html('<h1>One product</h1><a href="/other">Other product</a>') });
    const result = await createWebsiteScanner(read)(origin, undefined, { singlePage: true });
    expect(result.pages).toHaveLength(1);
    expect(read.mock.calls.map(([url]) => url.pathname)).toEqual(["/robots.txt", "/"]);
  });
  it("samples only explicit listing review blocks with matching Amazon identity, without reviewer fields or page recommendations", async () => {
    const body = `<input id="ASIN" value="B000000001"><h1 id="productTitle">Fixture bottle</h1>
      <div id="cm-cr-dp-review-list">
        <div data-hook="review"><span class="a-profile-name">Private reviewer</span>
          <div data-hook="review-body"><span>The dispenser leaks<br>when I use it.</span><a>Read more</a></div></div>
        <div data-hook="review" hidden><div data-hook="review-body">Hidden review is not evidence.</div></div>
        <div data-hook="review" style="display: none"><div data-hook="review-body">Another hidden review.</div></div>
      </div>
      <aside data-hook="review"><div data-hook="review-body">Recommended product feedback must stay out.</div></aside>`;
    const read = transport({ "/dp/B000000001": html(body) });
    const result = await createWebsiteScanner(read)("https://www.amazon.in/dp/B000000001", undefined, { singlePage: true, marketplaceReviews: true });
    expect(result.pages[0].listingReviews).toEqual({ productUrl: "https://www.amazon.in/dp/B000000001", title: "Fixture bottle",
      reviews: [{ text: "The dispenser leaks when I use it." }] });
    const ordinary = await createWebsiteScanner(read)("https://www.amazon.in/dp/B000000001", undefined, { singlePage: true });
    expect(ordinary.pages[0].listingReviews).toBeUndefined();
    const mismatched = await createWebsiteScanner(transport({ "/dp/B000000002": html(body) }))(
      "https://www.amazon.in/dp/B000000002", undefined, { singlePage: true, marketplaceReviews: true });
    expect(mismatched.pages[0].listingReviews).toBeUndefined();
  });
  it("does not capture listing reviews when retention directives disallow storing the page", async () => {
    const read = transport({ "/dp/B000000001": html(`<meta name="robots" content="noarchive">
      <input id="ASIN" value="B000000001"><h1 id="productTitle">Fixture</h1>
      <div id="cm-cr-dp-review-list"><div data-hook="review"><div data-hook="review-body">Must never be captured.</div></div></div>`) });
    const result = await createWebsiteScanner(read)("https://www.amazon.in/dp/B000000001", undefined, { singlePage: true, marketplaceReviews: true });
    expect(result.pages).toEqual([]);
    expect(result.failures[0].message).toContain("prohibit retaining");
  });
  it("bounds static review capture to fifty excerpts of five hundred characters without extra requests", async () => {
    const body = `<input id="ASIN" value="B000000001"><h1 id="productTitle">Fixture bottle</h1>
      <div id="cm-cr-dp-review-list">${Array.from({ length: 60 }, () =>
        `<div data-hook="review"><div data-hook="review-body">${"Long fixture review. ".repeat(50)}</div></div>`).join("")}</div>`;
    const read = transport({ "/dp/B000000001": html(body) });
    const result = await createWebsiteScanner(read)("https://www.amazon.in/dp/B000000001", undefined, { singlePage: true, marketplaceReviews: true });
    expect(result.pages[0].listingReviews?.reviews).toHaveLength(50);
    expect(result.pages[0].listingReviews?.reviews.every((review) => review.text.length === 500)).toBe(true);
    expect(read.mock.calls.map(([url]) => url.pathname)).toEqual(["/robots.txt", "/dp/B000000001"]);
  });
  it("extracts traceable facts and prioritizes useful pages within the expanded attempt budget", async () => {
    const body = `<h1>Our fixture shop</h1><h2>Products</h2><p>Owner-published informational copy for a deterministic public HTML scan fixture, not a real business.</p>
      <a href="mailto:hello@example.test">Email</a><a href="tel:+10000000000">Call us</a><button>Shop now</button>
      <script>window.secret = 'script must not become evidence'</script><div hidden>Hidden secret</div>
      ${Array.from({ length: 30 }, (_, index) => `<a href="/page${index}#top">Page ${index}</a>`).join("")}
      <a href="/contact">Contact us</a><a href="https://other.example.com/">Outside</a>
      <a href="/login">Login</a><a href="/guide.pdf">Download</a><a href="/search?q=private">Search</a>`;
    const read = transport(Object.fromEntries([["/", html(body)], ["/contact", html("<h1>Contact</h1>")],
      ...Array.from({ length: 30 }, (_, index) => [`/page${index}`, html(`<h1>Page ${index}</h1>`)])]));
    const result = await createWebsiteScanner(read)(origin);
    expect(result.status).toBe("partial");
    expect(result.pages).toHaveLength(scanLimits.pages);
    expect(result.pages[0]).toMatchObject({
      url: `${origin}/`, title: "Fixture shop", description: "Synthetic test business",
      headings: [{ level: 1, text: "Our fixture shop" }, { level: 2, text: "Products" }],
      contacts: ["mailto:hello@example.test", "tel:+10000000000"],
    });
    expect(Date.parse(result.pages[0].capturedAt)).not.toBeNaN();
    expect(result.pages[0].text).not.toMatch(/script must|Hidden secret/);
    expect(result.pages[0].callsToAction).toContain("Shop now");
    expect(result.pages[1].url).toBe(`${origin}/contact`);
    expect(read.mock.calls.filter(([url]) => !["/robots.txt", "/sitemap.xml"].includes(url.pathname))).toHaveLength(scanLimits.pages);
    expect(read.mock.calls.every(([url]) => url.hostname === "shop.example.com")).toBe(true);
    expect(result.notes.join(" ")).toContain("not the full website or catalogue");
    expect(result.coverage).toMatchObject({ attemptedPages: 20, discoveredPages: 32, limited: true });
  }, 10_000);

  it("reports partial results when robots rules block a discovered page without fetching it", async () => {
    const read = transport({ "/": html('<h1>Home</h1><a href="/private">Details</a>') });
    const result = await createWebsiteScanner(read)(origin);
    expect(result.status).toBe("partial");
    expect(result.pages).toHaveLength(1);
    expect(result.failures[0].message).toContain("robots.txt does not allow");
    expect(read.mock.calls.some(([url]) => url.pathname === "/private")).toBe(false);
  });

  it("extracts a multi-megabyte storefront without expanding retained text or robots limits", async () => {
    const response = html(`<script>${" ".repeat(2 * 1024 * 1024)}</script><h1>Large storefront</h1><p>${"Business details. ".repeat(1000)}</p>`);
    const routes = transport({ "/": response });
    const read = vi.fn(async (url: URL, _signal: AbortSignal, maxBytes: number) => {
      const result = await routes(url);
      if (Buffer.byteLength(result.body) > maxBytes) throw new ScanError("Response exceeds the byte limit.");
      return result;
    });
    const result = await createWebsiteScanner(read)(origin);
    expect(result.status).toBe("partial");
    expect(result.pages[0].headings).toContainEqual({ level: 1, text: "Large storefront" });
    expect(result.pages[0].text).toHaveLength(12000);
    expect(result.pages[0].warnings.join(" ")).toContain("truncated");
    expect(read.mock.calls.find(([url]) => url.pathname === "/robots.txt")?.[2]).toBe(256 * 1024);
  });

  it.each([
    ["http://127.0.0.1/secret", "Private"],
    ["http://169.254.169.254/latest/meta-data", "Private"],
    ["https://outside.example.com/", "Cross-domain"],
    ["http://shop.example.com/plain", "HTTPS-to-HTTP"],
    ["https://shop.example.com/login", "Login"],
  ])("blocks unsafe redirect %s", async (location, message) => {
    const read = transport({ "/": { status: 302, headers: { location }, body: "" } });
    const result = await createWebsiteScanner(read)(origin);
    expect(result.status).toBe("failed");
    expect(result.failures[0].message).toContain(message);
    expect(read.mock.calls).toHaveLength(2);
  });

  it("checks robots for redirected origins, follows safe redirects and captures the final URL", async () => {
    const read = transport({
      "/": { status: 301, headers: { location: "/shop" }, body: "" },
      "/shop": html('<h1>Shop</h1><a href="contact">Contact</a>'),
      "/contact": html("<h1>Contact</h1>"),
    });
    const result = await createWebsiteScanner(read)(origin);
    expect(result.pages[0].url).toBe(`${origin}/shop`);
    expect(result.pages[1].url).toBe(`${origin}/contact`);
    expect(read.mock.calls.filter(([url]) => url.pathname === "/robots.txt")).toHaveLength(1);
  });

  it("stops redirect loops, refuses inaccessible pages, and does not invent content", async () => {
    const read = transport({ "/": { status: 302, headers: { location: "/" }, body: "" } });
    const loop = await createWebsiteScanner(read)(origin);
    expect(loop.status).toBe("failed");
    expect(loop.failures[0].message).toContain("three-redirect");
    const blocked = await createWebsiteScanner(transport({ "/": { status: 403, headers: {}, body: "Protected" } }))(origin);
    expect(blocked.pages).toEqual([]);
    expect(blocked.failures[0].message).toContain("No login or access-control bypass");
    const login = await createWebsiteScanner(transport({ "/": html('<form><input type="password"></form>') }))(origin);
    expect(login.status).toBe("failed");
    expect(login.failures[0].message).toContain("password form");
    const challenge = await createWebsiteScanner(transport({ "/": html('<form id="challenge-form">Verify your browser</form>') }))(origin);
    expect(challenge.status).toBe("failed");
    expect(challenge.failures[0].message).toContain("No bypass");
  });

  it("respects page-level robots directives and reports static/JS and truncation limits", async () => {
    const nofollow = await createWebsiteScanner(transport({ "/": html('<meta name="robots" content="nofollow"><a href="/next">Next</a>') }))(origin);
    expect(nofollow.pages[0].links).toEqual([]);
    expect(nofollow.pages[0].warnings.join(" ")).toContain("JavaScript");
    const noarchive = await createWebsiteScanner(transport({ "/": html('<meta name="robots" content="noarchive"><h1>Do not retain</h1>') }))(origin);
    expect(noarchive.pages).toEqual([]);
    const noindex = await createWebsiteScanner(transport({ "/": html('<meta name="robots" content="noindex"><h1>No search indexing</h1>') }))(origin);
    expect(noindex.pages[0].warnings.join(" ")).toContain("no search indexing");
    const long = await createWebsiteScanner(transport({ "/": html(`<p>${"word ".repeat(4000)}</p>`) }))(origin);
    expect(long.pages[0].text).toHaveLength(12000);
    expect(long.pages[0].warnings.join(" ")).toContain("truncated");
  });

  it("fails closed when robots cannot be checked and honors publisher crawl delays", async () => {
    const read = vi.fn(async () => ({ status: 503, headers: {}, body: "" }));
    const unavailable = await createWebsiteScanner(read)(origin);
    expect(unavailable.status).toBe("failed");
    expect(unavailable.failures[0].message).toContain("Could not check robots");
    expect(read).toHaveBeenCalledTimes(1);
    const slow = transport({ "/": html("Never requested") }, "User-agent: *\nCrawl-delay: 60");
    const delayed = await createWebsiteScanner(slow)(origin);
    expect(delayed.status).toBe("failed");
    expect(delayed.failures[0].message).toContain("crawl delay");
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("reports bounded transport errors and rejects unsupported content instead of silently parsing it", async () => {
    const read = transport({ "/": { status: 200, headers: { "content-type": "application/json" }, body: "{}" } });
    expect((await createWebsiteScanner(read)(origin)).failures[0].message).toContain("HTML");
    const failed = vi.fn(async () => { throw new ScanError("Response exceeds the byte limit."); });
    const result = await createWebsiteScanner(failed)(origin);
    expect(result.status).toBe("failed");
    expect(result.failures[0].message).toContain("byte limit");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await createWebsiteScanner(read)(origin, controller.signal);
    expect(cancelled.status).toBe("failed");
    expect(cancelled.failures[0].message).toContain("cancelled");
  });

  it("counts sitemaps, robots and redirects in the shared request budget", async () => {
    const routes: Record<string, PublicResponse> = {
      "/robots.txt": { status: 302, headers: { location: "/robots-one" }, body: "" },
      "/robots-one": { status: 302, headers: { location: "/robots-two" }, body: "" },
      "/robots-two": { status: 302, headers: { location: "/robots-three" }, body: "" },
      "/robots-three": { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /" },
    };
    for (let index = 0; index < 14; index++) {
      routes[index ? `/start${index}` : "/"] = { status: 302, headers: { location: `/hop${index}a` }, body: "" };
      routes[`/hop${index}a`] = { status: 302, headers: { location: `/hop${index}b` }, body: "" };
      routes[`/hop${index}b`] = { status: 302, headers: { location: `/page${index}` }, body: "" };
      routes[`/page${index}`] = html(`<h1>Page ${index}</h1><a href="/start${index + 1}">Next</a>`);
    }
    const read = vi.fn(async (url: URL) => routes[url.pathname] ?? { status: 404, headers: {}, body: "" });
    const scan = await createWebsiteScanner(read)(origin);
    expect(read).toHaveBeenCalledTimes(scanLimits.requests);
    expect(scan.status).toBe("partial");
    expect(scan.pages.length).toBeLessThan(scanLimits.pages);
    expect(scan.failures[0].message).toContain("50-request budget");
  }, 15_000);

  it("applies the overall scan deadline even while waiting for robots", async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(15));
    const read = vi.fn(async (_url: URL, signal: AbortSignal) => new Promise<PublicResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    try {
      const scan = await createWebsiteScanner(read)(origin);
      expect(scan.status).toBe("failed");
      expect(scan.failures[0].message).toContain("timed out");
      expect(timeout).toHaveBeenCalledWith(scanLimits.milliseconds);
      expect(read).toHaveBeenCalledOnce();
    } finally { timeout.mockRestore(); }
  });

  it("discovers hidden product pages through published, bounded sitemap indexes and balances business coverage", async () => {
    const xml = (body: string): PublicResponse => ({ status: 200, headers: { "content-type": "application/xml" }, body });
    const read = transport({
      "/": html('<h1>Shop</h1><a href="/about">About</a><a href="/collections/all">Shop collection</a>'),
      "/about": html("<p>Our brand uses natural fabrics for everyday clothing.</p>"),
      "/collections/all": html("<h1>The collection</h1>"),
      "/sitemap.xml": xml(`<sitemapindex><sitemap><loc>${origin}/sitemap_products_1.xml?from=1&amp;to=10</loc></sitemap>
        <sitemap><loc>http://127.0.0.1/sitemap.xml</loc></sitemap></sitemapindex>`),
      "/sitemap_products_1.xml": xml(`<urlset><url><loc>${origin}/products/linen-shirt</loc></url>
        <url><loc>${origin}/account</loc></url><url><loc>https://outside.example.com/products/private</loc></url></urlset>`),
      "/products/linen-shirt": html('<h1>Linen Shirt</h1><script type="application/ld+json">{"@type":"Product","name":"Linen Shirt","sku":"LINEN-1","offers":{"price":"1299","priceCurrency":"INR"}}</script>'),
    }, `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml`);
    const scan = await createWebsiteScanner(read)(origin);
    expect(scan.pages.map((page) => page.url)).toEqual(expect.arrayContaining([`${origin}/about`, `${origin}/collections/all`, `${origin}/products/linen-shirt`]));
    expect(scan.pages.find((page) => page.url.endsWith("/linen-shirt"))?.productJson?.[0]).toContain("1299");
    expect(scan.coverage).toMatchObject({ sitemapsRead: 2, productRecords: 1 });
    expect(read.mock.calls.every(([url]) => url.hostname === "shop.example.com" && url.pathname !== "/account")).toBe(true);
    expect(read.mock.calls.find(([url]) => url.pathname === "/sitemap_products_1.xml")?.[0].search).toBe("?from=1&to=10");
  });

  it("honors sitemap robots/retention restrictions and page nofollow instead of using discovery to bypass them", async () => {
    const xml = { status: 200, headers: { "content-type": "application/xml", "x-robots-tag": "noarchive" }, body: `<urlset><url><loc>${origin}/products/hidden</loc></url></urlset>` };
    for (const robots of ["User-agent: *\nDisallow: /sitemap.xml", "User-agent: *\nAllow: /"]) {
      const read = transport({ "/": html("<h1>Shop</h1>"), "/sitemap.xml": xml }, robots);
      const scan = await createWebsiteScanner(read)(origin);
      expect(scan.coverage?.limited).toBe(true);
      expect(scan.notes.join(" ")).toContain("Sitemap discovery incomplete");
      expect(read.mock.calls.some(([url]) => url.pathname === "/products/hidden")).toBe(false);
    }
    const read = transport({ "/": html('<meta name="robots" content="nofollow"><h1>Do not follow</h1>'), "/sitemap.xml": xml });
    await createWebsiteScanner(read)(origin);
    expect(read.mock.calls.some(([url]) => url.pathname === "/sitemap.xml")).toBe(false);
  });

  it("captures published metadata from streaming placeholders without executing scripts or treating hidden body text as visible", async () => {
    const read = transport({ "/": { ...html(""), body: `<html><body><h1>Loading product</h1><div hidden>
      <meta name="description" content="Crafted from Stainless Steel with an 18k Gold Tone finish. SKU: NK2461">
      <p>Hidden body claims are not rendered evidence.</p></div><script>throw new Error("Never execute this")</script></body></html>`,
    } });
    const scan = await createWebsiteScanner(read)(origin);
    expect(scan.pages[0].description).toBe("Crafted from Stainless Steel with an 18k Gold Tone finish. SKU: NK2461");
    expect(scan.pages[0].text).toBe("Loading product");
    expect(scan.pages[0].productJson).toEqual([]);
  });

  it("uses Open Graph metadata when standard titles and descriptions are unavailable", async () => {
    const read = transport({ "/": { ...html(""),
      body: '<html><body><div hidden><meta property="og:title" content="Linen range"><meta name="og:description" content="Publisher description of linen clothing."></div></body></html>',
    } });
    const scan = await createWebsiteScanner(read)(origin);
    expect(scan.pages[0]).toMatchObject({ title: "Linen range", description: "Publisher description of linen clothing." });
  });

  it("bounds sitemap files and distinct discovered pages before capture", async () => {
    const xml = (body: string): PublicResponse => ({ status: 200, headers: { "content-type": "application/xml" }, body });
    const read = vi.fn(async (url: URL): Promise<PublicResponse> => {
      if (url.pathname === "/robots.txt") return { status: 404, headers: {}, body: "" };
      if (url.pathname === "/sitemap.xml") return xml(`<sitemapindex>${Array.from({ length: 10 }, (_, index) =>
        `<sitemap><loc>${origin}/sitemap_products_${index}.xml</loc></sitemap>`).join("")}</sitemapindex>`);
      if (url.pathname.endsWith(".xml")) return xml(`<urlset>${Array.from({ length: 200 }, (_, index) =>
        `<url><loc>${origin}/products/${url.pathname.slice(1, -4)}-${index}</loc></url>`).join("")}</urlset>`);
      return html("<h1>Public product</h1>");
    });
    const scan = await createWebsiteScanner(read)(origin);
    expect(scan.coverage).toMatchObject({ sitemapsRead: scanLimits.sitemaps, discoveredPages: scanLimits.discoveredUrls, limited: true });
    expect(read.mock.calls.filter(([url]) => url.pathname.endsWith(".xml"))).toHaveLength(scanLimits.sitemaps);
    expect(scan.pages).toHaveLength(scanLimits.pages);
  }, 10_000);

  it.each([
    { name: "XML entities", response: { status: 200, headers: { "content-type": "application/xml" }, body: '<!DOCTYPE urlset [<!ENTITY x SYSTEM "http://127.0.0.1/private">]><urlset>&x;</urlset>' } },
    { name: "HTTPS downgrades", response: { status: 302, headers: { location: "http://shop.example.com/sitemap_products.xml" }, body: "" } },
  ])("rejects sitemap $name without making the unsafe request", async ({ response }) => {
    const read = transport({ "/": html("<h1>Public shop</h1>"), "/sitemap.xml": response });
    const scan = await createWebsiteScanner(read)(origin);
    expect(scan.coverage?.limited).toBe(true);
    expect(scan.notes.join(" ")).toContain("Sitemap discovery incomplete");
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.every(([url]) => url.protocol === "https:" && url.hostname === "shop.example.com")).toBe(true);
  });

  it("retains a bounded scan for large catalogues and reports discarded product evidence explicitly", async () => {
    const products = Array.from({ length: 50 }, (_, index) => ({ "@type": "Product", name: `Fixture ${index}`, sku: `SKU-${index}`, description: "x".repeat(3000) }));
    const body = `<h1>Collection</h1><script type="application/ld+json">${JSON.stringify(products)}</script>${Array.from({ length: 25 }, (_, index) => `<a href="/products/item-${index}">Item ${index}</a>`).join("")}`;
    const read = transport(Object.fromEntries([["/", html(body)], ...Array.from({ length: 25 }, (_, index) => [`/products/item-${index}`, html(body)])]));
    const scan = await createWebsiteScanner(read)(origin);
    expect(scan.status).toBe("partial");
    expect(scan.pages.length).toBeLessThan(scanLimits.pages);
    expect(scan.notes.join(" ")).toContain("retained-evidence budget");
    expect(scan.pages[0].warnings.join(" ")).toContain("retention budget");
    expect(Buffer.byteLength(JSON.stringify(scan))).toBeLessThan(2 * 1024 * 1024);
    expect(scan.coverage?.limited).toBe(true);
  }, 10_000);

  it("charges failed response reads against the aggregate body budget", async () => {
    const root = html(`<h1>Shop</h1>${Array.from({ length: 10 }, (_, index) => `<a href="/products/item-${index}">Item ${index}</a>`).join("")}`);
    const read = vi.fn(async (url: URL, _signal: AbortSignal, maxBytes: number): Promise<PublicResponse> => {
      if (url.pathname === "/robots.txt") return { status: 404, headers: {}, body: "" };
      if (url.pathname === "/sitemap.xml") return { status: 404, headers: {}, body: "" };
      if (url.pathname === "/") return root;
      throw new ScanError("Fixture response was not valid UTF-8.", maxBytes);
    });
    const scan = await createWebsiteScanner(read)(origin);
    expect(scan.coverage?.bytesRead).toBe(scanLimits.totalBytes);
    expect(scan.coverage?.attemptedPages).toBe(6);
    expect(scan.status).toBe("partial");
    expect(read).toHaveBeenCalledTimes(8);
  });
});
