import { z } from "zod";

export const scanLimits = {
  pages: 20, milliseconds: 40_000, pageBytes: 5 * 1024 * 1024, requests: 50,
  totalBytes: 25 * 1024 * 1024, retainedBytes: 1_500_000,
  sitemaps: 4, sitemapBytes: 1024 * 1024, discoveredUrls: 500, productBytesPerPage: 128 * 1024,
} as const;
export const scanCoverageSchema = z.object({
  attemptedPages: z.number().int().min(0).max(scanLimits.pages),
  discoveredPages: z.number().int().min(0).max(scanLimits.discoveredUrls),
  sitemapsRead: z.number().int().min(0).max(scanLimits.sitemaps),
  requests: z.number().int().min(0).max(scanLimits.requests),
  bytesRead: z.number().int().min(0).max(scanLimits.totalBytes),
  productRecords: z.number().int().min(0).max(scanLimits.pages * 50),
  limited: z.boolean(),
});
export const scanInputSchema = z.object({
  url: z.string().trim().url().max(2048),
  permission: z.literal(true, { error: "Confirm that you have permission to scan these public pages." }),
}).strict();
export const scannedPageSchema = z.object({
  url: z.url().max(2048),
  capturedAt: z.iso.datetime(),
  title: z.string().max(300),
  description: z.string().max(2000),
  headings: z.array(z.object({ level: z.number().int().min(1).max(3), text: z.string().max(240) })).max(30),
  text: z.string().max(12000),
  contacts: z.array(z.string().max(300)).max(20),
  callsToAction: z.array(z.string().max(120)).max(20),
  links: z.array(z.url().max(2048)).max(100),
  warnings: z.array(z.string()).max(10),
  productJson: z.array(z.string().max(20_000)).max(50).optional(),
});
export const scannedCatalogueSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  issues: z.array(z.object({ reference: z.string(), name: z.string(), message: z.string() })).max(scanLimits.pages * 50),
});
export const scanResultSchema = z.object({
  requestedUrl: z.url().max(2048),
  status: z.enum(["complete", "partial", "failed"]),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  pages: z.array(scannedPageSchema).max(scanLimits.pages),
  failures: z.array(z.object({ url: z.string().max(2048), message: z.string() })).max(scanLimits.pages),
  notes: z.array(z.string()).max(10),
  coverage: scanCoverageSchema.optional(),
  catalogue: scannedCatalogueSchema.optional(),
});
export const savedScanSchema = scanResultSchema.extend({ id: z.uuid(), businessId: z.uuid() });
export const scanSummarySchema = savedScanSchema.pick({
  id: true, businessId: true, requestedUrl: true, status: true, startedAt: true, completedAt: true,
}).extend({ pageCount: z.number().int().min(0).max(scanLimits.pages) });
export const scanResponseSchema = z.object({ scan: scanResultSchema });
export const savedScanResponseSchema = z.object({ scan: savedScanSchema });
export const scansResponseSchema = z.object({ scans: z.array(scanSummarySchema).max(20) });
export type ScanResult = z.infer<typeof scanResultSchema>;
export type ScannedPage = z.infer<typeof scannedPageSchema>;
export type SavedScan = z.infer<typeof savedScanSchema>;
export type ScanSummary = z.infer<typeof scanSummarySchema>;
