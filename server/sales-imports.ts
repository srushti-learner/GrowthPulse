import { createHash } from "node:crypto";
import { PassThrough, Readable, Transform } from "node:stream";
import ExcelJS from "exceljs";
import { ZipArchive } from "archiver";
import { Open } from "unzipper";
import { parse, CsvError } from "csv-parse";
import { analyticsCurrency, moneyScale, salesSnapshotSchema, type DailySales, type SalesSnapshot } from "../shared/analytics.js";
import { requiredSalesFields, salesMappingSchema, type SalesField, type SalesMapping } from "../shared/sales-mapping.js";

export class SalesError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const headerKey = (value: string) => value.toLowerCase().replace(/[\s_-]/g, "");
const names: Record<string, SalesField> = {
  invoiceno: "order", invoice: "order", orderid: "order",
  ordernumber: "order", invoicenumber: "order",
  invoicedate: "date", orderdate: "date", saledate: "date", date: "date", stockcode: "sku", sku: "sku",
  description: "name", product: "name", productname: "name", quantity: "quantity", qty: "quantity",
  unitprice: "price", unitsellingprice: "price", price: "price", discount: "discount",
  currency: "currency", status: "status",
};
function mappedHeader(header: string): SalesField | null {
  const key = headerKey(header);
  return Object.hasOwn(names, key) ? names[key] : null;
}
function suggestMapping(headers: string[]): SalesMapping {
  const suggested = headers.map(mappedHeader);
  return suggested.map((field) => field && suggested.filter((candidate) => candidate === field).length === 1 ? field : null);
}
function approvedMapping(headers: string[], mapping?: SalesMapping): SalesMapping {
  const columns = mapping === undefined ? headers.map(mappedHeader) : salesMappingSchema.parse(mapping);
  if (columns.length !== headers.length) throw new SalesError(400, "Column mapping must match every source column, using null for skipped columns.");
  if (requiredSalesFields.some((field) => !columns.includes(field))) throw new SalesError(400, "Required mappings: order_id, date, quantity, unit_price. Daily totals belong in owner entry, not sales imports.");
  const recognized = columns.filter(Boolean);
  if (new Set(recognized).size !== recognized.length) throw new SalesError(400, "Duplicate mapped column headers. Map each field only once.");
  return columns;
}
function validateFile(buffer: Buffer) {
  if (!buffer.length || buffer.length > 32 * 1024 * 1024) throw new SalesError(400, "Choose a nonempty CSV or XLSX file up to 32 MiB.");
}
function decimal(value: string) {
  if (!/^\d{1,8}(?:\.\d{1,4})?$/.test(value)) throw new Error("Use nonnegative amounts with at most four decimal places.");
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * moneyScale + Number(fraction.padEnd(4, "0"));
}
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("formula" in value || "sharedFormula" in value) throw new SalesError(400, "Formula cells are not supported. Export a values-only workbook or CSV.");
    if ("richText" in value) return value.richText.map((item) => item.text).join("");
    if ("text" in value) return value.text;
    throw new SalesError(400, "Unsupported spreadsheet cell. Export a values-only CSV.");
  }
  return String(value);
}
async function* workbookRows(buffer: Buffer): AsyncGenerator<string[]> {
  const directory = await Open.buffer(buffer);
  if (directory.files.length > 200 || directory.files.reduce((sum, file) => sum + file.uncompressedSize, 0) > 512 * 1024 * 1024) throw new SalesError(400, "Workbook expands beyond the 512 MiB / 200-entry safety limit. Export a smaller CSV.");
  const metadata = ["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/sharedStrings.xml"];
  const files = directory.files.filter((file) => metadata.includes(file.path) || /^xl\/worksheets\/sheet\d+\.xml$/.test(file.path));
  if (!files.some((file) => file.path === "xl/workbook.xml")) throw new SalesError(400, "Workbook metadata is missing.");
  files.sort((a, b) => (metadata.includes(a.path) ? metadata.indexOf(a.path) : 5) - (metadata.includes(b.path) ? metadata.indexOf(b.path) : 5));
  // ExcelJS requires workbook metadata before worksheet entries; valid XLSX archives may use any entry order.
  const ordered = new ZipArchive({ store: true });
  for (const file of files) {
    const limit = file.path.includes("/worksheets/") ? 384 * 1024 * 1024 : 16 * 1024 * 1024;
    if (file.uncompressedSize > limit) throw new SalesError(400, "A workbook entry is too large. Export a smaller CSV.");
    let bytes = 0;
    const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > limit ? new SalesError(400, "Workbook entry exceeded its decompressed size limit.") : null, chunk);
    } });
    const stream = file.stream();
    stream.on("error", (error: Error) => ordered.destroy(error));
    bounded.on("error", (error: Error) => ordered.destroy(error));
    ordered.append(stream.pipe(bounded), { name: file.path });
  }
  void ordered.finalize().catch((error: Error) => ordered.destroy(error));
  const input = new PassThrough();
  ordered.on("error", (error: Error) => input.destroy(error));
  ordered.pipe(input);
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, { sharedStrings: "cache", styles: "cache", hyperlinks: "ignore" });
    let sheet = 0;
    for await (const worksheet of reader) {
      if (++sheet > 1) throw new SalesError(400, "Use a workbook with one worksheet, or export the desired sheet as CSV.");
      for await (const row of worksheet) {
        if (row.cellCount > 40) throw new SalesError(400, "Use at most 40 columns.");
        const values: string[] = [];
        for (let index = 1; index <= row.cellCount; index++) values.push(cellText(row.getCell(index).value));
        yield values;
      }
    }
  } finally { ordered.destroy(); input.destroy(); }
}
async function* csvRows(buffer: Buffer): AsyncGenerator<string[]> {
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new SalesError(400, "CSV must be valid UTF-8."); }
  const reader = Readable.from([content]).pipe(parse({ bom: true, skip_empty_lines: true, max_record_size: 16_384 }));
  for await (const row of reader) {
    if (!Array.isArray(row) || !row.every((value: unknown) => typeof value === "string")) throw new SalesError(400, "Invalid CSV row.");
    yield row;
  }
}
async function* salesRows(buffer: Buffer, format: "csv" | "xlsx") {
  validateFile(buffer);
  const deadline = Date.now() + 90_000;
  let line = 0;
  try {
    for await (const values of format === "xlsx" ? workbookRows(buffer) : csvRows(buffer)) {
      if (++line > 600_001 || Date.now() > deadline) throw new SalesError(400, "Import limit reached (600,000 rows or 90 seconds). Split the file.");
      if (values.length > 40) throw new SalesError(400, "Use at most 40 columns.");
      if (values.some((value) => value.length > 4000)) throw new SalesError(400, `Row ${line}: a cell exceeds 4,000 characters.`);
      if (values.some((value) => value.trim())) yield { values, line };
    }
  } catch (error) {
    if (error instanceof SalesError) throw error;
    if (error instanceof CsvError) throw new SalesError(400, `CSV syntax error near row ${error.lines}. Check quoting and column counts.`);
    if (format === "xlsx" && error instanceof Error) throw new SalesError(400, "Cannot read this workbook. Export a valid, values-only XLSX or CSV.");
    throw error;
  }
}
export async function readSalesHeaders(buffer: Buffer, format: "csv" | "xlsx") {
  let headers: string[] | undefined;
  // Validate the entire upload, but never return data rows or store the raw file.
  for await (const { values } of salesRows(buffer, format)) headers ??= values;
  if (!headers) throw new SalesError(400, "The file must contain column headings.");
  return { headers, suggestions: suggestMapping(headers) };
}
export async function readSalesFile(buffer: Buffer, format: "csv" | "xlsx", currency: string, mapping?: SalesMapping): Promise<SalesSnapshot> {
  analyticsCurrency.parse(currency);
  const days = new Map<string, DailySales>();
  const orders = new Map<string, string>();
  const countedSales = new Set<string>();
  const products = new Map<string, { sku: string; name: string; netSales: number; units: number }>();
  const errors: string[] = [];
  let columns: SalesMapping | undefined;
  let uciInvoices = false;
  let accepted = 0, rejected = 0, excluded = 0;
  for await (const { values, line } of salesRows(buffer, format)) {
    if (!columns) {
      columns = approvedMapping(values, mapping);
      uciInvoices = values.some((value, index) => columns![index] === "order" && ["invoiceno", "invoice"].includes(headerKey(value)));
      continue;
    }
    const row = Object.fromEntries(columns.flatMap((key, index) => key ? [[key, values[index]?.trim() ?? ""]] : []));
    if (row.currency && row.currency.toUpperCase() !== currency) throw new SalesError(400, `Row ${line}: mixed currencies are not supported. Split the file by currency.`);
    if (row.status && !["paid", "completed", "refunded", "returned", "cancelled", "canceled"].includes(row.status.toLowerCase())) {
      rejected++; if (errors.length < 12) errors.push(`Row ${line}: status must be paid, completed, refunded, returned or cancelled.`); continue;
    }
    if (/^cancel[le]+d$/i.test(row.status ?? "")) { excluded++; continue; }
    try {
      if (!row.order || row.order.length > 120) throw new Error("A stable order ID is required (max 120 characters).");
      if (!/^\d{4}-\d{2}-\d{2}(?:$|T|\s)/.test(row.date) || !/^\d{4}-\d{2}-\d{2}$/.test(row.date.slice(0, 10))) throw new Error("Use ISO dates (YYYY-MM-DD), not ambiguous slash dates.");
      const date = row.date.slice(0, 10);
      if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || date > new Date().toISOString().slice(0, 10) || date < "1900-01-01") throw new Error("Use a valid historical date.");
      if (!/^-?\d+$/.test(row.quantity) || Math.abs(Number(row.quantity)) > 1_000_000 || Number(row.quantity) === 0) throw new Error("Quantity must be a nonzero integer up to 1,000,000.");
      const quantity = Number(row.quantity);
      const price = decimal(row.price), discount = decimal(row.discount || "0");
      const gross = price * Math.abs(quantity);
      if (!Number.isSafeInteger(gross) || gross > 8_000_000_000_000 || discount > gross) throw new Error("Line value is too large, or discount exceeds gross sales.");
      const returned = quantity < 0 || (uciInvoices && /^c/i.test(row.order)) || /^(refunded|returned)$/i.test(row.status ?? "");
      const existingDate = orders.get(row.order);
      if (existingDate && existingDate !== date) throw new Error("An order ID appears on different dates. Use separate reversal IDs.");
      if (!days.has(date)) {
        if (days.size >= 3660) throw new SalesError(400, "Use at most 3,660 observed dates.");
        days.set(date, { date, gross: 0, discounts: 0, reversals: 0, orders: 0, units: 0, cogs: null, operatingExpenses: null, sessions: null, purchasingSessions: null });
      }
      const day = days.get(date)!;
      if (returned) day.reversals += gross - discount;
      else {
        day.gross += gross; day.discounts += discount;
        if (!countedSales.has(row.order)) { day.orders++; countedSales.add(row.order); }
      }
      orders.set(row.order, date);
      day.units += returned ? -Math.abs(quantity) : quantity;
      const sku = row.sku || "(unassigned)";
      if (!products.has(sku)) products.set(sku, { sku, name: (row.name || sku).slice(0, 160), netSales: 0, units: 0 });
      const product = products.get(sku)!;
      product.netSales += (gross - discount) * (returned ? -1 : 1);
      product.units += returned ? -Math.abs(quantity) : quantity;
      accepted++;
    } catch (error) {
      if (error instanceof SalesError) throw error;
      if (!(error instanceof Error)) throw error;
      rejected++; if (errors.length < 12) errors.push(`Row ${line}: ${error.message}`);
    }
  }
  if (!accepted) throw new SalesError(400, `No valid sales rows. ${errors.join(" ")}`);
  const sorted = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const warnings = [
    "Amounts use the selected currency. UCI Online Retail unit prices are GBP; no currency conversion is performed.",
    "Missing dates are unknown, not zero sales. Source exports must be complete for the selected reporting period.",
    "Negative quantities, C-prefixed UCI invoices and returned/refunded statuses are recorded as sales reversals on their recorded date. Do not duplicate the same refund using both a negative line and a separate refund record.",
    "AOV uses booked line sales less discounts, before reversals. Separate order-level tax/shipping fields are not imported; source-coded charges such as UCI postage remain line items.",
    "Traffic and costs were not imported. Conversion and profit remain unknown.",
  ];
  if (!columns?.includes("discount")) warnings.push("No separate discount column was supplied. Unit prices are treated as booked selling prices, with no additional discount deduction.");
  return salesSnapshotSchema.parse({
    currency, days: sorted, accepted, rejected, excluded, errors, warnings,
    products: [...products.values()].sort((a, b) => b.netSales - a.netSales).slice(0, 12),
  });
}
export const salesFileHash = (buffer: Buffer, configuration?: { format: "csv" | "xlsx"; currency: string; mapping?: SalesMapping }) => {
  const hash = createHash("sha256").update(buffer);
  if (configuration) hash.update(JSON.stringify([configuration.format, configuration.currency, configuration.mapping ?? "auto"]));
  return hash.digest("hex");
};
