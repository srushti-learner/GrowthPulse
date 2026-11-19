import { createHash } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";

const key = "VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin";
const timestamp = "VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin";
const json = "LONGTEXT";
function table(name: string, columns: string) {
  return `CREATE TABLE ${name} (rowid BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE, ${columns})
    ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`;
}
const statements = [
  table("users", `id ${key} PRIMARY KEY, name TEXT NOT NULL, email VARCHAR(254) NOT NULL UNIQUE, password_hash TEXT NOT NULL`),
  table("sessions", `token_hash ${key} PRIMARY KEY, user_id ${key} NOT NULL, expires_at BIGINT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, INDEX sessions_expiry(expires_at)`),
  table("businesses", `id ${key} PRIMARY KEY, owner_id ${key} NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
    description TEXT NOT NULL, website TEXT NOT NULL, created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL,
    FOREIGN KEY(owner_id) REFERENCES users(id), INDEX businesses_owner(owner_id)`),
  table("evidence", `id ${key} PRIMARY KEY, business_id ${key} NOT NULL, source VARCHAR(16) NOT NULL,
    reference TEXT NOT NULL, summary TEXT NOT NULL, captured_at ${timestamp} NOT NULL,
    CHECK(source IN ('manual','website','product','whatsapp')),
    FOREIGN KEY(business_id) REFERENCES businesses(id), INDEX evidence_business(business_id,captured_at)`),
  table("activities", `id ${key} PRIMARY KEY, business_id ${key} NOT NULL, evidence_id ${key} NOT NULL,
    action VARCHAR(32) NOT NULL, created_at ${timestamp} NOT NULL,
    CHECK(action IN ('business.created','business.updated','website.scanned','product.saved','products.imported')),
    FOREIGN KEY(business_id) REFERENCES businesses(id), FOREIGN KEY(evidence_id) REFERENCES evidence(id),
    INDEX activities_business(business_id,created_at)`),
  table("website_scans", `id ${key} PRIMARY KEY, business_id ${key} NOT NULL, requested_url TEXT NOT NULL,
    status VARCHAR(16) NOT NULL, started_at ${timestamp} NOT NULL, completed_at ${timestamp} NOT NULL,
    page_count INTEGER NOT NULL, result_json ${json} NOT NULL,
    CHECK(status IN ('complete','partial','failed')), CHECK(page_count BETWEEN 0 AND 20), CHECK(JSON_VALID(result_json)),
    FOREIGN KEY(business_id) REFERENCES businesses(id), INDEX scans_business(business_id,completed_at)`),
  table("products", `id ${key} PRIMARY KEY, business_id ${key} NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
    sku TEXT NOT NULL, gtin TEXT NOT NULL, sku_normalized VARCHAR(100) NOT NULL, gtin_normalized VARCHAR(14) NOT NULL,
    created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL,
    sku_key VARCHAR(100) GENERATED ALWAYS AS (NULLIF(sku_normalized,'')) STORED,
    gtin_key VARCHAR(14) GENERATED ALWAYS AS (NULLIF(gtin_normalized,'')) STORED,
    FOREIGN KEY(business_id) REFERENCES businesses(id), INDEX products_business(business_id),
    UNIQUE products_sku(business_id,sku_key), UNIQUE products_gtin(business_id,gtin_key)`),
  table("product_listings", `id ${key} PRIMARY KEY, business_id ${key} NOT NULL, product_id ${key} NOT NULL,
    source VARCHAR(16) NOT NULL, source_name TEXT NOT NULL, source_key TEXT NOT NULL, reference TEXT NOT NULL,
    captured_at ${timestamp} NOT NULL, data_json ${json} NOT NULL,
    listing_identity BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(JSON_ARRAY(source,source_name,source_key),256))) STORED,
    CHECK(source IN ('manual','csv','website')), CHECK(JSON_VALID(data_json)),
    FOREIGN KEY(business_id) REFERENCES businesses(id), FOREIGN KEY(product_id) REFERENCES products(id),
    UNIQUE listings_identity(business_id,listing_identity), INDEX listings_product(product_id)`),
  table("product_imports", `id ${key} PRIMARY KEY, business_id ${key} NOT NULL, source VARCHAR(16) NOT NULL,
    source_name TEXT NOT NULL, created_at ${timestamp} NOT NULL, rows_json ${json} NOT NULL, result_json ${json},
    CHECK(source IN ('csv','website')), CHECK(JSON_VALID(rows_json)), CHECK(result_json IS NULL OR JSON_VALID(result_json)),
    FOREIGN KEY(business_id) REFERENCES businesses(id), INDEX imports_business(business_id)`),
  table("business_understandings", `id ${key} PRIMARY KEY, business_id ${key} NOT NULL, created_at ${timestamp} NOT NULL,
    result_json ${json} NOT NULL, reviewed_at ${timestamp}, CHECK(JSON_VALID(result_json)),
    FOREIGN KEY(business_id) REFERENCES businesses(id), INDEX understandings_business(business_id,created_at)`),
  table("onboarding_previews", `token_hash ${key} PRIMARY KEY, result_json ${json} NOT NULL, expires_at BIGINT NOT NULL,
    owner_id ${key}, business_id ${key}, scan_id ${key}, CHECK(JSON_VALID(result_json)),
    FOREIGN KEY(owner_id) REFERENCES users(id), FOREIGN KEY(business_id) REFERENCES businesses(id),
    FOREIGN KEY(scan_id) REFERENCES website_scans(id), INDEX onboarding_previews_expiry(expires_at)`),
  table("analysis_jobs", `id ${key} PRIMARY KEY, owner_id ${key} NOT NULL, business_id ${key} NOT NULL,
    requested_url TEXT NOT NULL, request_key ${key} NOT NULL, input_scan_id ${key}, scan_id ${key},
    status VARCHAR(16) NOT NULL, phase VARCHAR(16) NOT NULL, preview_json ${json}, understanding_id ${key},
    error TEXT, revision INTEGER NOT NULL DEFAULT 0, lease_token ${key}, lease_until BIGINT,
    created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL,
    research_enabled INTEGER NOT NULL DEFAULT 0, resume_job_id ${key}, research_version INTEGER NOT NULL DEFAULT 1,
    active_business ${key} GENERATED ALWAYS AS (CASE WHEN status IN ('queued','running') THEN business_id ELSE NULL END) STORED,
    active_worker INTEGER GENERATED ALWAYS AS (CASE WHEN status='running' THEN 1 ELSE NULL END) STORED,
    CHECK(status IN ('queued','running','completed','failed','interrupted','cancelled')),
    CHECK(phase IN ('connecting','scanning','analysing','validating')),
    CHECK(preview_json IS NULL OR JSON_VALID(preview_json)), CHECK(research_enabled IN (0,1)), CHECK(research_version IN (1,2)),
    FOREIGN KEY(owner_id) REFERENCES users(id), FOREIGN KEY(business_id) REFERENCES businesses(id),
    FOREIGN KEY(input_scan_id) REFERENCES website_scans(id), FOREIGN KEY(scan_id) REFERENCES website_scans(id),
    FOREIGN KEY(understanding_id) REFERENCES business_understandings(id), FOREIGN KEY(resume_job_id) REFERENCES analysis_jobs(id),
    UNIQUE analysis_request(owner_id,business_id,request_key), UNIQUE analysis_active_business(active_business),
    UNIQUE analysis_single_worker(active_worker), INDEX analysis_queue(status,created_at), INDEX analysis_business(business_id,created_at)`),
  table("research_steps", `job_id ${key} NOT NULL, step_key ${key} NOT NULL, result_json ${json} NOT NULL, artifact_json ${json},
    PRIMARY KEY(job_id,step_key), CHECK(JSON_VALID(result_json)), CHECK(artifact_json IS NULL OR JSON_VALID(artifact_json)),
    FOREIGN KEY(job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE`),
  table("research_usage", `job_id ${key} PRIMARY KEY, searches INTEGER NOT NULL DEFAULT 0,
    model_calls INTEGER NOT NULL DEFAULT 0, competitor_scans INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE`),
  table("analysis_request_aliases", `owner_id ${key} NOT NULL, business_id ${key} NOT NULL, request_key ${key} NOT NULL,
    job_id ${key} NOT NULL, PRIMARY KEY(owner_id,business_id,request_key),
    FOREIGN KEY(owner_id) REFERENCES users(id), FOREIGN KEY(business_id) REFERENCES businesses(id),
    FOREIGN KEY(job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE`),
  table("growth_plan", `business_id ${key} NOT NULL, opportunity_id ${key} NOT NULL, opportunity_json ${json} NOT NULL,
    status VARCHAR(16) NOT NULL, impact TEXT NOT NULL, effort TEXT NOT NULL, time_to_value TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL,
    PRIMARY KEY(business_id,opportunity_id), CHECK(JSON_VALID(opportunity_json)),
    CHECK(status IN ('planned','in_progress','completed','dismissed')), FOREIGN KEY(business_id) REFERENCES businesses(id)`),
  table("product_analyses", `business_id ${key} NOT NULL, product_id ${key} NOT NULL, fingerprint ${key} NOT NULL,
    status VARCHAR(16) NOT NULL, lease_until BIGINT NOT NULL, result_json ${json}, completed_at ${timestamp}, error TEXT,
    active_product ${key} GENERATED ALWAYS AS (CASE WHEN status='running' THEN product_id ELSE NULL END) STORED,
    PRIMARY KEY(product_id,fingerprint), CHECK(status IN ('running','completed','failed')),
    CHECK(result_json IS NULL OR JSON_VALID(result_json)), UNIQUE product_analysis_active(active_product),
    FOREIGN KEY(business_id) REFERENCES businesses(id), FOREIGN KEY(product_id) REFERENCES products(id),
    INDEX product_analyses_business(business_id)`),
  table("sales_imports", `id ${key} PRIMARY KEY, business_id ${key} NOT NULL, filename TEXT NOT NULL,
    content_hash ${key} NOT NULL, created_at ${timestamp} NOT NULL, committed INTEGER NOT NULL DEFAULT 0,
    snapshot_json ${json} NOT NULL, CHECK(JSON_VALID(snapshot_json)), CHECK(committed IN (0,1)),
    FOREIGN KEY(business_id) REFERENCES businesses(id), INDEX sales_imports_business(business_id,created_at)`),
  table("sales_baselines", `business_id ${key} PRIMARY KEY, import_id ${key} NOT NULL,
    FOREIGN KEY(business_id) REFERENCES businesses(id), FOREIGN KEY(import_id) REFERENCES sales_imports(id)`),
  table("sales_manual", `business_id ${key} NOT NULL, date VARCHAR(10) NOT NULL, currency VARCHAR(3) NOT NULL,
    day_json ${json} NOT NULL, evidence TEXT NOT NULL, estimated INTEGER NOT NULL, created_at ${timestamp} NOT NULL,
    PRIMARY KEY(business_id,date), CHECK(JSON_VALID(day_json)), CHECK(estimated IN (0,1)),
    FOREIGN KEY(business_id) REFERENCES businesses(id)`),
  table("sales_scenarios", `id ${key} PRIMARY KEY, business_id ${key} NOT NULL, created_at ${timestamp} NOT NULL,
    baseline_version ${key} NOT NULL, input_json ${json} NOT NULL, days_json ${json} NOT NULL,
    CHECK(JSON_VALID(input_json)), CHECK(JSON_VALID(days_json)), FOREIGN KEY(business_id) REFERENCES businesses(id)`),
  table("traffic_imports", `id ${key} PRIMARY KEY, business_id ${key} NOT NULL, filename TEXT NOT NULL,
    source_name TEXT NOT NULL, content_hash ${key} NOT NULL, created_at ${timestamp} NOT NULL,
    committed INTEGER NOT NULL DEFAULT 0, snapshot_json ${json} NOT NULL,
    CHECK(committed IN (0,1)), CHECK(JSON_VALID(snapshot_json)), FOREIGN KEY(business_id) REFERENCES businesses(id),
    INDEX traffic_imports_business(business_id,created_at)`),
  table("traffic_baselines", `business_id ${key} PRIMARY KEY, import_id ${key} NOT NULL,
    FOREIGN KEY(business_id) REFERENCES businesses(id), FOREIGN KEY(import_id) REFERENCES traffic_imports(id)`),
  table("marketplace_research", `id ${key} PRIMARY KEY, business_id ${key} NOT NULL, product_id ${key} NOT NULL,
    fingerprint ${key} NOT NULL, request_key ${key} NOT NULL, input_hash ${key} NOT NULL,
    status VARCHAR(16) NOT NULL, lease_until BIGINT NOT NULL, result_json ${json}, error TEXT,
    active_product ${key} GENERATED ALWAYS AS (CASE WHEN status='running' THEN product_id ELSE NULL END) STORED,
    CHECK(status IN ('running','completed','failed')), CHECK(result_json IS NULL OR JSON_VALID(result_json)),
    UNIQUE marketplace_request(product_id,request_key), UNIQUE marketplace_research_active(active_product),
    FOREIGN KEY(business_id) REFERENCES businesses(id), FOREIGN KEY(product_id) REFERENCES products(id),
    INDEX marketplace_research_product(product_id)`),
  table("graph_checkpoints", `thread_id ${key} NOT NULL, checkpoint_ns VARCHAR(191) NOT NULL, checkpoint_id ${key} NOT NULL,
    parent_id ${key}, payload ${json} NOT NULL, metadata ${json} NOT NULL,
    PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id), CHECK(JSON_VALID(payload)), CHECK(JSON_VALID(metadata))`),
  table("graph_writes", `thread_id ${key} NOT NULL, checkpoint_ns VARCHAR(191) NOT NULL, checkpoint_id ${key} NOT NULL,
    task_id ${key} NOT NULL, write_index INTEGER NOT NULL, task_path TEXT NOT NULL, channel TEXT NOT NULL, payload ${json} NOT NULL,
    PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id,task_id,write_index), CHECK(JSON_VALID(payload))`),
  "CREATE TABLE store_transaction_lock (id INTEGER PRIMARY KEY) ENGINE=InnoDB",
  "INSERT INTO store_transaction_lock (id) VALUES (1)",
];

export async function migrateMysql(pool: Pool, databaseName: string) {
  const connection = await pool.getConnection();
  const lock = `gp-migrate-${createHash("sha256").update(databaseName).digest("hex").slice(0, 40)}`;
  let locked = false;
  try {
    const [locks] = await connection.query<(RowDataPacket & { acquired: number })[]>("SELECT GET_LOCK(?,30) AS acquired", [lock]);
    if (locks[0]?.acquired !== 1) throw new Error("Another instance is migrating MySQL. Retry after it completes.");
    locked = true;
    await connection.query(`CREATE TABLE IF NOT EXISTS mysql_schema_migrations (
      version INTEGER PRIMARY KEY, checksum CHAR(64) NOT NULL, completed INTEGER NOT NULL DEFAULT 0
    ) ENGINE=InnoDB`);
    const [applied] = await connection.query<(RowDataPacket & { version: number; checksum: string; completed: number })[]>("SELECT version,checksum,completed FROM mysql_schema_migrations");
    const migrations = [
      { version: 1, statements },
      { version: 2, statements: ["ALTER TABLE marketplace_research ADD COLUMN progress_json LONGTEXT CHECK(progress_json IS NULL OR JSON_VALID(progress_json))"] },
    ];
    if (applied.some((row) => !migrations.some((migration) => migration.version === row.version))) throw new Error("MySQL schema is newer than this application.");
    if (applied.some((row) => !row.completed)) throw new Error("A MySQL migration was interrupted. Verify the database and repair the incomplete migration before restarting; no tables were deleted.");
    for (const migration of migrations) {
      const existing = applied.find((row) => row.version === migration.version);
      if (existing && existing.checksum !== createHash("sha256").update(migration.statements.join("\n")).digest("hex")) {
        throw new Error("Applied MySQL migration checksum does not match this application.");
      }
    }
    for (const migration of migrations) {
      const checksum = createHash("sha256").update(migration.statements.join("\n")).digest("hex");
      const existing = applied.find((row) => row.version === migration.version);
      if (existing) continue;
      await connection.query("INSERT INTO mysql_schema_migrations (version,checksum,completed) VALUES (?, ?,0)", [migration.version, checksum]);
      for (const statement of migration.statements) await connection.query(statement);
      await connection.query("UPDATE mysql_schema_migrations SET completed=1 WHERE version=?", [migration.version]);
    }
  } finally {
    try { if (locked) await connection.query("SELECT RELEASE_LOCK(?)", [lock]); }
    finally { connection.release(); }
  }
}
