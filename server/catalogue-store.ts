import type { SqlDatabase } from "./sql-database.js";
import { randomUUID } from "node:crypto";
import { catalogueLimit, decisionsSchema, importDraftSchema, importResultSchema, importRowSchema, normalizedGtin, normalizedSku, productInputSchema, productSchema, type ImportRow, type Product, type ProductInput } from "../shared/products.js";
import { scanLimits, type ScanResult } from "../shared/website.js";
import { websiteProducts } from "./product-imports.js";

export class CatalogueError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type DraftRecord = { id: string; businessId: string; source: "csv" | "website"; sourceName: string; createdAt: string; rows: string; result: string | null };
function identifierMatch(product: Product, data: ProductInput) {
  return [product, ...product.listings.map((item) => item.data)].some((item) =>
    (!!data.sku && normalizedSku(item.sku) === normalizedSku(data.sku)) || (!!data.gtin && normalizedGtin(item.gtin) === normalizedGtin(data.gtin)));
}
function conflictingGtin(product: Product, data: ProductInput) {
  return !!data.gtin && [product, ...product.listings.map((item) => item.data)].some((item) => !!item.gtin && normalizedGtin(item.gtin) !== normalizedGtin(data.gtin));
}
function matchProduct(catalogue: Product[], row: ImportRow, source: string, sourceName: string) {
  const repeat = catalogue.find((product) => product.listings.some((item) => item.source === source && item.sourceName === sourceName && item.sourceKey === row.sourceKey));
  if (repeat) {
    const conflict = !!row.data && conflictingGtin(repeat, row.data);
    return { row: row.row, kind: conflict ? "review" as const : "repeat" as const, productId: conflict ? null : repeat.id, candidates: [repeat.id] };
  }
  const data = row.data;
  const candidates = data ? catalogue.filter((product) => identifierMatch(product, data)) : [];
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  const confident = !!candidate && !!data && !conflictingGtin(candidate, data);
  const similar = data ? catalogue.some((product) => product.name.toLowerCase() === data.name.toLowerCase()) : false;
  return { row: row.row, kind: confident ? "identifier" as const : candidates.length || similar ? "review" as const : "new" as const,
    productId: confident ? candidate.id : null, candidates: candidates.map((product) => product.id) };
}
export function catalogueStore(database: SqlDatabase) {
  async function owned(ownerId: string, businessId: string) {
    if (!await database.prepare("SELECT id FROM businesses WHERE id = ? AND owner_id = ?").get(businessId, ownerId)) throw new CatalogueError(404, "Business not found.");
  }
  async function products(businessId: string, productId?: string) {
    const rows = await database.prepare(`SELECT id, business_id AS businessId, name, description, sku, gtin, created_at AS createdAt, updated_at AS updatedAt
      FROM products WHERE business_id = ?${productId ? " AND id = ?" : ""} ORDER BY created_at, rowid`).all(...(productId ? [businessId, productId] : [businessId]));
    const result: Product[] = [];
    for (const row of rows) {
      const base = productSchema.omit({ listings: true }).parse(row);
      const listings = await database.prepare< [string], { id: string; source: string; sourceName: string; sourceKey: string; reference: string; capturedAt: string; json: string }>(
        `SELECT id, source, source_name AS sourceName, source_key AS sourceKey, reference, captured_at AS capturedAt, data_json AS json FROM product_listings WHERE product_id = ? ORDER BY rowid`).all(base.id);
      result.push(productSchema.parse({ ...base, listings: listings.map(({ json, ...listing }) => ({ ...listing, data: JSON.parse(json) })) }));
    }
    return result;
  }
  async function checkIdentifiers(businessId: string, data: ProductInput, except = "") {
    const found = await database.prepare(`SELECT id FROM products WHERE business_id = ? AND id != ?
      AND ((? != '' AND sku_normalized = ?) OR (? != '' AND gtin_normalized = ?))`)
      .get(businessId, except, normalizedSku(data.sku), normalizedSku(data.sku), normalizedGtin(data.gtin), normalizedGtin(data.gtin));
    if (found) throw new CatalogueError(409, "That SKU or GTIN belongs to an existing catalogue product. Edit it or explicitly link this listing to it.");
  }
  async function createProduct(businessId: string, data: ProductInput, now: string) {
    const count = (await database.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM products WHERE business_id = ?").get(businessId))!.count;
    if (count >= catalogueLimit) throw new CatalogueError(409, `This local catalogue is limited to ${catalogueLimit} products per business.`);
    await checkIdentifiers(businessId, data);
    const id = randomUUID();
    await database.prepare("INSERT INTO products (id,business_id,name,description,sku,gtin,sku_normalized,gtin_normalized,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, businessId, data.name, data.description, data.sku, data.gtin, normalizedSku(data.sku), normalizedGtin(data.gtin), now, now);
    return id;
  }
  async function listing(businessId: string, productId: string, source: string, sourceName: string, row: ImportRow) {
    const existing = await database.prepare<[string, string, string, string], { id: string; productId: string; capturedAt: string }>(
      "SELECT id, product_id AS productId, captured_at AS capturedAt FROM product_listings WHERE business_id = ? AND source = ? AND source_name = ? AND source_key = ?")
      .get(businessId, source, sourceName, row.sourceKey);
    if (existing && existing.productId !== productId) throw new CatalogueError(409, `Row ${row.row}: this source listing is already linked to another product. Keep its existing target or skip it.`);
    if (existing && existing.capturedAt > row.capturedAt) throw new CatalogueError(409, `Row ${row.row}: an older observation cannot overwrite a newer source listing. Use a newer scan/preview or skip this row.`);
    await database.prepare(`INSERT INTO product_listings (id,business_id,product_id,source,source_name,source_key,reference,captured_at,data_json) VALUES (?,?,?,?,?,?,?,?,?)
      ${database.dialect === "mysql"
        ? "ON DUPLICATE KEY UPDATE reference=VALUES(reference),captured_at=VALUES(captured_at),data_json=VALUES(data_json)"
        : "ON CONFLICT(business_id,source,source_name,source_key) DO UPDATE SET reference=excluded.reference,captured_at=excluded.captured_at,data_json=excluded.data_json"}`)
      .run(existing?.id ?? randomUUID(), businessId, productId, source, sourceName, row.sourceKey, row.reference, row.capturedAt, JSON.stringify(row.data));
    return !!existing;
  }
  async function activity(businessId: string, action: "product.saved" | "products.imported", reference: string, summary: string, now: string) {
    const evidenceId = randomUUID();
    await database.prepare("INSERT INTO evidence (id,business_id,source,reference,summary,captured_at) VALUES (?,?,'product',?,?,?)")
      .run(evidenceId, businessId, reference, summary.slice(0, 2000), now);
    await database.prepare("INSERT INTO activities (id,business_id,evidence_id,action,created_at) VALUES (?,?,?,?,?)").run(randomUUID(), businessId, evidenceId, action, now);
  }
  async function record(ownerId: string, businessId: string, id: string) {
    await owned(ownerId, businessId);
    const draft = await database.prepare<[string, string], DraftRecord>(`SELECT id,business_id AS businessId,source,source_name AS sourceName,created_at AS createdAt,rows_json AS \`rows\`,result_json AS result FROM product_imports WHERE business_id=? AND id=?`).get(businessId, id);
    if (!draft) throw new CatalogueError(404, "Import not found.");
    return draft;
  }
  async function preview(draft: DraftRecord) {
    const rows = importRowSchema.array().parse(JSON.parse(draft.rows));
    const catalogue = await products(draft.businessId);
    const matches = rows.map((row) => matchProduct(catalogue, row, draft.source, draft.sourceName));
    return importDraftSchema.parse({ ...draft, rows, matches, committed: !!draft.result });
  }
  return {
    async syncWebsiteProducts(ownerId: string, businessId: string, scan: ScanResult) {
      return database.transaction(async () => {
        await owned(ownerId, businessId);
        if (!scan.pages.some((page) => page.productJson?.length) || scan.status === "failed") return undefined;
        const rows = websiteProducts(scan, scanLimits.pages * 50);
        const sourceName = new URL(scan.requestedUrl).hostname.replace(/^www\./, "");
        const result: NonNullable<ScanResult["catalogue"]> = { created: 0, updated: 0, unchanged: 0, skipped: 0, issues: [] };
        const now = new Date().toISOString();
        let catalogue = await products(businessId);
        for (const row of rows) {
          const skip = (message: string) => {
            result.skipped++;
            result.issues.push({ reference: row.reference, name: row.data?.name ?? row.preview?.name ?? "Unnamed product record", message });
          };
          if (!row.data || row.errors.length) { skip(row.errors.join(" ")); continue; }
          const match = matchProduct(catalogue, row, "website", sourceName);
          if (match.kind === "review") { skip("Uncertain or conflicting catalogue match. Review this record in Products; no automatic merge was made."); continue; }
          const existing = catalogue.find((product) => product.id === match.productId);
          const previous = existing?.listings.find((item) => item.source === "website" && item.sourceName === sourceName && item.sourceKey === row.sourceKey);
          if (previous && previous.capturedAt > row.capturedAt) { skip("Older website evidence cannot replace a newer listing."); continue; }
          if (previous?.capturedAt === row.capturedAt) {
            if (JSON.stringify(previous.data) === JSON.stringify(row.data)) result.unchanged++;
            else skip("Conflicting records have the same capture time. The existing listing was preserved.");
            continue;
          }
          if (!existing && catalogue.length >= catalogueLimit) { skip(`The catalogue limit of ${catalogueLimit} products was reached.`); continue; }
          const id = existing?.id ?? await createProduct(businessId, row.data, now);
          if (!existing) result.created++;
          await listing(businessId, id, "website", sourceName, row);
          if (existing) result.updated++;
          const [saved] = await products(businessId, id);
          catalogue = [...catalogue.filter((product) => product.id !== id), saved];
        }
        if (result.created || result.updated) {
          await activity(businessId, "products.imported", scan.requestedUrl,
            `Website scan catalogue: ${result.created} products created, ${result.updated} listings refreshed, ${result.skipped} records skipped. Owner-entered product details were preserved.`, now);
        }
        return result;
      })();
    },
    async listProducts(ownerId: string, businessId: string) { await owned(ownerId, businessId); return products(businessId); },
    async getProduct(ownerId: string, businessId: string, productId: string) {
      await owned(ownerId, businessId);
      return (await products(businessId, productId))[0];
    },
    async saveProduct(ownerId: string, businessId: string, input: ProductInput, existingId?: string) {
      const data = productInputSchema.parse(input);
      return database.transaction(async () => {
        await owned(ownerId, businessId);
        const now = new Date().toISOString();
        if (existingId && !await database.prepare("SELECT id FROM products WHERE business_id=? AND id=?").get(businessId, existingId)) throw new CatalogueError(404, "Product not found.");
        const id = existingId ?? await createProduct(businessId, data, now);
        if (existingId) {
          await checkIdentifiers(businessId, data, id);
          await database.prepare("UPDATE products SET name=?,description=?,sku=?,gtin=?,sku_normalized=?,gtin_normalized=?,updated_at=? WHERE id=? AND business_id=?")
            .run(data.name, data.description, data.sku, data.gtin, normalizedSku(data.sku), normalizedGtin(data.gtin), now, id, businessId);
        }
        await listing(businessId, id, "manual", "Owner", { row: 1, sourceKey: id, reference: `products/${id}`, capturedAt: now, data, errors: [], notes: [] });
        await activity(businessId, "product.saved", `products/${id}`, `Owner-entered product snapshot: ${JSON.stringify(data)}`, now);
        return (await products(businessId)).find((product) => product.id === id)!;
      })();
    },
    async createProductImport(ownerId: string, businessId: string, source: "csv" | "website", sourceName: string, rows: ImportRow[]) {
      return database.transaction(async () => {
        await owned(ownerId, businessId);
        const parsed = importRowSchema.array().min(1).max(100).parse(rows);
        const id = randomUUID();
        await database.prepare("INSERT INTO product_imports (id,business_id,source,source_name,created_at,rows_json,result_json) VALUES (?,?,?,?,?,?,NULL)").run(id, businessId, source, sourceName, new Date().toISOString(), JSON.stringify(parsed));
        return preview(await record(ownerId, businessId, id));
      })();
    },
    async getProductImport(ownerId: string, businessId: string, id: string) { return preview(await record(ownerId, businessId, id)); },
    async commitProductImport(ownerId: string, businessId: string, id: string, input: unknown) {
      const { decisions } = decisionsSchema.parse(input);
      return database.transaction(async () => {
        const draft = await record(ownerId, businessId, id);
        if (draft.result) return importResultSchema.parse({ result: JSON.parse(draft.result) }).result;
        const rows = importRowSchema.array().parse(JSON.parse(draft.rows));
        if (decisions.length !== rows.length || new Set(decisions.map((item) => item.row)).size !== rows.length || decisions.some((item) => !rows.some((row) => row.row === item.row))) {
          throw new CatalogueError(400, "Provide one decision for every preview row, including skip for invalid rows.");
        }
        const result = { imported: 0, skipped: 0, created: 0, updated: 0 };
        const createdIds = new Set<string>();
        const now = new Date().toISOString();
        for (const decision of decisions) {
          const row = rows.find((item) => item.row === decision.row)!;
          if (decision.action === "skip") { result.skipped++; continue; }
          if (!row.data || row.errors.length) throw new CatalogueError(400, `Row ${row.row}: fix the source data and preview again, or skip this invalid row.`);
          let productId: string;
          if (decision.action === "new") {
            const data = row.data;
            const matches = (await products(businessId)).filter((product) => createdIds.has(product.id) && identifierMatch(product, data));
            const match = matches.length === 1 ? matches[0] : undefined;
            if (match && createdIds.has(match.id) && !conflictingGtin(match, data)) productId = match.id;
            else { productId = await createProduct(businessId, row.data, now); createdIds.add(productId); result.created++; }
          }
          else {
            productId = decision.productId;
            if (!await database.prepare("SELECT id FROM products WHERE business_id=? AND id=?").get(businessId, productId)) throw new CatalogueError(404, `Row ${row.row}: target product not found in this business.`);
          }
          if (await listing(businessId, productId, draft.source, draft.sourceName, row)) result.updated++;
          result.imported++;
        }
        await activity(businessId, "products.imported", `product-imports/${id}`, `${draft.source} import "${draft.sourceName}": ${result.imported} listings imported, ${result.created} products created, ${result.updated} listings refreshed, ${result.skipped} rows skipped. Full source snapshots retained in import ${id}.`, now);
        await database.prepare("UPDATE product_imports SET result_json=? WHERE id=?").run(JSON.stringify(result), id);
        return result;
      })();
    },
  };
}
