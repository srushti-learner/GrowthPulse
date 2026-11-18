import { createHash } from "node:crypto";
import { parse, CsvError } from "csv-parse/sync";
import { emptyProduct, importRowLimit, normalizedGtin, normalizedSku, productImageUrlSchema, productInputSchema, productPreviewSchema, type ImportRow } from "../shared/products.js";
import type { SavedScan } from "../shared/website.js";
import { CatalogueError } from "./catalogue-store.js";

const columns = ["listing_id", "name", "description", "sku", "gtin", "price", "currency", "availability", "variants"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function identity(value: { sku: string; gtin: string }, explicit = "") {
  const sku = normalizedSku(value.sku), gtin = value.gtin.trim();
  return explicit ? `id:${explicit}` : sku ? `sku:${sku}` : gtin ? `gtin:${normalizedGtin(gtin)}` : "";
}
function validate(row: number, input: unknown, sourceKey: string, reference: string, capturedAt: string, notes: string[] = [], source: "csv" | "website" = "csv"): ImportRow {
  const parsed = productInputSchema.safeParse(input);
  const errors = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".") || "product"}: ${issue.message}`);
  if (!sourceKey) errors.push(source === "website"
    ? "identity: No usable product-level URL/@id, SKU or GTIN was supplied. This record cannot be safely matched on repeat imports."
    : "Supply a stable listing_id, SKU or GTIN so repeat imports can identify this listing.");
  const preview = parsed.success ? undefined : validProductFields(input);
  return { row, sourceKey, reference, capturedAt, data: parsed.success ? parsed.data : null, preview, errors, notes };
}
function validProductFields(input: unknown) {
  const record = object(input) ? input : {};
  const fields = Object.entries(productInputSchema.shape).flatMap(([key, schema]) => {
    if (!(key in record)) return [];
    const parsed = schema.safeParse(record[key]);
    return parsed.success && parsed.data !== undefined ? [[key, parsed.data]] : [];
  });
  return productPreviewSchema.parse(Object.fromEntries(fields));
}
function duplicates(rows: ImportRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.sourceKey) counts.set(row.sourceKey, (counts.get(row.sourceKey) ?? 0) + 1);
  for (const row of rows) if ((counts.get(row.sourceKey) ?? 0) > 1) row.errors.push("Duplicate listing identity in this import. Give each source listing/variant its own listing_id.");
  return rows;
}
export function csvProducts(csv: string): ImportRow[] {
  if (Buffer.byteLength(csv, "utf8") > 49_152) throw new CatalogueError(400, "CSV must be at most 48 KiB. Split a larger catalogue into smaller files.");
  let records: string[][];
  try { records = parse(csv, { bom: true, skip_empty_lines: true, max_record_size: 12_000 }); }
  catch (error) {
    if (!(error instanceof CsvError)) throw error;
    throw new CatalogueError(400, `CSV syntax error near line ${error.lines ?? "unknown"}: ${error.message}`);
  }
  const headers = records.shift()?.map((value) => value.trim().toLowerCase()) ?? [];
  if (!headers.includes("name") || new Set(headers).size !== headers.length || headers.some((value) => !columns.includes(value))) {
    throw new CatalogueError(400, `CSV needs a unique name header. Supported headers: ${columns.join(", ")}.`);
  }
  if (!records.length || records.length > importRowLimit) throw new CatalogueError(400, `Import between 1 and ${importRowLimit} data rows at a time.`);
  const capturedAt = new Date().toISOString();
  return duplicates(records.map((record, index) => {
    const values = Object.fromEntries(headers.map((header, position) => [header, record[position]?.trim() ?? ""]));
    const input = { ...emptyProduct, ...Object.fromEntries(Object.entries(values).filter(([key]) => key !== "listing_id")) };
    const key = identity(input, values.listing_id);
    if ((values.listing_id?.length ?? 0) > 300) return { ...validate(index + 2, input, key, `CSV row ${index + 2}`, capturedAt), errors: ["listing_id must not exceed 300 characters."] };
    return validate(index + 2, input, key, `CSV row ${index + 2}`, capturedAt);
  }));
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function field(value: unknown) {
  if (value === undefined || value === null) return "";
  return typeof value === "number" ? String(value) : value;
}
function websitePrice(value: unknown, notes: string[]) {
  const price = field(value);
  if (typeof price !== "string") return price;
  const trimmed = price.trim();
  if (!/^\d{1,3}(?:,\d{3})+\.\d{1,4}$/.test(trimmed)) return price;
  const normalized = trimmed.replaceAll(",", "");
  notes.push(`Normalized published price "${trimmed}" to "${normalized}" by removing thousands separators.`);
  return normalized;
}
function productImage(value: unknown, pageUrl: string, notes: string[]) {
  if (value === undefined || value === null) return undefined;
  const images = (Array.isArray(value) ? value : [value]).slice(0, 20);
  for (const image of images) {
    const candidates = object(image) ? [image.contentUrl, image.url, image["@id"]] : [image];
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      let url: URL;
      try { url = new URL(candidate, pageUrl); }
      catch (error) { if (!(error instanceof TypeError)) throw error; continue; }
      url.hash = "";
      const parsed = productImageUrlSchema.safeParse(url.href);
      if (parsed.success) return parsed.data;
    }
  }
  notes.push("No usable public HTTPS product image was supplied; this record will use an image placeholder.");
  return undefined;
}
export function websiteProducts(scan: Pick<SavedScan, "pages">): ImportRow[] {
  const rows: ImportRow[] = [];
  for (const page of scan.pages) {
    for (const json of page.productJson ?? []) {
      if (rows.length >= importRowLimit) throw new CatalogueError(400, `This scan contains more than ${importRowLimit} structured products. Scan a smaller product/category URL.`);
      const row = rows.length + 1;
      const raw: unknown = JSON.parse(json);
      if (!object(raw)) throw new CatalogueError(400, "The saved product evidence is malformed. Rescan the website.");
      const notes: string[] = [];
      const rawOffers = raw.offers === undefined ? [] : Array.isArray(raw.offers) ? raw.offers : [raw.offers];
      const offers = rawOffers.filter((offer) => {
        if (object(offer) && String(offer["@type"] ?? "").endsWith("AggregateOffer")) { notes.push("AggregateOffer ranges are not unit prices; enter an owner price separately if needed."); return false; }
        return true;
      }).map((offer) => {
        if (!object(offer)) return offer;
        return { price: websitePrice(offer.price, notes), currency: field(offer.priceCurrency), availability: field(offer.availability) || "unknown" };
      });
      const sku = field(raw.sku);
      const gtin = field(raw.gtin ?? raw.gtin14 ?? raw.gtin13 ?? raw.gtin12 ?? raw.gtin8);
      const explicit = field(raw["@id"] ?? raw.url);
      const identifiers = { sku: typeof sku === "string" ? sku.trim() : "", gtin: typeof gtin === "string" ? gtin.trim() : "" };
      let explicitId = "";
      const identityErrors: string[] = [];
      if (!identifiers.sku && !identifiers.gtin && explicit) {
        if (typeof explicit !== "string") identityErrors.push("product URL/@id: Use a string URL or identifier.");
        else {
          try { explicitId = new URL(explicit, page.url).href; }
          catch (error) { if (!(error instanceof TypeError)) throw error; identityErrors.push("product URL/@id: The published URL is invalid."); }
        }
      }
      const stable = identity(identifiers, explicitId);
      const variants = Object.fromEntries(["size", "color", "material", "pattern"].filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]));
      const data = {
        ...emptyProduct, name: field(raw.name), description: field(raw.description), sku, gtin,
        ...(offers.length === 1 && object(offers[0]) ? offers[0] : {}), offers, variants: Object.keys(variants).length ? JSON.stringify(variants) : "",
        imageUrl: productImage(raw.image, page.url, notes),
      };
      if (offers.length > 1) notes.push("Multiple offers retained separately; no single price or availability was inferred.");
      const result = validate(row, data, stable ? hash(`${page.url}|${stable}`) : "", page.url, page.capturedAt, [...new Set(notes)], "website");
      result.errors.push(...identityErrors);
      rows.push(result);
    }
  }
  if (!rows.length) throw new CatalogueError(400, "No supported schema.org Product JSON-LD was captured. Scan a public product page again, or use CSV/manual entry. GrowthPulse does not guess products from page text.");
  // The same listing can occur on several scanned pages; retain one identical observation.
  const unique = rows.filter((row, index) => !row.sourceKey || rows.findIndex((other) => other.sourceKey === row.sourceKey
    && JSON.stringify([other.data, other.preview, other.errors]) === JSON.stringify([row.data, row.preview, row.errors])) === index);
  return duplicates(unique);
}
