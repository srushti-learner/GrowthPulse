import { createPool } from "mysql2/promise";
import { createStore } from "./database.js";
import { mysqlDatabase } from "./sql-database.js";
import { SqlCheckpointSaver } from "./sql-checkpointer.js";
import { migrateMysql } from "./mysql-migrations.js";
import type { MysqlSettings } from "./config.js";

export async function openMysqlStore(config: MysqlSettings) {
  const pool = createPool({
    host: config.DB_HOST, port: config.DB_PORT, database: config.DB_NAME,
    user: config.DB_USER, password: config.DB_PASSWORD,
    ssl: config.DB_SSL_MODE === "required" ? { rejectUnauthorized: true, ...(config.DB_SSL_CA ? { ca: config.DB_SSL_CA } : {}) } : undefined,
    connectionLimit: 5, maxIdle: 5, idleTimeout: 60_000, waitForConnections: true, queueLimit: 100,
    connectTimeout: 10_000, charset: "utf8mb4", timezone: "Z",
    supportBigNumbers: true, bigNumberStrings: false, multipleStatements: false,
  });
  try {
    const [rows] = await pool.query("SELECT VERSION() AS version");
    const row = Array.isArray(rows) ? rows[0] : undefined;
    const version = row && typeof row === "object" && "version" in row ? String(row.version) : "";
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match || /mariadb/i.test(version) || Number(match[1]) < 8
      || Number(match[1]) === 8 && Number(match[2]) === 0 && Number(match[3]) < 16) {
      throw new Error("GrowthPulse requires MySQL 8.0.16 or newer (not MariaDB) with enforced CHECK constraints.");
    }
    await migrateMysql(pool, config.DB_NAME);
    const database = mysqlDatabase(pool);
    const store = createStore(database, new SqlCheckpointSaver(database));
    await store.checkHealth();
    return store;
  } catch (error) {
    await pool.end();
    if (error instanceof Error && "code" in error) {
      const code = typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "DATABASE_ERROR";
      throw new Error(`MySQL startup failed (${code}). Check database attachment, connectivity, TLS and schema permissions; credentials were not logged.`);
    }
    throw error;
  }
}
