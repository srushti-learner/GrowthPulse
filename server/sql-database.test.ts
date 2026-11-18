import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteDatabase, type SqlDatabase } from "./sql-database.js";

describe("async SQLite transaction boundaries", () => {
  let database: SqlDatabase;
  beforeEach(() => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE fixture_records (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
    database = sqliteDatabase(raw);
  });
  afterEach(async () => { await database.close(); });

  it("does not expose uncommitted writes to unrelated async callers", async () => {
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const failed = database.transaction(async () => {
      await database.prepare("INSERT INTO fixture_records (id,label) VALUES (?,?)").run(1, "private");
      started();
      await hold;
      throw new Error("synthetic rollback");
    })();
    const assertion = expect(failed).rejects.toThrow("synthetic rollback");
    await entered;
    const unrelated = database.prepare<[], { label: string }>("SELECT label FROM fixture_records").all();
    release();
    await assertion;
    expect(await unrelated).toEqual([]);
    await database.prepare("INSERT INTO fixture_records (id,label) VALUES (?,?)").run(2, "committed");
    expect(await database.prepare<[], { label: string }>("SELECT label FROM fixture_records").get()).toEqual({ label: "committed" });
  });

  it("serializes sibling savepoints and rolls back only the failed nested mutation", async () => {
    await database.transaction(async () => {
      const failed = database.transaction(async () => {
        await database.prepare("INSERT INTO fixture_records (id,label) VALUES (?,?)").run(1, "discard");
        await Promise.resolve();
        throw new Error("nested rollback");
      })();
      const accepted = database.transaction(async () => {
        await database.prepare("INSERT INTO fixture_records (id,label) VALUES (?,?)").run(2, "keep");
      })();
      await Promise.all([expect(failed).rejects.toThrow("nested rollback"), accepted]);
    })();
    expect(await database.prepare<[], { id: number; label: string }>("SELECT id,label FROM fixture_records").all())
      .toEqual([{ id: 2, label: "keep" }]);
  });

  it("serializes async transactions across adapters for the same local file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gp-sql-adapters-")), path = join(directory, "fixture.sqlite");
    const first = sqliteDatabase(new Database(path, { timeout: 10 }));
    const second = sqliteDatabase(new Database(path, { timeout: 10 }));
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    try {
      await first.prepare("CREATE TABLE fixture_records (id INTEGER PRIMARY KEY)").run();
      const one = first.transaction(async () => {
        await first.prepare("INSERT INTO fixture_records (id) VALUES (?)").run(1);
        started();
        await hold;
      })();
      await entered;
      const two = second.transaction(async () => {
        await second.prepare("INSERT INTO fixture_records (id) VALUES (?)").run(2);
      })();
      release();
      await Promise.all([one, two]);
      expect(await first.prepare<[], { id: number }>("SELECT id FROM fixture_records ORDER BY id").all())
        .toEqual([{ id: 1 }, { id: 2 }]);
    } finally {
      release();
      await Promise.all([first.close(), second.close()]);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
