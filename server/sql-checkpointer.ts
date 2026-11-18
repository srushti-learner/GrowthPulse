import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver, TASKS, WRITES_IDX_MAP, compareWritesSortKeys, maxChannelVersion, writesSortKey,
  type Checkpoint, type CheckpointListOptions, type CheckpointMetadata,
  type CheckpointTuple, type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { SqlDatabase } from "./sql-database.js";

type Snapshot = { thread_id: string; checkpoint_ns: string; checkpoint_id: string; parent_id: string | null; payload: string; metadata: string };
type Write = { task_id: string; task_path: string; write_index: number; channel: string; payload: string };
const identifier = z.string().min(1).max(128);
const namespace = z.string().max(191);
const envelope = z.object({ type: z.string(), bytes: z.string() });

export class SqlCheckpointSaver extends BaseCheckpointSaver {
  private setupPromise?: Promise<void>;
  constructor(private database: SqlDatabase) { super(); }

  private ready() {
    if (this.database.dialect !== "sqlite") return Promise.resolve();
    return this.setupPromise ??= this.database.transaction(async () => {
      if (await this.database.prepare("SELECT name FROM graph_checkpoint_imports WHERE name=?").get("sqlite-legacy-v1")) return;
      const tables = await this.database.prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('checkpoints','writes')",
      ).all();
      const encode = (type: string | null, bytes: Uint8Array) =>
        JSON.stringify({ type: type ?? "json", bytes: Buffer.from(bytes).toString("base64") });
      if (tables.some((table) => table.name === "checkpoints")) {
        type Legacy = { thread_id: string; checkpoint_ns: string; checkpoint_id: string; parent_checkpoint_id: string | null;
          type: string | null; checkpoint: Uint8Array; metadata: Uint8Array };
        const rows = await this.database.prepare<[], Legacy>("SELECT * FROM checkpoints").all();
        for (const row of rows) {
          await this.database.prepare(`INSERT INTO graph_checkpoints (thread_id,checkpoint_ns,checkpoint_id,parent_id,payload,metadata)
            VALUES (?,?,?,?,?,?) ON CONFLICT(thread_id,checkpoint_ns,checkpoint_id) DO NOTHING`)
            .run(row.thread_id, row.checkpoint_ns, row.checkpoint_id, row.parent_checkpoint_id,
              encode(row.type, row.checkpoint), encode(row.type, row.metadata));
        }
      }
      if (tables.some((table) => table.name === "writes")) {
        const columns = await this.database.prepare<[], { name: string }>("PRAGMA table_info(writes)").all();
        type LegacyWrite = { thread_id: string; checkpoint_ns: string; checkpoint_id: string; task_id: string;
          idx: number; channel: string; type: string | null; value: Uint8Array; task_path: string };
        const rows = await this.database.prepare<[], LegacyWrite>(
          `SELECT *, ${columns.some((column) => column.name === "task_path") ? "task_path" : "''"} AS task_path FROM writes`,
        ).all();
        for (const row of rows) {
          await this.database.prepare(`INSERT INTO graph_writes (thread_id,checkpoint_ns,checkpoint_id,task_id,write_index,task_path,channel,payload)
            VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,checkpoint_ns,checkpoint_id,task_id,write_index) DO NOTHING`)
            .run(row.thread_id, row.checkpoint_ns, row.checkpoint_id, row.task_id, row.idx, row.task_path,
              row.channel, encode(row.type, row.value));
        }
      }
      await this.database.prepare("INSERT INTO graph_checkpoint_imports (name) VALUES (?)").run("sqlite-legacy-v1");
    })();
  }
  private keys(config: RunnableConfig) {
    return {
      thread: identifier.parse(config.configurable?.thread_id),
      ns: namespace.parse(config.configurable?.checkpoint_ns ?? ""),
      id: config.configurable?.checkpoint_id === undefined ? undefined : identifier.parse(config.configurable.checkpoint_id),
    };
  }
  private async encode(value: unknown) {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    return JSON.stringify({ type, bytes: Buffer.from(bytes).toString("base64") });
  }
  private decode(value: string) {
    const saved = envelope.parse(JSON.parse(value));
    return this.serde.loadsTyped(saved.type, Buffer.from(saved.bytes, "base64"));
  }
  private config(row: Snapshot): RunnableConfig {
    return { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id } };
  }
  private async tuple(row: Snapshot): Promise<CheckpointTuple> {
    const writes = await this.database.prepare<[string, string, string], Write>(
      "SELECT task_id, task_path, write_index, channel, payload FROM graph_writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?",
    ).all(row.thread_id, row.checkpoint_ns, row.checkpoint_id);
    writes.sort((a, b) => compareWritesSortKeys(
      writesSortKey(a.task_path, a.task_id, a.write_index), writesSortKey(b.task_path, b.task_id, b.write_index),
    ));
    const checkpoint: Checkpoint = await this.decode(row.payload);
    if (checkpoint.v < 4 && row.parent_id) {
      const sends = await this.database.prepare<[string, string, string, string], { payload: string }>(
        "SELECT payload FROM graph_writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? AND channel=? ORDER BY write_index",
      ).all(row.thread_id, row.checkpoint_ns, row.parent_id, TASKS);
      checkpoint.channel_values[TASKS] = await Promise.all(sends.map((send) => this.decode(send.payload)));
      const versions = Object.values(checkpoint.channel_versions);
      checkpoint.channel_versions[TASKS] = versions.length ? maxChannelVersion(...versions) : this.getNextVersion(undefined);
    }
    return {
      config: this.config(row),
      checkpoint,
      metadata: await this.decode(row.metadata),
      ...(row.parent_id ? { parentConfig: { configurable: {
        thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.parent_id,
      } } } : {}),
      pendingWrites: await Promise.all(writes.map(async (write): Promise<[string, string, unknown]> =>
        [write.task_id, write.channel, await this.decode(write.payload)])),
    };
  }
  async getTuple(config: RunnableConfig) {
    await this.ready();
    const { thread, ns, id } = this.keys(config);
    const row = await this.database.prepare<[string, string, string | null, string | null], Snapshot>(
      "SELECT * FROM graph_checkpoints WHERE thread_id=? AND checkpoint_ns=? AND (? IS NULL OR checkpoint_id=?) ORDER BY checkpoint_id DESC LIMIT 1",
    ).get(thread, ns, id ?? null, id ?? null);
    return row ? this.tuple(row) : undefined;
  }
  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    await this.ready();
    const thread = config.configurable?.thread_id === undefined ? null : identifier.parse(config.configurable.thread_id);
    const ns = config.configurable?.checkpoint_ns === undefined ? null : namespace.parse(config.configurable.checkpoint_ns);
    const id = config.configurable?.checkpoint_id === undefined ? null : identifier.parse(config.configurable.checkpoint_id);
    const before = options.before?.configurable?.checkpoint_id === undefined ? null : identifier.parse(options.before.configurable.checkpoint_id);
    if (options.limit !== undefined) z.number().int().nonnegative().parse(options.limit);
    let remaining = options.limit ?? Infinity;
    const rows = await this.database.prepare<[string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null], Snapshot>(
      `SELECT * FROM graph_checkpoints WHERE (? IS NULL OR thread_id=?) AND (? IS NULL OR checkpoint_ns=?)
        AND (? IS NULL OR checkpoint_id=?) AND (? IS NULL OR checkpoint_id<?) ORDER BY checkpoint_id DESC`,
    ).all(thread, thread, ns, ns, id, id, before, before);
    for (const row of rows) {
      if (remaining <= 0) break;
      const tuple = await this.tuple(row);
      if (options.filter && !Object.entries(options.filter).every(([key, value]) =>
        Object.entries(tuple.metadata ?? {}).some(([field, saved]) => field === key && saved === value))) continue;
      remaining--;
      yield tuple;
    }
  }
  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    await this.ready();
    const { thread, ns, id: parent } = this.keys(config);
    const id = identifier.parse(checkpoint.id);
    const payload = await this.encode(checkpoint), meta = await this.encode(metadata);
    const conflict = this.database.dialect === "mysql"
      ? "ON DUPLICATE KEY UPDATE parent_id=VALUES(parent_id), payload=VALUES(payload), metadata=VALUES(metadata)"
      : "ON CONFLICT(thread_id,checkpoint_ns,checkpoint_id) DO UPDATE SET parent_id=excluded.parent_id, payload=excluded.payload, metadata=excluded.metadata";
    await this.database.prepare(`INSERT INTO graph_checkpoints
      (thread_id,checkpoint_ns,checkpoint_id,parent_id,payload,metadata) VALUES (?,?,?,?,?,?) ${conflict}`)
      .run(thread, ns, id, parent ?? null, payload, meta);
    return { configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: id } };
  }
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath = "") {
    await this.ready();
    const { thread, ns, id } = this.keys(config);
    if (!id) throw new Error("Checkpoint writes require a checkpoint ID.");
    identifier.parse(taskId);
    const encoded = await Promise.all(writes.map(async ([channel, value], index) => ({
      channel, index: WRITES_IDX_MAP[channel] ?? index, payload: await this.encode(value),
    })));
    await this.database.transaction(async () => {
      for (const write of encoded) {
        const row = await this.database.prepare("SELECT write_index FROM graph_writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? AND task_id=? AND write_index=?")
          .get(thread, ns, id, taskId, write.index);
        if (row && write.index >= 0) continue;
        if (row) {
          await this.database.prepare("UPDATE graph_writes SET channel=?,payload=?,task_path=? WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? AND task_id=? AND write_index=?")
            .run(write.channel, write.payload, taskPath, thread, ns, id, taskId, write.index);
        } else {
          await this.database.prepare("INSERT INTO graph_writes (thread_id,checkpoint_ns,checkpoint_id,task_id,write_index,task_path,channel,payload) VALUES (?,?,?,?,?,?,?,?)")
            .run(thread, ns, id, taskId, write.index, taskPath, write.channel, write.payload);
        }
      }
    })();
  }
  async deleteThread(threadId: string) {
    await this.ready();
    identifier.parse(threadId);
    await this.database.transaction(async () => {
      await this.database.prepare("DELETE FROM graph_writes WHERE thread_id=?").run(threadId);
      await this.database.prepare("DELETE FROM graph_checkpoints WHERE thread_id=?").run(threadId);
    })();
  }
}
