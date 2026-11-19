import { z } from "zod";

export const salesFields = ["order", "date", "quantity", "price", "sku", "name", "discount", "currency", "status"] as const;
export type SalesField = typeof salesFields[number];
export const requiredSalesFields: SalesField[] = ["order", "date", "quantity", "price"];
export const salesFieldLabels: Record<SalesField, string> = {
  order: "Stable order ID", date: "Date (YYYY-MM-DD)", quantity: "Quantity",
  price: "Unit selling price", sku: "SKU", name: "Product name",
  discount: "Per-line discount amount", currency: "Currency", status: "Status",
};
// Each position corresponds to a source column; null explicitly skips that column.
export const salesMappingSchema = z.array(z.enum(salesFields).nullable()).min(1).max(40);
export type SalesMapping = z.infer<typeof salesMappingSchema>;
export const salesHeadersResponseSchema = z.object({
  headers: z.array(z.string().max(4000)).min(1).max(40),
  suggestions: salesMappingSchema,
});
