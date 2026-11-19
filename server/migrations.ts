import type Database from "better-sqlite3";

export const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX sessions_expiry ON sessions(expires_at);
    CREATE TABLE businesses (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      website TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX businesses_owner ON businesses(owner_id);
    CREATE TABLE evidence (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      source TEXT NOT NULL CHECK (source IN ('manual', 'website', 'product', 'whatsapp')),
      reference TEXT NOT NULL,
      summary TEXT NOT NULL,
      captured_at TEXT NOT NULL
    );
    CREATE INDEX evidence_business ON evidence(business_id, captured_at);
    CREATE TABLE activities (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      evidence_id TEXT NOT NULL REFERENCES evidence(id),
      action TEXT NOT NULL CHECK (action IN ('business.created', 'business.updated')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX activities_business ON activities(business_id, created_at);
  `,
}, {
  version: 2,
  sql: `
    CREATE TABLE website_scans (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      requested_url TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      page_count INTEGER NOT NULL CHECK (page_count BETWEEN 0 AND 5),
      result_json TEXT NOT NULL CHECK (json_valid(result_json))
    );
    CREATE INDEX scans_business ON website_scans(business_id, completed_at);
    DROP INDEX activities_business;
    ALTER TABLE activities RENAME TO activities_v1;
    CREATE TABLE activities (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      evidence_id TEXT NOT NULL REFERENCES evidence(id),
      action TEXT NOT NULL CHECK (action IN ('business.created', 'business.updated', 'website.scanned')),
      created_at TEXT NOT NULL
    );
    INSERT INTO activities SELECT * FROM activities_v1;
    DROP TABLE activities_v1;
    CREATE INDEX activities_business ON activities(business_id, created_at);
  `,
}, {
  version: 3,
  sql: `
    CREATE TABLE products (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
      name TEXT NOT NULL, description TEXT NOT NULL, sku TEXT NOT NULL, gtin TEXT NOT NULL,
      sku_normalized TEXT NOT NULL, gtin_normalized TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX products_business ON products(business_id);
    CREATE UNIQUE INDEX products_sku ON products(business_id, sku_normalized) WHERE sku_normalized != '';
    CREATE UNIQUE INDEX products_gtin ON products(business_id, gtin_normalized) WHERE gtin_normalized != '';
    CREATE TABLE product_listings (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
      product_id TEXT NOT NULL REFERENCES products(id),
      source TEXT NOT NULL CHECK (source IN ('manual', 'csv', 'website')),
      source_name TEXT NOT NULL, source_key TEXT NOT NULL, reference TEXT NOT NULL,
      captured_at TEXT NOT NULL, data_json TEXT NOT NULL CHECK (json_valid(data_json)),
      UNIQUE(business_id, source, source_name, source_key)
    );
    CREATE INDEX listings_product ON product_listings(product_id);
    CREATE TABLE product_imports (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
      source TEXT NOT NULL CHECK (source IN ('csv', 'website')), source_name TEXT NOT NULL,
      created_at TEXT NOT NULL, rows_json TEXT NOT NULL CHECK (json_valid(rows_json)),
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
    );
    CREATE INDEX imports_business ON product_imports(business_id);
    DROP INDEX activities_business;
    ALTER TABLE activities RENAME TO activities_v2;
    CREATE TABLE activities (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
      evidence_id TEXT NOT NULL REFERENCES evidence(id),
      action TEXT NOT NULL CHECK (action IN ('business.created', 'business.updated', 'website.scanned', 'product.saved', 'products.imported')),
      created_at TEXT NOT NULL
    );
    INSERT INTO activities SELECT * FROM activities_v2;
    DROP TABLE activities_v2;
    CREATE INDEX activities_business ON activities(business_id, created_at);
  `,
}, {
  version: 4,
  sql: `
    CREATE TABLE business_understandings (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
      created_at TEXT NOT NULL, result_json TEXT NOT NULL CHECK (json_valid(result_json))
    );
    CREATE INDEX understandings_business ON business_understandings(business_id, created_at);
  `,
}, {
  version: 5,
  sql: `
    ALTER TABLE business_understandings ADD COLUMN reviewed_at TEXT;
    UPDATE business_understandings
    SET reviewed_at = (SELECT updated_at FROM businesses WHERE id = business_id)
    WHERE json_array_length(result_json, '$.suggestions') > 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(result_json, '$.suggestions') suggestion
        JOIN businesses b ON b.id = business_understandings.business_id
        WHERE CASE json_extract(suggestion.value, '$.field')
          WHEN 'category' THEN b.category WHEN 'description' THEN b.description
        END IS NOT json_extract(suggestion.value, '$.value')
      );
  `,
}, {
  version: 6,
  sql: `
    CREATE TABLE onboarding_previews (
      token_hash TEXT PRIMARY KEY,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      expires_at INTEGER NOT NULL,
      owner_id TEXT REFERENCES users(id),
      business_id TEXT REFERENCES businesses(id),
      scan_id TEXT REFERENCES website_scans(id)
    );
    CREATE INDEX onboarding_previews_expiry ON onboarding_previews(expires_at);
  `,
}, {
  version: 7,
  sql: `
    CREATE TABLE website_scans_v7 (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      requested_url TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      page_count INTEGER NOT NULL CHECK (page_count BETWEEN 0 AND 20),
      result_json TEXT NOT NULL CHECK (json_valid(result_json))
    );
    INSERT INTO website_scans_v7 SELECT * FROM website_scans;
    CREATE TABLE onboarding_previews_v7 (
      token_hash TEXT PRIMARY KEY,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      expires_at INTEGER NOT NULL,
      owner_id TEXT REFERENCES users(id),
      business_id TEXT REFERENCES businesses(id),
      scan_id TEXT REFERENCES website_scans_v7(id)
    );
    INSERT INTO onboarding_previews_v7 SELECT * FROM onboarding_previews;
    DROP TABLE onboarding_previews;
    DROP TABLE website_scans;
    ALTER TABLE website_scans_v7 RENAME TO website_scans;
    ALTER TABLE onboarding_previews_v7 RENAME TO onboarding_previews;
    CREATE INDEX scans_business ON website_scans(business_id, completed_at);
    CREATE INDEX onboarding_previews_expiry ON onboarding_previews(expires_at);
  `,
}, {
  version: 8,
  sql: `
    CREATE TABLE analysis_jobs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      business_id TEXT NOT NULL REFERENCES businesses(id),
      requested_url TEXT NOT NULL,
      request_key TEXT NOT NULL,
      input_scan_id TEXT REFERENCES website_scans(id),
      scan_id TEXT REFERENCES website_scans(id),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
      phase TEXT NOT NULL CHECK (phase IN ('connecting', 'scanning', 'analysing', 'validating')),
      preview_json TEXT CHECK (preview_json IS NULL OR json_valid(preview_json)),
      understanding_id TEXT REFERENCES business_understandings(id),
      error TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_until INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_id, business_id, request_key)
    );
    CREATE INDEX analysis_queue ON analysis_jobs(status, created_at);
    CREATE INDEX analysis_business ON analysis_jobs(business_id, created_at);
    CREATE UNIQUE INDEX analysis_active_business ON analysis_jobs(business_id) WHERE status IN ('queued', 'running');
    CREATE UNIQUE INDEX analysis_single_worker ON analysis_jobs((1)) WHERE status = 'running';
  `,
}, {
  version: 9,
  sql: `
    ALTER TABLE analysis_jobs ADD COLUMN research_enabled INTEGER NOT NULL DEFAULT 0 CHECK (research_enabled IN (0, 1));
    ALTER TABLE analysis_jobs ADD COLUMN resume_job_id TEXT REFERENCES analysis_jobs(id);
    CREATE TABLE research_steps (
      job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
      step_key TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      artifact_json TEXT CHECK (artifact_json IS NULL OR json_valid(artifact_json)),
      PRIMARY KEY (job_id, step_key)
    );
    CREATE TABLE research_usage (
      job_id TEXT PRIMARY KEY REFERENCES analysis_jobs(id) ON DELETE CASCADE,
      searches INTEGER NOT NULL DEFAULT 0,
      model_calls INTEGER NOT NULL DEFAULT 0,
      competitor_scans INTEGER NOT NULL DEFAULT 0
    );
  `,
}, {
  version: 10,
  sql: `ALTER TABLE analysis_jobs ADD COLUMN research_version INTEGER NOT NULL DEFAULT 1 CHECK (research_version IN (1, 2));`,
}, {
  version: 11,
  sql: `
    CREATE TABLE analysis_request_aliases (
      owner_id TEXT NOT NULL REFERENCES users(id), business_id TEXT NOT NULL REFERENCES businesses(id),
      request_key TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
      PRIMARY KEY (owner_id, business_id, request_key)
    );
    CREATE TABLE growth_plan (
      business_id TEXT NOT NULL REFERENCES businesses(id), opportunity_id TEXT NOT NULL,
      opportunity_json TEXT NOT NULL CHECK (json_valid(opportunity_json)),
      status TEXT NOT NULL CHECK (status IN ('planned', 'in_progress', 'completed', 'dismissed')),
      impact TEXT NOT NULL, effort TEXT NOT NULL, time_to_value TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (business_id, opportunity_id)
    );
  `,
}, {
  version: 12,
  sql: `
    CREATE TABLE product_analyses (
      business_id TEXT NOT NULL REFERENCES businesses(id),
      product_id TEXT NOT NULL REFERENCES products(id),
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      lease_until INTEGER NOT NULL,
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      completed_at TEXT,
      error TEXT,
      PRIMARY KEY (product_id, fingerprint)
    );
    CREATE INDEX product_analyses_business ON product_analyses(business_id);
    CREATE UNIQUE INDEX product_analysis_active ON product_analyses(product_id) WHERE status = 'running';
  `,
}, {
  version: 13,
  sql: `
    CREATE TABLE sales_imports (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
      filename TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      committed INTEGER NOT NULL DEFAULT 0, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
    );
    CREATE INDEX sales_imports_business ON sales_imports(business_id, created_at);
    CREATE TABLE sales_baselines (
      business_id TEXT PRIMARY KEY REFERENCES businesses(id),
      import_id TEXT NOT NULL REFERENCES sales_imports(id)
    );
    CREATE TABLE sales_manual (
      business_id TEXT NOT NULL REFERENCES businesses(id), date TEXT NOT NULL,
      currency TEXT NOT NULL, day_json TEXT NOT NULL CHECK(json_valid(day_json)),
      evidence TEXT NOT NULL, estimated INTEGER NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(business_id,date)
    );
    CREATE TABLE sales_scenarios (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
      created_at TEXT NOT NULL, baseline_version TEXT NOT NULL,
      input_json TEXT NOT NULL CHECK(json_valid(input_json)),
      days_json TEXT NOT NULL CHECK(json_valid(days_json))
    );
    CREATE TABLE traffic_imports (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
      filename TEXT NOT NULL, source_name TEXT NOT NULL, content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0,
      snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
    );
    CREATE INDEX traffic_imports_business ON traffic_imports(business_id,created_at);
    CREATE TABLE traffic_baselines (
      business_id TEXT PRIMARY KEY REFERENCES businesses(id),
      import_id TEXT NOT NULL REFERENCES traffic_imports(id)
    );
  `,
}, {
  version: 14,
  sql: `
    CREATE TABLE marketplace_research (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
      product_id TEXT NOT NULL REFERENCES products(id), fingerprint TEXT NOT NULL,
      request_key TEXT NOT NULL, input_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
      lease_until INTEGER NOT NULL,
      result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), error TEXT,
      UNIQUE(product_id, request_key)
    );
    CREATE INDEX marketplace_research_product ON marketplace_research(product_id);
    CREATE UNIQUE INDEX marketplace_research_active ON marketplace_research(product_id) WHERE status = 'running';
  `,
}, {
  version: 15,
  sql: `
    CREATE TABLE graph_checkpoints (
      thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
      parent_id TEXT, payload TEXT NOT NULL, metadata TEXT NOT NULL,
      PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id)
    );
    CREATE TABLE graph_writes (
      thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
      task_id TEXT NOT NULL, write_index INTEGER NOT NULL, task_path TEXT NOT NULL,
      channel TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id, task_id, write_index)
    );
  `,
}, {
  version: 16,
  sql: "CREATE TABLE IF NOT EXISTS graph_checkpoint_imports (name TEXT PRIMARY KEY);",
}, {
  version: 17,
  sql: "ALTER TABLE marketplace_research ADD COLUMN progress_json TEXT CHECK(progress_json IS NULL OR json_valid(progress_json));",
}];

export function migrate(database: Database.Database) {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  const applied = database.prepare<[], { version: number }>("SELECT version FROM schema_migrations").all();
  if (applied.some(({ version }) => !migrations.some((migration) => migration.version === version))) {
    throw new Error("Database schema is newer than this application. Use a matching application version.");
  }
  for (const migration of migrations) {
    if (applied.some(({ version }) => version === migration.version)) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
    })();
  }
}
