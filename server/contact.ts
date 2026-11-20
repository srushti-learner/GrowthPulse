import nodemailer from "nodemailer";
import { z } from "zod";
import { contactCategories, contactMailbox, type ContactInput } from "../shared/contact.js";
import type { GoDaddyEmailSettings, SmtpSettings } from "./config.js";

export type ContactSender = (input: ContactInput) => Promise<void>;

function contactMessage(input: ContactInput) {
  return {
    subject: `GrowthPulse contact: ${contactCategories[input.category].label}`,
    text: `Enquiry: ${contactCategories[input.category].label}\nName: ${input.name}\nEmail: ${input.email}${input.company ? `\nCompany: ${input.company}` : ""}\n\n${input.message}`,
  };
}

const gatewayResponseSchema = z.object({
  success: z.boolean(),
  messageId: z.string().trim().min(1).optional(),
});

class ContactGatewayError extends Error {
  constructor(reason: "Timeout" | "Network" | "Http" | "InvalidResponse" | "Rejected", status?: number) {
    super("The contact email gateway did not confirm acceptance.");
    this.name = `ContactGateway${reason}${reason === "Http" ? status : ""}`;
  }
}

function isTimeout(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function createGoDaddyContactSender(settings: GoDaddyEmailSettings): ContactSender {
  return async (input) => {
    let body: unknown;
    try {
      const response = await fetch("http://127.0.0.1:2525/api/email/send", {
        method: "POST", redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: [settings.CONTACT_FORM_RECIPIENT_EMAIL],
          replyTo: input.email,
          ...contactMessage(input),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new ContactGatewayError("Http", response.status);
      try { body = await response.json(); }
      catch (error) {
        if (isTimeout(error)) throw error;
        throw new ContactGatewayError("InvalidResponse");
      }
    } catch (error) {
      if (error instanceof ContactGatewayError) throw error;
      throw new ContactGatewayError(isTimeout(error) ? "Timeout" : "Network");
    }
    const result = gatewayResponseSchema.safeParse(body);
    if (!result.success) throw new ContactGatewayError("InvalidResponse");
    if (!result.data.success) throw new ContactGatewayError("Rejected");
    if (!result.data.messageId) throw new ContactGatewayError("InvalidResponse");
  };
}

export function createContactSender(settings: SmtpSettings): ContactSender {
  const secure = settings.SMTP_PORT === 465;
  const transport = nodemailer.createTransport({
    host: settings.SMTP_HOST,
    port: settings.SMTP_PORT,
    secure,
    requireTLS: !secure,
    auth: { user: settings.SMTP_USER, pass: settings.SMTP_PASSWORD },
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    dnsTimeout: 10_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  return async (input) => {
    const result = await transport.sendMail({
      from: { name: "GrowthPulse", address: settings.SMTP_USER },
      to: contactMailbox,
      replyTo: { name: input.name, address: input.email },
      envelope: { from: settings.SMTP_USER, to: [contactMailbox] },
      ...contactMessage(input),
    });
    if (result.rejected.length || result.accepted.length !== 1) {
      throw new Error("SMTP did not accept the contact mailbox.");
    }
  };
}
