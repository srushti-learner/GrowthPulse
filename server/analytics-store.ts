import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { analyticsDataSchema, dailySalesSchema, manualSalesSchema, salesImportSchema, salesSnapshotSchema, savedScenarioSchema, scenarioInputSchema, type DailySales, type SalesSnapshot } from "../shared/analytics.js";
import { trafficImportSchema, trafficSnapshotSchema, trafficSourceSchema, type TrafficSnapshot } from "../shared/traffic.js";
import { scenarioDays } from "../shared/analytics-math.js";
import { SalesError } from "./sales-imports.js";

type ImportRecord = { id: string; filename: string; createdAt: string; committed: number; json: string };
export function analyticsStore(database: Database.Database) {
  function owned(ownerId: string, businessId: string) {
    if (!database.prepare("SELECT id FROM businesses WHERE id=? AND owner_id=?").get(businessId, ownerId)) throw new SalesError(404, "Business not found.");
  }
  function importRecord(businessId: string, id: string) {
    const row = database.prepare<[string, string], ImportRecord>("SELECT id,filename,created_at AS createdAt,committed,snapshot_json AS json FROM sales_imports WHERE business_id=? AND id=?").get(businessId, id);
    if (!row) throw new SalesError(404, "Sales import not found.");
    return salesImportSchema.parse({ ...row, committed: !!row.committed, snapshot: salesSnapshotSchema.parse(JSON.parse(row.json)) });
  }
  function trafficRecord(businessId: string, id: string) {
    const row = database.prepare<[string, string], ImportRecord & { sourceName: string }>("SELECT id,filename,source_name AS sourceName,created_at AS createdAt,committed,snapshot_json AS json FROM traffic_imports WHERE business_id=? AND id=?").get(businessId, id);
    if (!row) throw new SalesError(404, "Traffic import not found.");
    return trafficImportSchema.parse({ ...row, committed: !!row.committed, snapshot: trafficSnapshotSchema.parse(JSON.parse(row.json)) });
  }
  function checkTrafficAlignment(days: DailySales[], traffic: TrafficSnapshot) {
    if (!days.length) return;
    const byDate = new Map(traffic.days.map((day) => [day.date, day]));
    if (!days.some((day) => byDate.has(day.date))) throw new SalesError(409, "Sales and traffic have no overlapping dates. Use matching exports from the same business, or separate workspaces.");
    if (days.some((day) => {
      const visits = byDate.get(day.date);
      return visits && ((day.sessions !== null && day.sessions !== visits.sessions) || (day.purchasingSessions !== null && day.purchasingSessions !== visits.purchasingSessions));
    })) throw new SalesError(409, "Imported traffic conflicts with owner-entered traffic on the same date. Existing records were not overwritten.");
  }
  function data(ownerId: string, businessId: string) {
    owned(ownerId, businessId);
    const active = database.prepare<[string], { id: string }>("SELECT import_id AS id FROM sales_baselines WHERE business_id=?").get(businessId);
    const imported = active ? importRecord(businessId, active.id) : null;
    const activeTraffic = database.prepare<[string], { id: string }>("SELECT import_id AS id FROM traffic_baselines WHERE business_id=?").get(businessId);
    const traffic = activeTraffic ? trafficRecord(businessId, activeTraffic.id) : null;
    const manual = database.prepare<[string], { currency: string; json: string; evidence: string; estimated: number; createdAt: string }>(
      "SELECT currency,day_json AS json,evidence,estimated,created_at AS createdAt FROM sales_manual WHERE business_id=? ORDER BY date").all(businessId);
    const days = [...(imported?.snapshot.days ?? []), ...manual.map((row) => dailySalesSchema.parse(JSON.parse(row.json)))].sort((a, b) => a.date.localeCompare(b.date));
    const version = createHash("sha256").update(JSON.stringify({ active, manual, ...(activeTraffic ? { activeTraffic } : {}) })).digest("hex").slice(0, 24);
    const scenarioRows = database.prepare<[string], { id: string; createdAt: string; baselineVersion: string; input: string; days: string }>(
      "SELECT id,created_at AS createdAt,baseline_version AS baselineVersion,input_json AS input,days_json AS days FROM sales_scenarios WHERE business_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10").all(businessId);
    return analyticsDataSchema.parse({
      version, currency: imported?.snapshot.currency ?? manual[0]?.currency ?? null, traffic,
      days, products: imported?.snapshot.products ?? [],
      imports: database.prepare<[string], Omit<ImportRecord, "json">>("SELECT id,filename,created_at AS createdAt,committed FROM sales_imports WHERE business_id=? ORDER BY rowid DESC LIMIT 10").all(businessId).map((row) => ({ ...row, committed: !!row.committed })),
      scenarios: scenarioRows.map((row) => savedScenarioSchema.parse({ ...row, input: JSON.parse(row.input), days: JSON.parse(row.days) })),
      sources: [...(imported ? [{ name: imported.filename, kind: "import", createdAt: imported.createdAt }] : []), ...manual.map((row) => ({ name: row.evidence, kind: row.estimated ? "estimate" : "manual", createdAt: row.createdAt }))],
      warnings: [...(imported?.snapshot.warnings ?? []), ...(imported?.snapshot.rejected ? [`${imported.snapshot.rejected} source rows were rejected. This baseline includes accepted rows only; the import preview required acknowledgement.`] : [])],
    });
  }
  return {
    salesData: data,
    previewSales(ownerId: string, businessId: string, filename: string, hash: string, input: SalesSnapshot) {
      owned(ownerId, businessId);
      const snapshot = salesSnapshotSchema.parse(input);
      const existing = database.prepare<[string, string, string], { id: string }>("SELECT id FROM sales_imports WHERE business_id=? AND content_hash=? AND json_extract(snapshot_json,'$.currency')=? ORDER BY rowid DESC LIMIT 1").get(businessId, hash, snapshot.currency);
      if (existing) return importRecord(businessId, existing.id);
      const id = randomUUID();
      database.prepare("INSERT INTO sales_imports VALUES (?,?,?,?,?,0,?)").run(id, businessId, filename, hash, new Date().toISOString(), JSON.stringify(snapshot));
      return importRecord(businessId, id);
    },
    commitSales(ownerId: string, businessId: string, importId: string, expectedVersion: string, confirmRejected: boolean) {
      return database.transaction(() => {
        const current = data(ownerId, businessId), draft = importRecord(businessId, importId);
        if (draft.committed) return current;
        if (current.version !== expectedVersion) throw new SalesError(409, "History changed while reviewing. Reload and review this import again.");
        if (draft.snapshot.rejected && !confirmRejected) throw new SalesError(400, "Explicitly acknowledge rejected rows before importing.");
        const manual = database.prepare<[string], { date: string; currency: string }>("SELECT date,currency FROM sales_manual WHERE business_id=?").all(businessId);
        if (manual.some((row) => row.currency !== draft.snapshot.currency || draft.snapshot.days.some((day) => day.date === row.date))) throw new SalesError(409, "This import overlaps owner-entered dates or uses a different currency. Use a separate business workspace.");
        if (current.traffic) checkTrafficAlignment(draft.snapshot.days, current.traffic.snapshot);
        database.prepare("INSERT INTO sales_baselines VALUES (?,?) ON CONFLICT(business_id) DO UPDATE SET import_id=excluded.import_id").run(businessId, importId);
        database.prepare("UPDATE sales_imports SET committed=1 WHERE id=?").run(importId);
        return data(ownerId, businessId);
      })();
    },
    saveManualSales(ownerId: string, businessId: string, input: unknown, expectedVersion: string) {
      const entry = manualSalesSchema.parse(input);
      return database.transaction(() => {
        const current = data(ownerId, businessId);
        if (current.version !== expectedVersion) throw new SalesError(409, "History changed. Reload before saving.");
        if (entry.day.date > new Date().toISOString().slice(0, 10)) throw new SalesError(400, "Owner-entered history cannot be in the future. Use a scenario.");
        if (current.currency && current.currency !== entry.currency) throw new SalesError(409, "Keep one currency per business. Currency conversion is not supported.");
        if (current.days.some((day) => day.date === entry.day.date)) throw new SalesError(409, "That date already has data. Existing history is not overwritten; choose an unrecorded date or use a scenario.");
        if (current.traffic?.snapshot.days.some((day) => day.date === entry.day.date)) checkTrafficAlignment([entry.day], current.traffic.snapshot);
        database.prepare("INSERT INTO sales_manual VALUES (?,?,?,?,?,?,?)").run(businessId, entry.day.date, entry.currency, JSON.stringify(entry.day), entry.evidence, Number(entry.estimated), new Date().toISOString());
        return data(ownerId, businessId);
      })();
    },
    saveSalesScenario(ownerId: string, businessId: string, input: unknown, expectedVersion: string) {
      const parsed = scenarioInputSchema.parse(input);
      return database.transaction(() => {
        const current = data(ownerId, businessId);
        if (current.version !== expectedVersion) throw new SalesError(409, "History changed. Reload before saving this scenario.");
        if (!current.days.some((day) => day.date >= parsed.start && day.date <= parsed.end)) throw new SalesError(400, "Choose a scenario range containing recorded dates.");
        database.prepare("INSERT INTO sales_scenarios VALUES (?,?,?,?,?,?)").run(randomUUID(), businessId, new Date().toISOString(), current.version, JSON.stringify(parsed), JSON.stringify(scenarioDays(current.days, parsed)));
        return data(ownerId, businessId);
      })();
    },
    previewTraffic(ownerId: string, businessId: string, filename: string, sourceName: string, hash: string, input: TrafficSnapshot) {
      owned(ownerId, businessId);
      const snapshot = trafficSnapshotSchema.parse(input);
      const source = trafficSourceSchema.parse(sourceName);
      const existing = database.prepare<[string, string, string], { id: string }>("SELECT id FROM traffic_imports WHERE business_id=? AND content_hash=? AND source_name=? ORDER BY rowid DESC LIMIT 1").get(businessId, hash, source);
      if (existing) return trafficRecord(businessId, existing.id);
      const id = randomUUID();
      database.prepare("INSERT INTO traffic_imports VALUES (?,?,?,?,?,?,0,?)").run(id, businessId, filename, source, hash, new Date().toISOString(), JSON.stringify(snapshot));
      return trafficRecord(businessId, id);
    },
    commitTraffic(ownerId: string, businessId: string, importId: string, expectedVersion: string, sameBusiness: boolean) {
      return database.transaction(() => {
        const current = data(ownerId, businessId), draft = trafficRecord(businessId, importId);
        if (draft.committed) return current;
        if (current.version !== expectedVersion) throw new SalesError(409, "History changed while reviewing traffic. Reload and review again.");
        if (!sameBusiness) throw new SalesError(400, "Confirm that this traffic describes the same business and sales channel.");
        checkTrafficAlignment(current.days, draft.snapshot);
        database.prepare("INSERT INTO traffic_baselines VALUES (?,?) ON CONFLICT(business_id) DO UPDATE SET import_id=excluded.import_id").run(businessId, importId);
        database.prepare("UPDATE traffic_imports SET committed=1 WHERE id=?").run(importId);
        return data(ownerId, businessId);
      })();
    },
  };
}
