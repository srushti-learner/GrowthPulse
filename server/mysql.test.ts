import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import request from "supertest";
import { openMysqlStore } from "./mysql-store.js";
import { mysqlDatabase, type SqlDatabase } from "./sql-database.js";
import { SqlCheckpointSaver } from "./sql-checkpointer.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { newSession } from "./auth.js";
import { emptyProduct } from "../shared/products.js";
import type { Store } from "./database.js";
import { readSalesFile, salesFileHash } from "./sales-imports.js";
import { readTrafficFile } from "./traffic-imports.js";
import { importMarketplaceCsv } from "./marketplace-research.js";
import { productFingerprint } from "./product-intelligence.js";
import { createAnalysisWorker } from "./analysis-worker.js";
import { createBusinessAgent, type AgentMessage } from "./business-agent.js";
import { buildAgentEvidence } from "./agent-evidence.js";
import type { ResearchReport } from "../shared/research.js";
import { migrateMysql } from "./mysql-migrations.js";

const enabled = process.env.GP_TEST_MYSQL === "1";
const origin = "https://growth.example";
const website = "https://shop.example.com/";

describe("additive MySQL migration sequencing without a database connection", () => {
  async function fixture(run: (value: {
    pool: Pool; rows: { version: number; checksum: string; completed: number }[];
    query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>;
  }) => Promise<void>) {
    const rows: { version: number; checksum: string; completed: number }[] = [];
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }], []];
      if (sql.startsWith("SELECT version")) return [structuredClone(rows), []];
      if (sql.startsWith("INSERT INTO mysql_schema_migrations")) {
        rows.push({ version: Number(values[0]), checksum: String(values[1]), completed: 0 });
      }
      if (sql.startsWith("UPDATE mysql_schema_migrations")) rows.find((row) => row.version === values[0])!.completed = 1;
      return [[], []];
    });
    const release = vi.fn();
    const pool = createPool({});
    const connection = { query, release } as PoolConnection;
    const spy = vi.spyOn(pool, "getConnection").mockResolvedValue(connection);
    try { await run({ pool, rows, query, release }); }
    finally { spy.mockRestore(); await pool.end(); }
  }
  it("upgrades an existing v1 schema without replaying it, then treats the upgrade as already applied", async () => {
    await fixture(async ({ pool, rows, query }) => {
      await migrateMysql(pool, "fictional-test");
      const original = structuredClone(rows.find((row) => row.version === 1)!);
      rows.splice(1);
      query.mockClear();
      await migrateMysql(pool, "fictional-test");
      expect(rows.find((row) => row.version === 1)).toEqual(original);
      expect(query.mock.calls.filter(([sql]) => sql.startsWith("ALTER TABLE")).map(([sql]) => sql)).toEqual([
        "ALTER TABLE marketplace_research ADD COLUMN progress_json LONGTEXT CHECK(progress_json IS NULL OR JSON_VALID(progress_json))",
        "ALTER TABLE product_analyses ADD COLUMN progress_json LONGTEXT CHECK(progress_json IS NULL OR JSON_VALID(progress_json))",
        "ALTER TABLE analysis_jobs ADD COLUMN reuse_customer_evidence INTEGER NOT NULL DEFAULT 0 CHECK(reuse_customer_evidence IN (0,1))",
      ]);
      expect(query.mock.calls.some(([sql]) => sql.startsWith("CREATE TABLE businesses"))).toBe(false);
      expect(rows.find((row) => row.version === 2)?.completed).toBe(1);
      query.mockClear();
      await migrateMysql(pool, "fictional-test");
      expect(query.mock.calls.some(([sql]) => /^(?:ALTER|INSERT|UPDATE)/.test(sql))).toBe(false);
    });
  });
  it("refuses an interrupted upgrade without retrying its DDL and releases the migration lock", async () => {
    await fixture(async ({ pool, rows, query, release }) => {
      await migrateMysql(pool, "fictional-test");
      rows.find((row) => row.version === 2)!.completed = 0;
      query.mockClear(); release.mockClear();
      await expect(migrateMysql(pool, "fictional-test")).rejects.toThrow("interrupted");
      expect(query.mock.calls.some(([sql]) => /^(?:ALTER|INSERT|UPDATE)/.test(sql))).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes("RELEASE_LOCK"))).toBe(true);
      expect(release).toHaveBeenCalledOnce();
    });
  });
  it("adds weekly review persistence to a v2 database without replaying prior migrations", async () => {
    await fixture(async ({ pool, rows, query }) => {
      await migrateMysql(pool, "fictional-test");
      const applied = structuredClone(rows.slice(0, 2));
      rows.splice(2); query.mockClear();
      await migrateMysql(pool, "fictional-test");
      expect(rows.slice(0, 2)).toEqual(applied);
      expect(rows[2].completed).toBe(1);
      expect(query.mock.calls.filter(([sql]) => /^CREATE TABLE (?!IF NOT EXISTS )/.test(sql)).map(([sql]) => sql.match(/^CREATE TABLE (\w+)/)?.[1]))
        .toEqual(["sales_observations", "weekly_reviews", "action_measurements"]);
      expect(query.mock.calls.filter(([sql]) => sql.startsWith("ALTER TABLE")).map(([sql]) => sql))
        .toEqual([
          "ALTER TABLE product_analyses ADD COLUMN progress_json LONGTEXT CHECK(progress_json IS NULL OR JSON_VALID(progress_json))",
          "ALTER TABLE analysis_jobs ADD COLUMN reuse_customer_evidence INTEGER NOT NULL DEFAULT 0 CHECK(reuse_customer_evidence IN (0,1))",
        ]);
    });
  });
  it("validates all applied checksums before attempting any missing migration", async () => {
    await fixture(async ({ pool, rows, query }) => {
      await migrateMysql(pool, "fictional-test");
      rows.shift();
      rows[0].checksum = "invalid";
      query.mockClear();
      await expect(migrateMysql(pool, "fictional-test")).rejects.toThrow("checksum");
      expect(query.mock.calls.some(([sql]) => /^(?:ALTER|INSERT|UPDATE)/.test(sql))).toBe(false);
    });
  });
});

describe.skipIf(!enabled)("real MySQL persistence (explicit disposable database only)", () => {
  let first: Store, second: Store, pool: Pool, database: SqlDatabase;
  beforeAll(async () => {
    const config = loadConfig({ ...process.env, NODE_ENV: "test", DATABASE_CLIENT: "mysql" });
    if (!config.mysql || !/^gp_(?:test_|verification$)/.test(config.mysql.DB_NAME)) {
      throw new Error("Use an explicitly disposable DB_NAME beginning gp_test_ or exactly gp_verification.");
    }
    const mysql = config.mysql;
    pool = createPool({
      host: mysql.DB_HOST, port: mysql.DB_PORT, database: mysql.DB_NAME,
      user: mysql.DB_USER, password: mysql.DB_PASSWORD,
      ssl: mysql.DB_SSL_MODE === "required" ? { rejectUnauthorized: true, ...(mysql.DB_SSL_CA ? { ca: mysql.DB_SSL_CA } : {}) } : undefined,
      connectionLimit: 4, charset: "utf8mb4",
    });
    database = mysqlDatabase(pool);
    // Both instances must see the same fully applied schema, including on an empty database.
    [first, second] = await Promise.all([openMysqlStore(mysql), openMysqlStore(mysql)]);
  }, 30_000);
  afterAll(async () => {
    await Promise.all([first?.close(), second?.close(), database?.close()]);
  });
  async function owner(store = first) {
    const user = { id: randomUUID(), name: "Synthetic owner", email: `${randomUUID()}@example.test` };
    const session = newSession();
    await store.createAccount(user, "synthetic-only hash", session.tokenHash, session.expiresAt);
    const business = await store.saveBusiness(user.id, { name: "Synthetic shop", category: "", description: "", website });
    if (!business) throw new Error("Fixture business was not saved.");
    return { user, business, session };
  }
  const scan = () => {
    const now = new Date().toISOString();
    return {
      requestedUrl: website, status: "complete" as const, startedAt: now, completedAt: now, failures: [], notes: [],
      pages: [{ url: website, capturedAt: now, title: "Synthetic shop", description: "", text: "Public fixture",
        headings: [], contacts: [], callsToAction: [], links: [], warnings: [] }],
    };
  };
  function tool(name: string, input: unknown): AgentMessage {
    return { stop_reason: "tool_use", content: [{ type: "tool_use", caller: { type: "direct" }, id: `synthetic-${name}`, name, input }] };
  }

  it("authenticates, scopes ownership, rotates sessions and serves production health", async () => {
    const app = createApp({ store: first, origin });
    const email = `${randomUUID()}@example.test`, password = "synthetic local test passphrase";
    const created = await request(app).post("/api/auth/register").set("Origin", origin)
      .send({ name: "Synthetic owner", email, password }).expect(201);
    const cookie = String(created.headers["set-cookie"][0]).split(";")[0];
    await request(app).post("/api/auth/register").set("Origin", origin)
      .send({ name: "Duplicate", email, password }).expect(409);
    const profile = await request(app).post("/api/businesses").set("Origin", origin).set("Cookie", cookie)
      .send({ name: "Synthetic shop", website, category: "", description: "" }).expect(201);
    const other = await owner(second);
    expect(await second.getBusiness(other.user.id, profile.body.business.id)).toBeUndefined();
    const reopenedApp = createApp({ store: second, origin });
    await request(reopenedApp).get(`/api/businesses/${profile.body.business.id}`).set("Cookie", cookie).expect(200);
    const loggedIn = await request(reopenedApp).post("/api/auth/login").set("Origin", origin).set("Cookie", cookie)
      .send({ email, password }).expect(200);
    await request(app).get("/api/auth/me").set("Cookie", cookie).expect(401);
    const currentCookie = String(loggedIn.headers["set-cookie"][0]).split(";")[0];
    await request(app).post("/api/auth/logout").set("Origin", origin).set("Cookie", currentCookie).expect(204);
    await request(reopenedApp).get("/api/auth/me").set("Cookie", currentCookie).expect(401);
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.database).toEqual({ engine: "mysql", status: "ok" });
  });

  it("rolls back transactions and nested savepoints without interleaving other owners", async () => {
    const { user, business } = await owner();
    await expect(database.transaction(async () => {
      await database.prepare("UPDATE businesses SET name=? WHERE id=?").run("Rolled back", business.id);
      throw new Error("synthetic rollback");
    })()).rejects.toThrow("synthetic rollback");
    expect((await second.getBusiness(user.id, business.id))?.name).toBe("Synthetic shop");
    await database.transaction(async () => {
      await database.prepare("UPDATE businesses SET name=? WHERE id=?").run("Outer committed", business.id);
      await expect(database.transaction(async () => {
        await database.prepare("UPDATE businesses SET name=? WHERE id=?").run("Inner rolled back", business.id);
        throw new Error("inner rollback");
      })()).rejects.toThrow("inner rollback");
    })();
    expect((await second.getBusiness(user.id, business.id))?.name).toBe("Outer committed");
    await database.transaction(async () => {
      const failed = database.transaction(async () => {
        await database.prepare("UPDATE businesses SET name=? WHERE id=?").run("Discard sibling", business.id);
        throw new Error("sibling rollback");
      })();
      const accepted = database.transaction(async () => {
        await database.prepare("UPDATE businesses SET name=? WHERE id=?").run("Sibling committed", business.id);
      })();
      await Promise.all([expect(failed).rejects.toThrow("sibling rollback"), accepted]);
    })();
    expect((await second.getBusiness(user.id, business.id))?.name).toBe("Sibling committed");
    expect(await first.listEvidence(user.id, business.id)).toHaveLength(1);
    expect(await second.listActivity(user.id, business.id)).toHaveLength(1);
  });

  it("preserves catalogue identity, Unicode, imports and full long listing source keys", async () => {
    const { user, business } = await owner();
    const product = await first.saveProduct(user.id, business.id, { ...emptyProduct, name: "Café cotton shirt", sku: "Fixture-001" });
    const rows = [{
      row: 2, sourceKey: "https://shop.example.com/" + "a".repeat(3000), reference: website, capturedAt: new Date().toISOString(),
      data: { ...emptyProduct, name: "Café cotton shirt", sku: "Fixture-001", price: "499.00", currency: "INR" },
      errors: [], notes: [],
    }];
    const draft = await first.createProductImport(user.id, business.id, "csv", "synthetic", rows);
    const decisions = { decisions: [{ row: 2, action: "link", productId: product.id }] };
    const committed = await first.commitProductImport(user.id, business.id, draft.id, decisions);
    expect(await second.commitProductImport(user.id, business.id, draft.id, decisions)).toEqual(committed);
    const products = await second.listProducts(user.id, business.id);
    expect(products).toHaveLength(1);
    expect(products[0]?.listings).toHaveLength(2);
    expect(products[0]?.name).toBe("Café cotton shirt");
    await expect(first.saveProduct(user.id, business.id, { ...emptyProduct, name: "Duplicate", sku: "fixture-001" })).rejects.toThrow();
    await first.saveProduct(user.id, business.id, { ...emptyProduct, name: "No identifiers" });
    await first.saveProduct(user.id, business.id, { ...emptyProduct, name: "Another without identifiers" });
    expect(await second.listProducts(user.id, business.id)).toHaveLength(3);
  });

  it("fences competing job claims and retains research budgets after reopening", async () => {
    const { user, business } = await owner();
    const savedScan = await first.saveScan(user.id, business.id, scan());
    if (!savedScan) throw new Error("Fixture scan was not saved.");
    const requestKey = randomUUID();
    const job = await first.enqueueAnalysis(user.id, business.id, requestKey, website, savedScan.id, true);
    expect((await second.enqueueAnalysis(user.id, business.id, requestKey, website, savedScan.id, true)).id).toBe(job.id);
    const claims = await Promise.all([first.claimAnalysis(), second.claimAnalysis()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find((item) => item?.id === job.id);
    if (!claim) throw new Error("Fixture job was not claimed.");
    try {
      const journal = first.researchJournal(job.id, claim.lease);
      await journal.consume("searches");
      await journal.consume("modelCalls");
      const now = new Date().toISOString();
      await journal.write({ key: "store", agent: "store", status: "completed", findings: [], limitations: [],
        diagnostic: null, startedAt: now, completedAt: now, reused: false }, { synthetic: true });
      expect((await second.researchJournal(job.id, claim.lease).report())?.usage).toMatchObject({ searches: 1, modelCalls: 1 });
      expect(await second.researchJournal(job.id, claim.lease).read("store")).toMatchObject({ artifact: { synthetic: true } });
      expect(await second.renewAnalysisLease(job.id, "wrong-lease")).toBe(false);
    } finally { await first.cancelAnalysis(user.id, business.id, job.id); }
    expect(await first.renewAnalysisLease(job.id, claim.lease)).toBe(false);
    await expect(first.researchJournal(job.id, claim.lease).consume("searches")).rejects.toThrow();
    expect((await second.getAnalysisJob(user.id, business.id, job.id))?.status).toBe("cancelled");
  });

  it("claims public previews idempotently and resolves saved website import scans", async () => {
    const { user, business } = await owner();
    const token = randomUUID();
    await first.savePreview(token, scan());
    const claimed = await first.claimPreview(user.id, token);
    expect(await second.claimPreview(user.id, token)).toEqual(claimed);
    const savedScan = await first.saveScan(user.id, business.id, scan());
    if (!savedScan) throw new Error("Missing synthetic scan.");
    const draft = await first.createProductImport(user.id, business.id, "website", "shop.example.com", [{
      row: 1, sourceKey: "fixture-product", reference: website, capturedAt: savedScan.pages[0]!.capturedAt,
      data: { ...emptyProduct, name: "Synthetic shirt" }, errors: [], notes: [],
    }]);
    expect((await second.getProductImportScan(user.id, business.id, draft.id))?.id).toBe(savedScan.id);
  });

  it("atomically completes a worker analysis using saved evidence without external providers", async () => {
    const { user, business } = await owner();
    const fixture = scan(), saved = await first.saveScan(user.id, business.id, fixture);
    if (!saved) throw new Error("Missing synthetic scan.");
    const source = buildAgentEvidence(fixture).payload.pages[0]!.excerpts.find((item) => item.quote === "Public fixture")!;
    const agent = createBusinessAgent({ complete: async (input) => input.tool_choice?.type === "tool" && input.tool_choice.name === "scan_website"
      ? tool("scan_website", {}) : tool("propose_business", {
        briefing: { summary: { text: "The fixture describes a public shop.", sources: [source.id] }, insights: [], unknowns: [], nextSteps: [] },
        suggestions: [],
      }) });
    const job = await first.enqueueAnalysis(user.id, business.id, randomUUID(), website, saved.id);
    const worker = createAnalysisWorker({ store: first, agent });
    try { await worker.tick(); }
    finally { await worker.stop(); }
    const completed = await second.getAnalysisJob(user.id, business.id, job.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.understanding?.scanId).toBe(saved.id);
    expect((await second.latestUnderstanding(user.id, business.id))?.id).toBe(completed?.understanding?.id);
  });

  it("reads JSON-backed understanding and growth plans across connections", async () => {
    const { user, business, session } = await owner();
    const saved = await first.saveScan(user.id, business.id, scan());
    if (!saved) throw new Error("Missing synthetic scan.");
    const now = new Date().toISOString();
    const research: ResearchReport = {
      version: 1, status: "partial", enabled: true, usage: { modelCalls: 1, searches: 0, competitorScans: 0 },
      steps: [{ key: "growth", agent: "growth", status: "completed", startedAt: now, completedAt: now, reused: false,
        diagnostic: null, limitations: [], findings: [{
          kind: "suggestion", title: "Test clearer sizing", detail: "Review size guidance with shoppers before changing pages.",
          sources: [{ id: "e_1111111111111111", url: website, quote: "Public fixture", capturedAt: saved.pages[0]!.capturedAt }],
        }] }],
    };
    await first.saveUnderstanding(user.id, {
      id: randomUUID(), businessId: business.id, scanId: saved.id, scanStatus: "complete", reviewedAt: null, createdAt: now,
      warnings: [], suggestions: [], productImportId: null, research,
      briefing: { summary: { text: "Synthetic public shop", sources: [{ url: website, quote: "Public fixture" }] },
        insights: [], unknowns: [], nextSteps: [] },
    });
    const app = createApp({ store: second, origin }), endpoint = `/api/businesses/${business.id}/growth`;
    const cookie = `gp_session=${session.token}`;
    const response = await request(app).get(endpoint).set("Cookie", cookie).expect(200);
    expect(response.body.opportunities).toHaveLength(1);
    const id = response.body.opportunities[0].id;
    const added = await request(app).post(`${endpoint}/${id}/plan`).set("Cookie", cookie).set("Origin", origin).send({}).expect(201);
    const duplicate = await request(app).post(`${endpoint}/${id}/plan`).set("Cookie", cookie).set("Origin", origin).send({}).expect(200);
    expect(duplicate.body.item).toEqual(added.body.item);
    const change = { status: "in_progress", impact: "high", effort: "low", timeToValue: "weeks", revision: 0 };
    await request(app).patch(`${endpoint}/${id}/plan`).set("Cookie", cookie).set("Origin", origin).send(change).expect(200);
    await request(app).patch(`${endpoint}/${id}/plan`).set("Cookie", cookie).set("Origin", origin).send(change).expect(409);
    const restored = await request(createApp({ store: first, origin })).get(endpoint).set("Cookie", cookie).expect(200);
    expect(restored.body.plan[0]).toMatchObject({ status: "in_progress", revision: 1 });
  });

  it("persists sales, traffic and isolated scenarios with stale-version protection", async () => {
    const { user, business } = await owner();
    const csv = Buffer.from("order_id,date,quantity,unit_price\nA,2025-01-01,2,10\nB,2025-01-02,1,20");
    const baseline = await first.salesData(user.id, business.id);
    const draft = await first.previewSales(user.id, business.id, "synthetic.csv", salesFileHash(csv), await readSalesFile(csv, "csv", "GBP"));
    const actual = await first.commitSales(user.id, business.id, draft.id, baseline.version, true);
    expect((await second.commitSales(user.id, business.id, draft.id, baseline.version, true)).version).toBe(actual.version);
    const traffic = Buffer.from("date,sessions,purchasing_sessions\n2025-01-01,100,1\n2025-01-02,200,1");
    const trafficDraft = await first.previewTraffic(user.id, business.id, "traffic.csv", "Synthetic", salesFileHash(traffic), readTrafficFile(traffic));
    const combined = await first.commitTraffic(user.id, business.id, trafficDraft.id, actual.version, true);
    const simulated = await first.saveSalesScenario(user.id, business.id, {
      name: "Synthetic assumption", start: "2025-01-01", end: "2025-01-02", ordersPct: 10, aovPct: 0, costPct: 0,
    }, combined.version);
    const restored = await second.salesData(user.id, business.id);
    expect(restored.days).toEqual(actual.days);
    expect(restored.traffic?.snapshot.days).toHaveLength(2);
    expect(restored.scenarios).toEqual(simulated.scenarios);
    await expect(second.saveSalesScenario(user.id, business.id, {
      name: "Stale", start: "2025-01-01", end: "2025-01-02", ordersPct: 0, aovPct: 0, costPct: 0,
    }, baseline.version)).rejects.toThrow("History changed");
  });

  it("stores marketplace review imports and fences product analysis leases", async () => {
    const { user, business } = await owner();
    const product = await first.saveProduct(user.id, business.id, { ...emptyProduct, name: "Synthetic bottle" });
    const report = importMarketplaceCsv(product,
      "product_url,title,review\nhttps://www.amazon.in/dp/B012345678,Synthetic bottle,The synthetic fixture is easy to carry.");
    const key = randomUUID();
    const tasks = await Promise.all([first, second].map((store) =>
      store.beginMarketplace(user.id, business.id, product.id, report.fingerprint, key, "synthetic-input")));
    expect(tasks.filter((task) => task.started)).toHaveLength(1);
    expect(tasks[0]!.id).toBe(tasks[1]!.id);
    const task = tasks.find((task) => task.started)!;
    const progress = { stage: "collecting" as const, completed: 0, total: 1 };
    await first.updateMarketplaceProgress(user.id, business.id, product.id, task.id, progress);
    expect((await second.marketplaceState(user.id, business.id, product.id, report.fingerprint)).progress).toEqual(progress);
    await first.finishMarketplace(user.id, business.id, product.id, task.id, report);
    expect(await second.marketplaceState(user.id, business.id, product.id, report.fingerprint)).toMatchObject({ report, progress: null });
    expect(await second.marketplaceRequest(user.id, business.id, product.id, key, "synthetic-input")).toBeTruthy();
    const fingerprint = productFingerprint(product);
    const lease = await first.beginProductAnalysis(user.id, business.id, product.id, fingerprint);
    await expect(second.beginProductAnalysis(user.id, business.id, product.id, fingerprint)).rejects.toThrow();
    await first.failProductAnalysis(user.id, business.id, product.id, fingerprint, "Synthetic failure", lease);
    expect((await second.productAnalysisState(user.id, business.id, product.id, fingerprint)).error).toBe("Synthetic failure");
  });

  it("persists graph checkpoints, write order, conflict semantics and thread deletion", async () => {
    const thread = randomUUID(), config = { configurable: { thread_id: thread } };
    const saver = new SqlCheckpointSaver(database);
    const checkpoint = {
      v: 4, id: randomUUID(), ts: new Date().toISOString(), channel_values: { result: "Synthetic result" },
      channel_versions: { result: 1 }, versions_seen: {},
    };
    const saved = await saver.put(config, checkpoint, { source: "input", step: 0, parents: {} });
    await saver.putWrites(saved, [["result", "late"]], "task-b", "b");
    await saver.putWrites(saved, [["result", "first"]], "task-a", "a");
    await saver.putWrites(saved, [["result", "must not replace"]], "task-a", "a");
    await saver.putWrites(saved, [["__error__", "old"]], "task-c");
    await saver.putWrites(saved, [["__error__", "new"]], "task-c");
    const restored = await second.researchCheckpointer.getTuple(saved);
    expect(restored?.checkpoint).toEqual(checkpoint);
    expect(restored?.pendingWrites).toEqual([
      ["task-c", "__error__", "new"], ["task-a", "result", "first"], ["task-b", "result", "late"],
    ]);
    const child = { ...checkpoint, id: randomUUID() };
    const childConfig = await saver.put(saved, child, { source: "loop", step: 1, parents: {} });
    expect((await saver.getTuple(childConfig))?.parentConfig).toEqual(saved);
    const listed = [];
    for await (const tuple of saver.list(config, { filter: { source: "loop" }, limit: 1 })) listed.push(tuple);
    expect(listed.map((tuple) => tuple.checkpoint.id)).toEqual([child.id]);
    await saver.deleteThread(thread);
    expect(await second.researchCheckpointer.getTuple(saved)).toBeUndefined();
  });

  it("refuses unknown, changed or interrupted migrations without deleting saved data", async () => {
    const { user, business } = await owner();
    const config = loadConfig({ ...process.env, NODE_ENV: "test", DATABASE_CLIENT: "mysql" }).mysql!;
    await pool.query("INSERT INTO mysql_schema_migrations(version,checksum,completed) VALUES(99,?,1)", ["0".repeat(64)]);
    try { await expect(openMysqlStore(config)).rejects.toThrow("newer"); }
    finally { await pool.query("DELETE FROM mysql_schema_migrations WHERE version=99"); }
    await pool.query("UPDATE mysql_schema_migrations SET completed=0 WHERE version=1");
    try { await expect(openMysqlStore(config)).rejects.toThrow("interrupted"); }
    finally { await pool.query("UPDATE mysql_schema_migrations SET completed=1 WHERE version=1"); }
    const [rows] = await pool.query<(RowDataPacket & { checksum: string })[]>("SELECT checksum FROM mysql_schema_migrations WHERE version=1");
    await pool.query("UPDATE mysql_schema_migrations SET checksum=? WHERE version=1", ["0".repeat(64)]);
    try { await expect(openMysqlStore(config)).rejects.toThrow("checksum"); }
    finally { await pool.query("UPDATE mysql_schema_migrations SET checksum=? WHERE version=1", [rows[0]!.checksum]); }
    expect((await second.getBusiness(user.id, business.id))?.name).toBe("Synthetic shop");
  });
});
