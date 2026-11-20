import nodemailer from "nodemailer";
import { contactCategories, contactMailbox, type ContactInput } from "../shared/contact.js";
import type { SmtpSettings } from "./config.js";

export type ContactSender = (input: ContactInput) => Promise<void>;

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
      subject: `GrowthPulse contact: ${contactCategories[input.category].label}`,
      text: `Enquiry: ${contactCategories[input.category].label}\nName: ${input.name}\nEmail: ${input.email}${input.company ? `\nCompany: ${input.company}` : ""}\n\n${input.message}`,
    });
    if (result.rejected.length || result.accepted.length !== 1) {
      throw new Error("SMTP did not accept the contact mailbox.");
    }
  };
}
