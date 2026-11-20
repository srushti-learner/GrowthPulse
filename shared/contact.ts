import { z } from "zod";

export const contactMailbox = "hello@growthpulse.live";
export const contactCategories = {
  product: { label: "Product enquiry", detail: "A question about GrowthPulse." },
  sales: { label: "Business / Sales", detail: "Explore using GrowthPulse." },
  partnership: { label: "Partnership", detail: "Let's work together." },
  feedback: { label: "Feedback / Suggestions", detail: "Share an idea or suggestion." },
  general: { label: "General question", detail: "Something you'd like to ask." },
} as const;
const singleLine = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
export const contactInputSchema = z.object({
  category: z.enum(["product", "sales", "partnership", "feedback", "general"]),
  name: z.string().trim().min(2).max(100).refine(singleLine, "Enter your name on one line."),
  email: z.string().trim().max(254).pipe(z.email()).refine(singleLine, "Enter a valid email address."),
  company: z.string().trim().max(120).refine(singleLine, "Enter your business name on one line.").default(""),
  message: z.string().trim().min(10).max(5000).refine((value) => !value.includes("\0"), "Remove invalid characters from your message."),
  website: z.string().max(0, "Leave the website field empty.").default(""),
}).strict();
export type ContactInput = z.infer<typeof contactInputSchema>;
export const contactResponseSchema = z.object({ status: z.literal("accepted") });
