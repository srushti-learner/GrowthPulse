import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export class ScanError extends Error {
  constructor(message: string, public readonly receivedBytes = 0) { super(message); }
}
export const scannerAgent = "GrowthPulseBot";
const userAgent = `${scannerAgent}/0.1 (read-only website review)`;
const unsafePath = /(?:^|\/)(?:admin|wp-admin|login|log-in|signin|sign-in|signup|sign-up|logout|log-out|signout|account|auth|oauth|checkout|cart)(?:\/|$)/i;

export function publicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new ScanError("Enter a full public HTTP or HTTPS website URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port || url.search || url.href.length > 2048) {
    throw new ScanError("Use HTTP(S) on its default port, without credentials or query parameters.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname.endsWith(".") || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/i.test(hostname) || !hostname.includes(".") && !isIP(hostname)) {
    throw new ScanError("Local, internal, and reserved hostnames cannot be scanned.");
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new ScanError("Private, local, and reserved addresses cannot be scanned.");
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { throw new ScanError("The page path contains invalid URL encoding."); }
  if (unsafePath.test(pathname) || /[\\\u0000-\u001f]/.test(pathname)) {
    throw new ScanError("Login, account, administration, cart, and checkout pages are not supported.");
  }
  url.hash = "";
  return url;
}

export function publicSitemapUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new ScanError("Invalid public sitemap URL."); }
  const query = url.search;
  if (url.href.length > 2048) throw new ScanError("Sitemap URLs must not exceed 2048 characters.");
  if (query && (!/\/sitemap[\w-]*\.xml$/i.test(url.pathname)
    || [...url.searchParams].length > 2
    || new Set(url.searchParams.keys()).size !== [...url.searchParams].length
    || [...url.searchParams].some(([key, value]) => !["from", "to"].includes(key) || !/^\d{1,20}$/.test(value)))) {
    throw new ScanError("Only numeric from/to pagination is supported for published sitemap XML.");
  }
  url.search = "";
  const safe = publicUrl(url.href);
  safe.search = query;
  return safe;
}

export function isPublicAddress(address: string) {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  if (parsed.range() !== "unicast") return false;
  if (parsed.kind() === "ipv4") {
    // Azure's platform virtual address is not classified as private by IP libraries.
    return parsed.toString() !== "168.63.129.16";
  }
  return parsed.match(ipaddr.parse("2000::"), 3);
}

export type PublicResponse = { status: number; headers: IncomingHttpHeaders; body: string; receivedBytes?: number };
export type PublicReader = (url: URL, signal: AbortSignal, maxBytes: number, kind?: "sitemap") => Promise<PublicResponse>;
type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export function createPublicReader(resolve: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true })): PublicReader {
  return async (input, cancellation, maxBytes, kind) => {
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(5000)]);
    const url = kind === "sitemap" ? publicSitemapUrl(input.href) : publicUrl(input.href);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    signal.throwIfAborted();
    const resolution = isIP(hostname)
      ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
      : resolve(hostname);
    let addresses: { address: string; family: number }[];
    try {
      addresses = await new Promise((accept, reject) => {
        const abort = () => reject(new ScanError("The scan timed out or was cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        void resolution.then(accept, () => reject(new ScanError("Public DNS lookup failed.")))
          .finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
    } catch (error) {
      if (error instanceof ScanError) throw error;
      throw new ScanError("Public DNS lookup failed.");
    }
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address, family }) => ![4, 6].includes(family) || isIP(address) !== family || !isPublicAddress(address))) {
      throw new ScanError("The destination resolves to a private, local, or reserved address.");
    }
    const pinned = addresses.find(({ family }) => family === 4) ?? addresses[0];
    return new Promise<PublicResponse>((accept, reject) => {
      let bytes = 0;
      const failure = (message: string) => new ScanError(message, Math.min(bytes, maxBytes));
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: "GET", agent: false, signal, family: pinned.family,
        // Pin the validated answer to this connection, retaining the hostname for TLS and Host.
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
        headers: { "User-Agent": userAgent, Accept: "text/html, application/xhtml+xml, application/xml, text/xml, text/plain;q=0.8", "Accept-Encoding": "identity" },
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          accept({ status, headers: response.headers, body: "" });
          response.destroy();
          return;
        }
        if (response.headers["content-encoding"] && response.headers["content-encoding"].toLowerCase() !== "identity") {
          request.destroy(new ScanError("Compressed responses are not supported by this bounded scanner."));
          return;
        }
        const length = response.headers["content-length"];
        if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
          request.destroy(new ScanError(`Response exceeds the ${maxBytes}-byte limit.`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) { request.destroy(failure(`Response exceeds the ${maxBytes}-byte limit.`)); return; }
          chunks.push(chunk);
        });
        response.on("error", () => reject(failure("The website response was interrupted.")));
        response.on("end", () => {
          try { accept({ status, headers: response.headers, body: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), receivedBytes: bytes }); }
          catch { reject(failure("This page is not valid UTF-8. Other encodings are not supported yet.")); }
        });
      });
      request.setTimeout(5000, () => request.destroy(failure("The website request timed out.")));
      request.on("error", (error) => reject(error instanceof ScanError ? error : failure(signal.aborted
        ? "The scan timed out or was cancelled." : "Unable to fetch the public website: connection or TLS failure.")));
      request.end();
    });
  };
}
