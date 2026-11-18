import { parse, CsvError } from "csv-parse/sync";
import { trafficDaySchema, trafficSnapshotSchema, type TrafficDay, type TrafficSnapshot } from "../shared/traffic.js";
import { SalesError } from "./sales-imports.js";

const headers = ["date", "sessions", "purchasing_sessions", "event_count", "user_count", "events_without_session_key"];
export function readTrafficFile(buffer: Buffer): TrafficSnapshot {
  if (!buffer.length || buffer.length > 1024 * 1024) throw new SalesError(400, "Choose a nonempty traffic CSV up to 1 MiB.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new SalesError(400, "Traffic CSV must be valid UTF-8."); }
  let records: string[][];
  try { records = parse(text, { bom: true, skip_empty_lines: true, max_record_size: 2000, to: 3662 }); }
  catch (error) {
    if (!(error instanceof CsvError)) throw error;
    throw new SalesError(400, `Traffic CSV syntax error near row ${error.lines}: ${error.message}`);
  }
  const columns = records.shift()?.map((value) => value.trim().toLowerCase()) ?? [];
  if (new Set(columns).size !== columns.length || columns.some((value) => !headers.includes(value)) || ["date", "sessions", "purchasing_sessions"].some((key) => !columns.includes(key))) {
    throw new SalesError(400, "Traffic headers: date, sessions, purchasing_sessions; optionally event_count, user_count, events_without_session_key. Sales files belong in the sales uploader.");
  }
  if (!records.length || records.length > 3660) throw new SalesError(400, "Import between 1 and 3,660 traffic dates.");
  const days: TrafficDay[] = records.map((values, index) => {
    const row = Object.fromEntries(columns.map((key, position) => [key, values[position]?.trim() ?? ""]));
    const number = (key: string, optional = false) => {
      if (optional && !row[key]) return null;
      if (!/^\d+$/.test(row[key] ?? "")) throw new SalesError(400, `Row ${index + 2}: ${key} must be a nonnegative integer, not a percentage or blank.`);
      return Number(row[key]);
    };
    const parsed = trafficDaySchema.safeParse({
      date: row.date, sessions: number("sessions"), purchasingSessions: number("purchasing_sessions"),
      eventCount: number("event_count", true), userCount: number("user_count", true), missingSessionEvents: number("events_without_session_key", true),
    });
    if (!parsed.success) throw new SalesError(400, `Row ${index + 2}: ${parsed.error.issues.map((issue) => issue.message).join(" ")}`);
    if (parsed.data.date > new Date().toISOString().slice(0, 10) || parsed.data.date < "1900-01-01") throw new SalesError(400, `Row ${index + 2}: use a historical date from 1900 onward.`);
    return parsed.data;
  });
  const parsed = trafficSnapshotSchema.safeParse({ days: days.sort((a, b) => a.date.localeCompare(b.date)) });
  if (!parsed.success) throw new SalesError(400, parsed.error.issues.map((issue) => issue.message).join(" "));
  return parsed.data;
}
