import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createServerApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openStore, type Store } from "./database.js";

const stores: Store[] = [];
function createApp(options: Omit<Parameters<typeof createServerApp>[0], "store"> = {}) {
  const store = openStore(":memory:");
  stores.push(store);
  return createServerApp({ ...options, store });
}
afterAll(() => stores.forEach((store) => store.close()));

describe("API", () => {
  const app = createApp();

  it("reports health only after querying the local database", async () => {
    const response = await request(app).get("/api/health").expect(200);
    expect(response.body).toEqual({ status: "ok", service: "growthpulse-api", database: { engine: "sqlite", status: "ok" } });
  });

  it("returns JSON for unknown API routes", async () => {
    const response = await request(app).get("/api/missing").expect(404);
    expect(response.body.error).toBe("API endpoint not found");
  });

  it("rejects malformed JSON without exposing a stack trace", async () => {
    const response = await request(app).post("/api/missing").set("Content-Type", "application/json").send("{").expect(400);
    expect(response.body).toEqual({ error: "Invalid JSON request body" });
  });

  it("rejects oversized payloads explicitly", async () => {
    const response = await request(app).post("/api/missing").send({ text: "a".repeat(110_000) }).expect(413);
    expect(response.body.error).toBe("Request body is too large");
  });
});

describe("production frontend", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "growthpulse-web-"));
    writeFileSync(join(directory, "index.html"), "<html><body>GrowthPulse test shell</body></html>");
    writeFileSync(join(directory, "app.js"), "console.log('test asset');");
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("serves the application shell for browser navigation", async () => {
    const app = createApp({ production: true, clientDirectory: directory });
    const response = await request(app).get("/").set("Accept", "text/html").expect(200);
    expect(response.text).toContain("GrowthPulse test shell");
    await request(app).get("/dashboard").set("Accept", "text/html").expect(200);
  });

  it("serves assets but does not turn missing API or asset responses into HTML", async () => {
    const app = createApp({ production: true, clientDirectory: directory });
    await request(app).get("/app.js").expect(200).expect("Content-Type", /javascript/);
    await request(app).get("/assets/missing.js").expect(404).expect("Content-Type", /json/);
    await request(app).get("/api/missing").set("Accept", "text/html").expect(404).expect("Content-Type", /json/);
  });

  it("refuses to start production without a frontend build", () => {
    expect(() => createApp({ production: true, clientDirectory: join(directory, "missing") })).toThrow("Frontend build is missing");
  });
});

describe("environment configuration", () => {
  it("uses a supplied hosting port", () => {
    expect(loadConfig({ PORT: "8080", NODE_ENV: "production" })).toEqual({
      PORT: 8080, NODE_ENV: "production", APP_ORIGIN: "http://127.0.0.1:5173", SQLITE_PATH: "./data/growthpulse.sqlite", ANTHROPIC_MODEL: "claude-haiku-4-5",
    });
  });

  it.each(["", "0", "-1", "65536", "abc", "1.5"])("rejects invalid port %j", (PORT) => {
    expect(() => loadConfig({ PORT })).toThrow("Invalid environment configuration");
  });

  it("rejects an unsupported environment", () => {
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow("NODE_ENV");
  });

  it.each(["https://example.com/", "https://example.com/path", "file:///tmp/app"])("rejects an invalid application origin %s", (APP_ORIGIN) => {
    expect(() => loadConfig({ APP_ORIGIN })).toThrow("APP_ORIGIN");
  });
});
