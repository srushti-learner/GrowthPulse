import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export interface SqlDatabase {
  readonly dialect: "sqlite" | "mysql";
  prepare<Parameters extends unknown[] = unknown[], Row = Record<string, unknown>>(sql: string): {
    get(...parameters: Parameters): Promise<Row | undefined>;
    all(...parameters: Parameters): Promise<Row[]>;
    run(...parameters: Parameters): Promise<{ changes: number }>;
  };
  transaction<T>(callback: () => Promise<T>): {
    (): Promise<T>;
    immediate(): Promise<T>;
  };
  close(): Promise<void>;
}

class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  async run<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await callback(); } finally { release(); }
  }
}
const sqliteFiles = new Map<string, { queue: SerialQueue; users: number }>();

export function sqliteDatabase(raw: Database.Database): SqlDatabase {
  const filename = raw.name === ":memory:" ? undefined : resolve(raw.name);
  const shared = filename ? sqliteFiles.get(filename) ?? { queue: new SerialQueue(), users: 0 } : undefined;
  if (filename && shared) { shared.users++; sqliteFiles.set(filename, shared); }
  const queue = shared?.queue ?? new SerialQueue();
  let closed = false;
  const context = new AsyncLocalStorage<{ depth: number; children: SerialQueue }>();
  const execute = <T>(callback: () => T): Promise<T> =>
    context.getStore() ? Promise.resolve().then(callback) : queue.run(async () => callback());
  return {
    dialect: "sqlite",
    prepare<Parameters extends unknown[], Row>(sql: string) {
      return {
        get: (...parameters: Parameters) => execute(() => raw.prepare<Parameters, Row>(sql).get(...parameters)),
        all: (...parameters: Parameters) => execute(() => raw.prepare<Parameters, Row>(sql).all(...parameters)),
        run: (...parameters: Parameters) => execute(() => ({ changes: raw.prepare(sql).run(...parameters).changes })),
      };
    },
    transaction<T>(callback: () => Promise<T>) {
      const invoke = async (): Promise<T> => {
        const parent = context.getStore();
        if (parent) {
          return parent.children.run(async () => {
            const savepoint = `nested_${parent.depth + 1}`;
            raw.exec(`SAVEPOINT ${savepoint}`);
            try {
              const result = await context.run({ depth: parent.depth + 1, children: new SerialQueue() }, callback);
              raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
              return result;
            } catch (error) {
              raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
              throw error;
            }
          });
        }
        return queue.run(async () => {
          raw.exec("BEGIN IMMEDIATE");
          try {
            const result = await context.run({ depth: 0, children: new SerialQueue() }, callback);
            raw.exec("COMMIT");
            return result;
          } catch (error) { raw.exec("ROLLBACK"); throw error; }
        });
      };
      return Object.assign(invoke, { immediate: invoke });
    },
    close: () => queue.run(async () => {
      if (closed) return;
      raw.close(); closed = true;
      if (filename && shared && --shared.users === 0) sqliteFiles.delete(filename);
    }),
  };
}

export function mysqlDatabase(pool: Pool): SqlDatabase {
  const context = new AsyncLocalStorage<{ connection: PoolConnection; depth: number; children: SerialQueue }>();
  return {
    dialect: "mysql",
    prepare<Parameters extends unknown[], Row>(sql: string) {
      async function rows(parameters: Parameters): Promise<Row[]> {
        const connection = context.getStore()?.connection ?? pool;
        const [result] = await connection.query<RowDataPacket[]>(sql, parameters);
        return result as Row[];
      }
      return {
        get: async (...parameters: Parameters): Promise<Row | undefined> => (await rows(parameters))[0],
        all: (...parameters: Parameters) => rows(parameters),
        async run(...parameters: Parameters) {
          const connection = context.getStore()?.connection ?? pool;
          const [result] = await connection.query<ResultSetHeader>(sql, parameters);
          return { changes: result.affectedRows };
        },
      };
    },
    transaction<T>(callback: () => Promise<T>) {
      const invoke = async (): Promise<T> => {
        const parent = context.getStore();
        if (parent) {
          return parent.children.run(async () => {
            const savepoint = `nested_${parent.depth + 1}`;
            await parent.connection.query(`SAVEPOINT ${savepoint}`);
            try {
              const result = await context.run({ connection: parent.connection, depth: parent.depth + 1, children: new SerialQueue() }, callback);
              await parent.connection.query(`RELEASE SAVEPOINT ${savepoint}`);
              return result;
            } catch (error) {
              await parent.connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              await parent.connection.query(`RELEASE SAVEPOINT ${savepoint}`);
              throw error;
            }
          });
        }
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          // Serialize multi-step repository mutations across app instances.
          await connection.query("SELECT id FROM store_transaction_lock WHERE id = 1 FOR UPDATE");
          const result = await context.run({ connection, depth: 0, children: new SerialQueue() }, callback);
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally { connection.release(); }
      };
      return Object.assign(invoke, { immediate: invoke });
    },
    async close() { await pool.end(); },
  };
}
