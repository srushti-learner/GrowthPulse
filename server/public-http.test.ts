import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicReader, isPublicAddress, publicSitemapUrl, publicUrl } from "./public-http.js";
import { scanLimits } from "../shared/website.js";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("node:http", async (original) => ({ ...await original<typeof import("node:http")>(), request: requestMock }));
vi.mock("node:https", async (original) => ({ ...await original<typeof import("node:https")>(), request: requestMock }));

afterEach(() => vi.resetAllMocks());
const signal = () => new AbortController().signal;
function respond(chunks: Buffer[], headers: Record<string, string> = { "content-type": "text/html" }) {
  requestMock.mockImplementation((_url, _options, callback) => {
    const request = Object.assign(new EventEmitter(), {
      destroyed: false, setTimeout: vi.fn(), end: vi.fn(), destroy: vi.fn(),
    });
    request.destroy.mockImplementation((error: Error) => {
      request.destroyed = true;
      queueMicrotask(() => request.emit("error", error));
    });
    request.end.mockImplementation(() => queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: 200, headers, destroy: vi.fn() });
      callback(response);
      if (request.destroyed) return;
      for (const chunk of chunks) {
        response.emit("data", chunk);
        if (request.destroyed) return;
      }
      response.emit("end");
    }));
    return request;
  });
}

describe("public destination and connection boundary", () => {
  it("permits only numeric sitemap pagination through the sitemap-specific transport boundary", async () => {
    const url = "https://shop.example.com/sitemap_products_1.xml?from=1&to=500";
    expect(() => publicUrl(url)).toThrow();
    expect(publicSitemapUrl(url).search).toBe("?from=1&to=500");
    const read = createPublicReader(async () => [{ address: "93.184.215.14", family: 4 }]);
    await expect(read(new URL(url), signal(), 100)).rejects.toThrow("query parameters");
    respond([Buffer.from("<urlset/>")], { "content-type": "application/xml" });
    await expect(read(new URL(url), signal(), 100, "sitemap")).resolves.toMatchObject({ body: "<urlset/>" });
    for (const unsafe of [
      "https://shop.example.com/sitemap.xml?token=secret",
      "https://shop.example.com/sitemap.xml?from=1&from=2",
      "https://shop.example.com/sitemap.xml?from=https://other.example.com",
      "https://shop.example.com/products/item?from=1",
      "http://127.0.0.1/sitemap.xml?from=1",
      "https://user:password@shop.example.com/sitemap.xml?from=1",
      `https://shop.example.com/${"a".repeat(2000)}/sitemap.xml?from=12345678901234567890`,
    ]) expect(() => publicSitemapUrl(unsafe)).toThrow();
  });
  it.each([
    "http://localhost/", "https://app.local/", "https://intranet/", "http://127.1/",
    "http://2130706433/", "http://0x7f000001/", "http://10.2.3.4/", "http://169.254.169.254/",
    "http://100.100.100.200/", "http://168.63.129.16/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
    "http://[fd00:ec2::254]/", "https://public.example.com:8443/", "ftp://public.example.com/",
    "https://user:pass@public.example.com/", "https://public.example.com/?token=secret",
    "https://public.example.com/%6cogin", "https://public.example.com/a/../account",
  ])("rejects unsafe URL %s before any connection", (url) => {
    expect(() => publicUrl(url)).toThrow();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it.each(["0.0.0.0", "192.168.1.1", "172.16.0.1", "192.0.0.9", "192.0.2.1", "198.18.1.1", "224.1.1.1", "::", "2001:db8::1", "2002:7f00:1::", "64:ff9b::7f00:1"])("rejects non-public IP %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("pins a checked DNS answer to the socket lookup without forwarding credentials", async () => {
    respond([Buffer.from("<h1>Public</h1>")]);
    const resolver = vi.fn().mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const response = await createPublicReader(resolver)(new URL("https://shop.example.com/"), signal(), 100);
    expect(response.body).toContain("Public");
    expect(resolver).toHaveBeenCalledTimes(1);
    const [url, options] = requestMock.mock.calls[0];
    expect(url.hostname).toBe("shop.example.com");
    expect(options.agent).toBe(false);
    expect(options.family).toBe(4);
    const callback = vi.fn();
    options.lookup("shop.example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.215.14", 4);
    expect(options.headers).toEqual({ "User-Agent": expect.stringContaining("GrowthPulseBot"), Accept: expect.any(String), "Accept-Encoding": "identity" });
    expect(options.headers.Cookie).toBeUndefined();
    expect(options.headers.Authorization).toBeUndefined();
  });

  it("rejects mixed public/private DNS answers and rechecks every new connection", async () => {
    const resolver = vi.fn().mockResolvedValue([{ address: "93.184.215.14", family: 4 }, { address: "::1", family: 6 }]);
    await expect(createPublicReader(resolver)(new URL("https://shop.example.com"), signal(), 100)).rejects.toThrow("private");
    expect(requestMock).not.toHaveBeenCalled();
    respond([Buffer.from("safe")]);
    resolver.mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }]).mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    const read = createPublicReader(resolver);
    await read(new URL("https://shop.example.com/first"), signal(), 100);
    await expect(read(new URL("https://shop.example.com/redirected"), signal(), 100)).rejects.toThrow("private");
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("bounds streamed bytes even without Content-Length and rejects compression and invalid UTF-8", async () => {
    const read = createPublicReader(async () => [{ address: "93.184.215.14", family: 4 }]);
    respond([Buffer.alloc(10), Buffer.alloc(7)]);
    await expect(read(new URL("https://shop.example.com"), signal(), 16)).rejects.toMatchObject({ message: expect.stringContaining("16-byte"), receivedBytes: 16 });
    respond([], { "content-length": "17" });
    await expect(read(new URL("https://shop.example.com"), signal(), 16)).rejects.toThrow("16-byte");
    respond([Buffer.from("compressed")], { "content-encoding": "gzip" });
    await expect(read(new URL("https://shop.example.com"), signal(), 100)).rejects.toThrow("Compressed");
    respond([Buffer.from([0xc3, 0x28])]);
    await expect(read(new URL("https://shop.example.com"), signal(), 100)).rejects.toMatchObject({ message: expect.stringContaining("UTF-8"), receivedBytes: 2 });
  });

  it.each([true, false])("accepts HTML through 5 MiB and rejects larger responses (Content-Length: %s)", async (withLength) => {
    const read = createPublicReader(async () => [{ address: "93.184.215.14", family: 4 }]);
    const body = Buffer.alloc(5 * 1024 * 1024, " ");
    const ending = Buffer.from("<h1>Business details at the end of a large page</h1>");
    ending.copy(body, body.length - ending.length);
    const headers = { "content-type": "text/html", ...(withLength ? { "content-length": String(body.length) } : {}) };
    respond([body.subarray(0, 1024 * 1024), body.subarray(1024 * 1024)], headers);
    const result = await read(new URL("https://shop.example.com"), signal(), scanLimits.pageBytes);
    expect(Buffer.byteLength(result.body)).toBe(body.length);
    expect(result.body.endsWith(ending.toString())).toBe(true);

    respond([body, Buffer.from("x")], { ...headers, ...(withLength ? { "content-length": String(body.length + 1) } : {}) });
    await expect(read(new URL("https://shop.example.com"), signal(), scanLimits.pageBytes)).rejects.toThrow("5242880-byte limit");
    expect(requestMock.mock.results[1].value.destroy).toHaveBeenCalled();
  });

  it("cancels a pending DNS lookup without opening a connection", async () => {
    const controller = new AbortController();
    const read = createPublicReader(() => new Promise(() => {}));
    const result = read(new URL("https://shop.example.com"), controller.signal, 100);
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
    expect(requestMock).not.toHaveBeenCalled();
  });
});
