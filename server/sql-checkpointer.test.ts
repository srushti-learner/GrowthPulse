import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { TASKS } from "@langchain/langgraph-checkpoint";
import { migrate } from "./migrations.js";
import { sqliteDatabase, type SqlDatabase } from "./sql-database.js";
import { SqlCheckpointSaver } from "./sql-checkpointer.js";

describe("legacy SQLite graph compatibility", () => {
  let database: SqlDatabase | undefined;
  afterEach(async () => { await database?.close(); });

  it.each([false, true])("preserves legacy checkpoints and writes (pre-task-path schema: %s)", async (oldSchema) => {
    const raw = new Database(":memory:");
    const legacy = new SqliteSaver(raw);
    const checkpoint = {
      v: 3, id: "0001", ts: new Date().toISOString(), channel_values: { result: "Synthetic evidence" },
      channel_versions: { result: 2 }, versions_seen: {},
    };
    const metadata = { source: "input" as const, step: 0, parents: {} };
    const parent = await legacy.put({ configurable: { thread_id: "legacy-thread" } }, checkpoint, metadata);
    await legacy.putWrites(parent, [["result", "retained"], [TASKS, { node: "fixture" }]], "fixture-task");
    const child = await legacy.put(parent, { ...checkpoint, id: "0002" }, metadata);
    const expected = await legacy.getTuple(child);
    if (oldSchema) raw.exec("ALTER TABLE writes DROP COLUMN task_path");
    migrate(raw);
    database = sqliteDatabase(raw);
    const saver = new SqlCheckpointSaver(database);
    expect(await saver.getTuple(child)).toEqual(expected);
    expect((await saver.getTuple(parent))?.pendingWrites).toEqual([
      ["fixture-task", "result", "retained"], ["fixture-task", TASKS, { node: "fixture" }],
    ]);
    expect(raw.prepare("SELECT count(*) AS count FROM checkpoints").get()).toEqual({ count: 2 });
    await saver.deleteThread("legacy-thread");
    expect(await new SqlCheckpointSaver(database).getTuple(child)).toBeUndefined();
  });
});
