import { z } from "zod";

const count = z.number().int().min(0).max(10_000_000_000);
export const trafficDaySchema = z.object({
  date: z.iso.date(),
  sessions: count,
  purchasingSessions: count,
  eventCount: count.nullable(),
  userCount: count.nullable(),
  missingSessionEvents: count.nullable(),
}).strict().refine((day) => day.purchasingSessions <= day.sessions, "Purchasing sessions cannot exceed sessions.")
  .refine((day) => day.missingSessionEvents === null || day.eventCount === null || day.missingSessionEvents <= day.eventCount, "Missing-session events cannot exceed total events.");
export type TrafficDay = z.infer<typeof trafficDaySchema>;
export const trafficSnapshotSchema = z.object({
  days: z.array(trafficDaySchema).min(1).max(3660),
}).refine(({ days }) => new Set(days.map((day) => day.date)).size === days.length, "Each date must occur once.");
export type TrafficSnapshot = z.infer<typeof trafficSnapshotSchema>;
export const trafficImportSchema = z.object({
  id: z.uuid(), filename: z.string(), sourceName: z.string(),
  createdAt: z.iso.datetime(), committed: z.boolean(), snapshot: trafficSnapshotSchema,
});
export type TrafficImport = z.infer<typeof trafficImportSchema>;
export const trafficImportResponseSchema = z.object({ draft: trafficImportSchema });
export const trafficSourceSchema = z.string().trim().min(3).max(120);
export function trafficMetrics(days: TrafficDay[]) {
  const sessions = days.reduce((sum, day) => sum + day.sessions, 0);
  const purchasingSessions = days.reduce((sum, day) => sum + day.purchasingSessions, 0);
  return {
    sessions, purchasingSessions,
    conversion: sessions ? purchasingSessions / sessions * 100 : null,
    eventCount: days.length && days.every((day) => day.eventCount !== null) ? days.reduce((sum, day) => sum + day.eventCount!, 0) : null,
    missingSessionEvents: days.length && days.every((day) => day.missingSessionEvents !== null) ? days.reduce((sum, day) => sum + day.missingSessionEvents!, 0) : null,
  };
}
