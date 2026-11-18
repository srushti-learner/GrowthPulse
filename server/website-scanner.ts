import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { setTimeout as delay } from "node:timers/promises";
import { scanLimits, scanResultSchema, type ScannedPage, type ScanResult } from "../shared/website.js";
import { createPublicReader, publicSitemapUrl, publicUrl, ScanError, scannerAgent, type PublicReader, type PublicResponse } from "./public-http.js";

const space = (value: string, limit: number) => value.replace(/\s+/g, " ").trim().slice(0, limit);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const excludedFile = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|mp[34]|mov|zip|gz|css|js|json|xml|txt|woff2?|ttf|csv)$/i;
const pageKind = (url: string) => {
  const path = new URL(url).pathname;
  if (/\/(?:products?|p|item)\/[^/]+/i.test(path)) return "product";
  if (/\/(?:collections?|categor(?:y|ies)|shop)(?:\/|$)/i.test(path)) return "collection";
  if (/(?:about|contact|shipping|delivery|returns?|refund|size|faq)/i.test(path)) return "business";
  return "other";
};

function extract(html: string, url: URL, headerRobots: string): { page: ScannedPage; followLinks: boolean } {
  const $ = cheerio.load(html);
  const directives = `${headerRobots},${$('meta[name="robots" i], meta[name="growthpulsebot" i]').map((_index, item) => $(item).attr("content") ?? "").get().join(",")}`;
  if (/\b(?:nosnippet|noarchive|nocache)\b/i.test(directives)) {
    throw new ScanError("The publisher's robots directives prohibit retaining this page's content.");
  }
  if ($('input[type="password" i]').length) throw new ScanError("This page contains a login/password form. Use public informational pages instead.");
  if ($("#challenge-form, #cf-challenge-running, .cf-browser-verification").length) throw new ScanError("This page is a bot-verification challenge. No bypass was attempted.");
  const warnings: string[] = [];
  const productJson: string[] = [];
  let productBytes = 0;
  if ($('script[type="application/ld+json" i]').length > 20) warnings.push("Structured-data inspection was limited to the first 20 JSON-LD blocks.");
  $('script[type="application/ld+json" i]').slice(0, 20).each((_index, script) => {
    let value: unknown;
    try { value = JSON.parse($(script).text()); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; warnings.push("A JSON-LD block was malformed and could not supply product evidence."); return; }
    const queue: unknown[] = [value];
    let inspected = 0;
    while (queue.length && inspected++ < 1000 && productJson.length < 50) {
      const item = queue.shift();
      if (Array.isArray(item)) { queue.push(...item.slice(0, Math.max(0, 1000 - queue.length))); continue; }
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
      if (types.some((type) => typeof type === "string" && /^(?:https?:\/\/schema\.org\/)?Product$/.test(type))) {
        let json: string;
        try { json = JSON.stringify(record); }
        catch (error) {
          if (!(error instanceof RangeError)) throw error;
          warnings.push("A Product JSON-LD record was nested too deeply and was not retained.");
          continue;
        }
        if (json.length <= 20_000 && productBytes + Buffer.byteLength(json) <= scanLimits.productBytesPerPage) {
          productJson.push(json); productBytes += Buffer.byteLength(json);
        }
        else if (json.length <= 20_000) warnings.push("Structured product evidence reached this page's retention budget; some records were not retained.");
        else warnings.push("A Product JSON-LD record exceeded 20,000 characters and was not retained.");
      }
      for (const child of Object.values(record)) if (child && typeof child === "object" && queue.length < 1000) queue.push(child);
    }
    if (queue.length) warnings.push("Product JSON-LD inspection reached its safety limit; some products may be missing.");
  });
  if (productJson.length) warnings.push(`${productJson.length} structured product records captured. Valid, unambiguous records are added to Products when this scan is saved to a business.`);
  if (/\b(?:noindex|none)\b/i.test(directives)) warnings.push("The publisher requests no search indexing. GrowthPulse does not publish these results as a search index.");
  const links = new Set<string>();
  const contacts = new Set<string>();
  if ($("a[href]").length > 500) warnings.push("Navigation inspection was limited to the first 500 links.");
  $("a[href]").slice(0, 500).each((_index, item) => {
    const href = $(item).attr("href")?.trim() ?? "";
    if (/^(?:mailto|tel):/i.test(href)) { contacts.add(space(href, 300)); return; }
    if (/\bnofollow\b/i.test($(item).attr("rel") ?? "")) return;
    let link: URL;
    try { link = new URL(href, url); } catch { return; }
    if (link.hostname !== url.hostname || link.search || excludedFile.test(link.pathname)) return;
    try { links.add(publicUrl(link.href).href); }
    catch (error) { if (!(error instanceof ScanError)) throw error; }
  });
  const callsToAction = [...new Set($("a, button").slice(0, 500).map((_index, item) => space($(item).text(), 120)).get().filter((text) => /\b(?:shop|buy|contact|book|learn|explore|get started|call|message)\b/i.test(text)))].slice(0, 20);
  // Streamed server-rendered metadata can sit in hidden placeholders before hydration.
  const title = space($("title").first().text() || $('meta[property="og:title" i], meta[name="og:title" i]').first().attr("content") || "", 300);
  const description = space($('meta[name="description" i]').first().attr("content")
    ?? $('meta[property="og:description" i], meta[name="og:description" i]').first().attr("content") ?? "", 2000);
  $("script, style, template, noscript, iframe, svg, [hidden], [aria-hidden=true]").remove();
  $("br").replaceWith(" ");
  $("p, div, h1, h2, h3, li, section, article, main, td").append(" ");
  const headings = $("h1, h2, h3").slice(0, 30).map((_index, item) => ({
    level: Number(item.tagName.slice(1)), text: space($(item).text(), 240),
  })).get();
  const fullText = space($("body").text(), 12001);
  if (fullText.length > 12000) warnings.push("Page text was truncated to 12,000 characters.");
  if (fullText.length < 80) warnings.push("Little static text was found. JavaScript rendering or a login may be required; this scanner cannot verify that.");
  if (/\b(?:nofollow|none)\b/i.test(directives)) warnings.push("Publisher requests no link following; no links were crawled from this page.");
  if (links.size > 100) warnings.push("Navigation discovery was limited to 100 safe links from this page.");
  return { followLinks: !/\b(?:nofollow|none)\b/i.test(directives), page: {
    url: url.href, capturedAt: new Date().toISOString(),
    title, description,
    headings, text: fullText.slice(0, 12000), contacts: [...contacts].slice(0, 20), callsToAction,
    links: /\b(?:nofollow|none)\b/i.test(directives) ? [] : [...links].slice(0, 100), warnings: [...new Set(warnings)].slice(0, 10), productJson,
  } };
}

export function createWebsiteScanner(read: PublicReader = createPublicReader()) {
  return async (input: string, cancellation?: AbortSignal, options: { singlePage?: boolean } = {}): Promise<ScanResult> => {
    const seed = publicUrl(input);
    const startedAt = new Date().toISOString();
    const signal = cancellation ? AbortSignal.any([cancellation, AbortSignal.timeout(scanLimits.milliseconds)]) : AbortSignal.timeout(scanLimits.milliseconds);
    const host = seed.hostname.replace(/^www\./, "");
    const pages: ScannedPage[] = [];
    const failures: ScanResult["failures"] = [];
    const notes = new Set<string>(["Static public HTML only: no JavaScript execution, authentication, or website changes."]);
    const robots = new Map<string, Promise<ReturnType<typeof robotsParser>>>();
    const lastRequest = new Map<string, number>();
    const visited = new Set<string>();
    const discovered = new Set<string>([seed.href]);
    const queue = [seed.href];
    const sitemapQueue: string[] = [];
    const sitemapSeen = new Set<string>();
    let requests = 0;
    let bytesRead = 0;
    let retainedBytes = 0;
    let sitemapsRead = 0;
    let limited = false;

    function destination(input: string, sitemap = false) {
      const url = sitemap ? publicSitemapUrl(input) : publicUrl(input);
      if (url.hostname.replace(/^www\./, "") !== host) throw new ScanError("Cross-domain links and redirects are not scanned.");
      if (seed.protocol === "https:" && url.protocol !== "https:") throw new ScanError("HTTPS-to-HTTP links are not scanned.");
      return url;
    }
    function enqueue(input: string, sitemap = false) {
      let url: URL;
      try { url = destination(input, sitemap); }
      catch (error) {
        if (!(error instanceof ScanError)) throw error;
        if (sitemap) notes.add("Some sitemap destinations were excluded by the public-URL safety rules.");
        return;
      }
      if (sitemap) {
        if (!sitemapSeen.has(url.href) && !sitemapQueue.includes(url.href)) {
          if (sitemapQueue.length + sitemapSeen.size < scanLimits.sitemaps) sitemapQueue.push(url.href);
          else { limited = true; notes.add("Sitemap discovery was sampled within its four-file limit."); }
        }
      } else if (!discovered.has(url.href)) {
        if (discovered.size >= scanLimits.discoveredUrls) { limited = true; return; }
        discovered.add(url.href); queue.push(url.href);
      }
    }
    async function rulesFor(url: URL) {
      let policy = robots.get(url.origin);
      if (!policy) {
        policy = (async () => {
          const result = await follow(new URL("/robots.txt", url), "robots");
          if ([404, 410].includes(result.response.status)) {
            notes.add("A robots.txt file was not published for at least one scanned origin.");
            return robotsParser(new URL("/robots.txt", url).href, "");
          }
          if (result.response.status !== 200) throw new ScanError(`Could not check robots.txt (HTTP ${result.response.status}); scanning stopped for this origin.`);
          const type = result.response.headers["content-type"] ?? "";
          if (!/^text\/plain(?:;|$)/i.test(type)) throw new ScanError("robots.txt did not return plain text; scanning stopped for this origin.");
          for (const match of result.response.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)) enqueue(match[1], true);
          return robotsParser(new URL("/robots.txt", url).href, result.response.body);
        })();
        robots.set(url.origin, policy);
      }
      return policy;
    }
    async function follow(initial: URL, kind: "html" | "robots" | "sitemap"): Promise<{ url: URL; response: PublicResponse }> {
      let url = initial;
      for (let redirects = 0; redirects <= 3; redirects++) {
        signal.throwIfAborted();
        url = destination(url.href, kind === "sitemap");
        if (kind !== "robots") {
          const policy = await rulesFor(url);
          if (policy.isAllowed(url.href, scannerAgent) === false) throw new ScanError("robots.txt does not allow GrowthPulseBot to read this page.");
          const wait = Math.max(200, (policy.getCrawlDelay(scannerAgent) ?? 0) * 1000) - (Date.now() - (lastRequest.get(url.origin) ?? 0));
          if (!Number.isFinite(wait) || wait > scanLimits.milliseconds - (Date.now() - Date.parse(startedAt))) {
            throw new ScanError("The publisher's crawl delay exceeds this scan's remaining time budget.");
          }
          if (wait > 0) await delay(wait, undefined, { signal });
        }
        if (requests >= scanLimits.requests) throw new ScanError(`The scan's ${scanLimits.requests}-request budget was reached, including redirects, sitemaps and robots checks.`);
        if (bytesRead >= scanLimits.totalBytes) throw new ScanError("The scan's total download budget was reached.");
        requests++;
        lastRequest.set(url.origin, Date.now());
        const maxBytes = Math.min(kind === "html" ? scanLimits.pageBytes : kind === "sitemap" ? scanLimits.sitemapBytes : 262_144, scanLimits.totalBytes - bytesRead);
        let response: PublicResponse;
        try { response = kind === "sitemap" ? await read(url, signal, maxBytes, "sitemap") : await read(url, signal, maxBytes); }
        catch (error) {
          if (error instanceof ScanError) bytesRead += error.receivedBytes;
          throw error;
        }
        bytesRead += response.receivedBytes ?? Buffer.byteLength(response.body);
        signal.throwIfAborted();
        if (!redirectStatuses.has(response.status)) return { url, response };
        if (redirects === 3) throw new ScanError("The page exceeded the three-redirect limit.");
        const location = response.headers.location;
        if (!location) throw new ScanError("The website sent a redirect without a destination.");
        let next: URL;
        try { next = destination(new URL(location, url).href, kind === "sitemap"); }
        catch (error) {
          if (error instanceof ScanError) throw error;
          throw new ScanError("The website sent an invalid redirect destination.");
        }
        if (url.protocol === "https:" && next.protocol !== "https:") throw new ScanError("HTTPS-to-HTTP redirects are not allowed.");
        url = next;
      }
      throw new ScanError("Redirect limit reached.");
    }

    async function discoverSitemaps() {
      if (!sitemapQueue.length) enqueue(new URL("/sitemap.xml", seed).href, true);
      while (sitemapQueue.length && sitemapSeen.size < scanLimits.sitemaps) {
        const current = sitemapQueue.shift()!;
        sitemapSeen.add(current);
        try {
          const { response } = await follow(destination(current, true), "sitemap");
          if ([404, 410].includes(response.status)) continue;
          if (response.status !== 200 || !/^(?:application\/xml|text\/xml)(?:;|$)/i.test(response.headers["content-type"] ?? "")) {
            throw new ScanError("The published sitemap did not return readable XML.");
          }
          if (/<!DOCTYPE|<!ENTITY/i.test(response.body)) throw new ScanError("Sitemap entity declarations are not supported.");
          if (/\b(?:nosnippet|noarchive|nocache|nofollow|none)\b/i.test(String(response.headers["x-robots-tag"] ?? ""))) {
            throw new ScanError("The publisher's sitemap retention/following directives prohibit discovery.");
          }
          const $ = cheerio.load(response.body, { xmlMode: true });
          const index = $("sitemapindex").length > 0;
          if (!index && !$("urlset").length) throw new ScanError("The sitemap XML has no supported sitemapindex or urlset.");
          sitemapsRead++;
          const locations = $(index ? "sitemap > loc" : "url > loc").map((_i, item) => $(item).text().trim()).get();
          if (locations.length > scanLimits.discoveredUrls) limited = true;
          locations.sort((a, b) => Number(!/product/i.test(a)) - Number(!/product/i.test(b)));
          for (const location of locations.slice(0, scanLimits.discoveredUrls)) enqueue(location, index);
        } catch (error) {
          if (!(error instanceof ScanError) && !(error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) throw error;
          limited = true;
          notes.add(`Sitemap discovery incomplete: ${error instanceof ScanError ? error.message : "The scan timed out or was cancelled."}`);
          if (signal.aborted || requests >= scanLimits.requests || bytesRead >= scanLimits.totalBytes) break;
        }
      }
    }

    while (queue.length && visited.size < scanLimits.pages) {
      const targets = { collection: 2, business: 4, product: 12, other: 2 };
      const kinds = (Object.keys(targets) as (keyof typeof targets)[]).filter((kind) => queue.some((url) => pageKind(url) === kind));
      const preferred = kinds.sort((a, b) => pages.filter((page) => pageKind(page.url) === a).length / targets[a]
        - pages.filter((page) => pageKind(page.url) === b).length / targets[b])[0];
      const rank = (url: string) => pageKind(url) === preferred ? -1 : ({ product: 0, collection: 1, business: 2, other: 3 })[pageKind(url)];
      queue.sort((a, b) => rank(a) - rank(b));
      const current = queue.shift()!;
      if (visited.has(current) || pages.some((page) => page.url === current)) continue;
      visited.add(current);
      try {
        const { url, response } = await follow(destination(current), "html");
        if (response.status !== 200) throw new ScanError([401, 403].includes(response.status)
          ? `This page is not publicly accessible (HTTP ${response.status}). No login or access-control bypass was attempted.`
          : `The website returned HTTP ${response.status}.`);
        const type = response.headers["content-type"] ?? "";
        if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type)) throw new ScanError("This URL did not return an HTML page.");
        const charset = type.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1].toLowerCase();
        if (charset && !["utf-8", "utf8", "us-ascii"].includes(charset)) throw new ScanError("Only UTF-8 or ASCII HTML is supported.");
        if (pages.some((page) => page.url === url.href)) continue;
        const { page, followLinks } = extract(response.body, url, String(response.headers["x-robots-tag"] ?? ""));
        const size = Buffer.byteLength(JSON.stringify(page));
        if (retainedBytes + size > scanLimits.retainedBytes) {
          limited = true; notes.add("The retained-evidence budget was reached; further pages were not stored."); break;
        }
        retainedBytes += size;
        pages.push(page);
        if (page.warnings.some((warning) => /truncated|not retained|safety limit|may be missing|limited to/i.test(warning))) limited = true;
        if (options.singlePage) {
          notes.add("Only the requested public page was sampled; no navigation or sitemap discovery was performed.");
          break;
        }
        for (const link of page.links) enqueue(link);
        if (pages.length === 1 && followLinks) {
          await discoverSitemaps();
          if (!queue.length && page.text.length < 80) notes.add("Little static content or navigation was available. JavaScript-rendered content remains unknown.");
        }
      } catch (error) {
        if (!(error instanceof ScanError) && !(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) throw error;
        failures.push({ url: current, message: error instanceof ScanError ? error.message : "The scan timed out or was cancelled." });
        if (!pages.length || signal.aborted || requests >= scanLimits.requests || bytesRead >= scanLimits.totalBytes) break;
      }
    }
    if (queue.length || sitemapQueue.length || signal.aborted || requests >= scanLimits.requests || bytesRead >= scanLimits.totalBytes) limited = true;
    if (limited) notes.add("Discovery or capture reached a safety/time/size limit. This is a sample, not the full website or catalogue.");
    notes.add(`Captured ${pages.length} pages and ${pages.reduce((count, page) => count + (page.productJson?.length ?? 0), 0)} structured product records. Missing products or private sales data were not inferred.`);
    if (seed.protocol === "http:") notes.add("The starting URL used unencrypted HTTP.");
    return scanResultSchema.parse({
      requestedUrl: seed.href, status: !pages.length ? "failed" : failures.length || limited ? "partial" : "complete",
      startedAt, completedAt: new Date().toISOString(), pages, failures, notes: [...notes].slice(0, 10),
      coverage: { attemptedPages: visited.size, discoveredPages: discovered.size, sitemapsRead, requests, bytesRead,
        productRecords: pages.reduce((count, page) => count + (page.productJson?.length ?? 0), 0), limited },
    });
  };
}
export type WebsiteScanner = ReturnType<typeof createWebsiteScanner>;
