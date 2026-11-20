import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { openStore, type Store } from "./database.js";
import { loadConfig } from "./config.js";
import { createContactSender, createGoDaddyContactSender, type ContactSender } from "./contact.js";
import { contactMailbox, type ContactInput } from "../shared/contact.js";

const smtp = vi.hoisted(() => ({ sendMail: vi.fn(), createTransport: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: smtp.createTransport } }));
const input: ContactInput = {
  category: "partnership", name: "Test Visitor", email: "visitor@example.test",
  company: "Fixture Business", message: "I'd like to discuss a partnership.\nHere are the details.", website: "",
};
const origin = "http://127.0.0.1:5174";
const stores: Store[] = [];
function appWith(contactSender?: ContactSender) {
  const store = openStore(":memory:");
  stores.push(store);
  return createApp({ store, origin, contactSender });
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("GoDaddy contact email gateway", () => {
  const settings = { CONTACT_FORM_RECIPIENT_EMAIL: "configured-owner@example.test" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("selects the gateway only when explicitly enabled with a valid recipient, without requiring SMTP credentials", () => {
    expect(loadConfig({ ...settings }).godaddyEmail).toBeUndefined();
    const config = loadConfig({ CONTACT_EMAIL_ENABLED: "true", ...settings, SMTP_PORT: "invalid" });
    expect(config.godaddyEmail).toEqual(settings);
    expect(config.smtp).toBeUndefined();
    expect(loadConfig({
      CONTACT_EMAIL_ENABLED: "true", CONTACT_FORM_RECIPIENT_EMAIL: ` ${settings.CONTACT_FORM_RECIPIENT_EMAIL} `,
    }).godaddyEmail).toEqual(settings);
    for (const recipient of ["", " ", "not-an-email", "a@example.test\nBcc: injected@example.test"]) {
      expect(() => loadConfig({ CONTACT_EMAIL_ENABLED: "true", CONTACT_FORM_RECIPIENT_EMAIL: recipient })).toThrow("CONTACT_FORM_RECIPIENT_EMAIL");
    }
  });

  it("uses the configured recipient and visitor reply-to, omits the sender, and waits for gateway acceptance", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ success: true, messageId: "fixture-message-id" }));
    vi.stubGlobal("fetch", fetch);
    await createGoDaddyContactSender(settings)(input);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:2525/api/email/send", expect.objectContaining({
      method: "POST", redirect: "error", signal: expect.any(AbortSignal),
      headers: { "content-type": "application/json" },
    }));
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      to: [settings.CONTACT_FORM_RECIPIENT_EMAIL], replyTo: input.email,
      subject: "GrowthPulse contact: Partnership",
      text: `Enquiry: Partnership\nName: ${input.name}\nEmail: ${input.email}\nCompany: ${input.company}\n\n${input.message}`,
    });
    expect(smtp.createTransport).not.toHaveBeenCalled();
  });

  it.each([
    { body: { success: false, error: "private verified domain list" }, status: 200, name: "ContactGatewayRejected" },
    { body: { success: true }, status: 200, name: "ContactGatewayInvalidResponse" },
    { body: { success: true, messageId: " " }, status: 200, name: "ContactGatewayInvalidResponse" },
    { body: { success: "true", messageId: "fixture-id" }, status: 200, name: "ContactGatewayInvalidResponse" },
    { body: null, status: 200, name: "ContactGatewayInvalidResponse" },
    { body: { success: true, messageId: "fixture-id" }, status: 502, name: "ContactGatewayHttp502" },
  ])("rejects unconfirmed acceptance without revealing gateway details ($name)", async ({ body, status, name }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body, status)));
    await expect(createGoDaddyContactSender(settings)(input)).rejects.toMatchObject({
      name, message: "The contact email gateway did not confirm acceptance.",
    });
  });

  it("reports non-JSON responses and network failures explicitly", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("not JSON"))
      .mockRejectedValueOnce(new TypeError("synthetic private connection detail"));
    vi.stubGlobal("fetch", fetch);
    const sender = createGoDaddyContactSender(settings);
    await expect(sender(input)).rejects.toMatchObject({ name: "ContactGatewayInvalidResponse" });
    await expect(sender(input)).rejects.toMatchObject({ name: "ContactGatewayNetwork" });
  });

  it("keeps the 30-second abort deadline active while reading a stalled response body", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        deadline.signal.addEventListener("abort", () => controller.error(deadline.signal.reason), { once: true });
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stream));
    vi.stubGlobal("fetch", fetch);
    const pending = createGoDaddyContactSender(settings)(input);
    const rejection = expect(pending).rejects.toMatchObject({ name: "ContactGatewayTimeout" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetch.mock.calls[0][1]?.signal).toBe(deadline.signal);
    deadline.abort(new DOMException("synthetic deadline", "TimeoutError"));
    await rejection;
  });

  it("preserves the public API's failure response and logs only safe gateway diagnostics", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ success: false, error: "private verified domain list" })));
    const response = await request(appWith(createGoDaddyContactSender(settings)))
      .post("/api/contact").set("Origin", origin).send(input).expect(502);
    expect(response.body).not.toHaveProperty("status");
    expect(JSON.stringify(response.body)).not.toContain("private verified domain list");
    expect(log.mock.calls).toEqual([["Contact email failed:", "ContactGatewayRejected"]]);
  });
});

describe("public contact API", () => {
  it("waits for SMTP acceptance without requiring an account or starting an agent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sender = vi.fn(() => gate);
    const app = appWith(sender);
    let finished = false;
    const response = request(app).post("/api/contact").set("Origin", origin).send(input).then((result) => { finished = true; return result; });
    await vi.waitFor(() => expect(sender).toHaveBeenCalledWith(input));
    expect(finished).toBe(false);
    release();
    const result = await response;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "accepted" });
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["set-cookie"]).toBeUndefined();
  });

  it.each([undefined, "https://untrusted.example", `${origin}/`])("rejects an unapproved origin %s before sending", async (unapproved) => {
    const sender = vi.fn();
    const post = request(appWith(sender)).post("/api/contact");
    if (unapproved) post.set("Origin", unapproved);
    await post.send(input).expect(403);
    expect(sender).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, name: "Test\r\nBcc: injected@example.test" },
    { ...input, email: "invalid-email" },
    { ...input, company: "Company\nAnother header" },
    { ...input, category: "made-up" },
    { ...input, message: "short" },
    { ...input, message: "m".repeat(5001) },
    { ...input, message: "Contains\0an invalid byte" },
    { ...input, website: "https://spam.example" },
    { ...input, to: "arbitrary@example.test" },
  ])("rejects invalid or injected input without sending", async (invalid) => {
    const sender = vi.fn();
    await request(appWith(sender)).post("/api/contact").set("Origin", origin).send(invalid).expect(400);
    expect(sender).not.toHaveBeenCalled();
  });

  it("normalizes optional fields, rejects non-JSON, and reports disabled SMTP truthfully", async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    const { company: _company, website: _website, ...required } = input;
    const app = appWith(sender);
    await request(app).post("/api/contact").set("Origin", origin).send({ ...required, name: "  Test Visitor  " }).expect(200);
    expect(sender).toHaveBeenCalledWith({ ...input, company: "", website: "" });
    await request(app).post("/api/contact").set("Origin", origin).set("Content-Type", "text/plain").send("hello").expect(415);
    const disabled = await request(appWith()).post("/api/contact").set("Origin", origin).send(input).expect(503);
    expect(disabled.body.error).toContain(contactMailbox);
    expect(disabled.body).not.toHaveProperty("status");
  });

  it("reports SMTP errors without disclosing message contents or provider credentials", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "fixture-private-smtp-password";
    const sender = vi.fn().mockRejectedValue(new Error(`SMTP rejected ${secret}: ${input.message}`));
    const result = await request(appWith(sender)).post("/api/contact").set("Origin", origin).send(input).expect(502);
    expect(result.body.error).toContain(contactMailbox);
    expect(JSON.stringify(result.body)).not.toContain(secret);
    expect(log.mock.calls).toEqual([["Contact email failed:", "Error"]]);
  });

  it("limits attempts per IP without trusting an unverified forwarded address", async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    const app = appWith(sender);
    for (let index = 0; index < 5; index++) {
      await request(app).post("/api/contact").set("Origin", origin).set("X-Forwarded-For", `192.0.2.${index + 1}`).send(input).expect(200);
    }
    const limited = await request(app).post("/api/contact").set("Origin", origin).set("X-Forwarded-For", "192.0.2.10").send(input).expect(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(sender).toHaveBeenCalledTimes(5);
  });

  it("caps concurrent sends and releases capacity after a failed send", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sender = vi.fn(async () => { await gate; throw new Error("synthetic SMTP failure"); });
    const app = appWith(sender);
    const sends = Array.from({ length: 3 }, () => request(app).post("/api/contact").set("Origin", origin).send(input).then((result) => result));
    await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(3));
    const busy = await request(app).post("/api/contact").set("Origin", origin).send(input);
    release();
    const results = await Promise.all(sends);
    expect(busy.status).toBe(429);
    expect(results.every((result) => result.status === 502)).toBe(true);
    sender.mockImplementation(async () => {});
    await request(app).post("/api/contact").set("Origin", origin).send(input).expect(200);
    expect(log).toHaveBeenCalledTimes(3);
  });
});

describe("contact SMTP configuration and transport", () => {
  const settings = { SMTP_HOST: "smtp.example.test", SMTP_PORT: 587 as const, SMTP_USER: contactMailbox, SMTP_PASSWORD: " synthetic-password " };
  it("keeps SMTP off by default and validates only when enabled", () => {
    expect(loadConfig({ SMTP_PORT: "invalid" }).smtp).toBeUndefined();
    expect(loadConfig({ CONTACT_EMAIL_ENABLED: "false" }).smtp).toBeUndefined();
    expect(() => loadConfig({ CONTACT_EMAIL_ENABLED: "true", SMTP_PASSWORD: "fixture-secret" })).toThrow(/^Invalid contact email configuration: (?!.*fixture-secret)/);
    expect(() => loadConfig({ CONTACT_EMAIL_ENABLED: "yes" })).toThrow("CONTACT_EMAIL_ENABLED");
    expect(loadConfig({ CONTACT_EMAIL_ENABLED: "true", ...settings, SMTP_PORT: "465" }).smtp).toEqual({ ...settings, SMTP_PORT: 465 });
    const { SMTP_PORT: _port, ...defaults } = settings;
    expect(loadConfig({ CONTACT_EMAIL_ENABLED: "true", ...defaults }).smtp).toEqual(settings);
    expect(() => loadConfig({ CONTACT_EMAIL_ENABLED: "true", ...settings, SMTP_PORT: "25" })).toThrow("SMTP_PORT");
  });

  it.each([465, 587] as const)("requires verified TLS on port %i and sends only to the fixed mailbox", async (port) => {
    smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail });
    smtp.sendMail.mockResolvedValue({ accepted: [contactMailbox], rejected: [] });
    await createContactSender({ ...settings, SMTP_PORT: port })(input);
    expect(smtp.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      secure: port === 465, requireTLS: port === 587,
      tls: { minVersion: "TLSv1.2" }, disableFileAccess: true, disableUrlAccess: true, debug: false, logger: false,
      auth: { user: contactMailbox, pass: settings.SMTP_PASSWORD },
    }));
    expect(smtp.sendMail).toHaveBeenCalledWith({
      from: { name: "GrowthPulse", address: contactMailbox }, to: contactMailbox,
      replyTo: { name: input.name, address: input.email },
      envelope: { from: contactMailbox, to: [contactMailbox] },
      subject: "GrowthPulse contact: Partnership",
      text: `Enquiry: Partnership\nName: ${input.name}\nEmail: ${input.email}\nCompany: ${input.company}\n\n${input.message}`,
    });
  });

  it("does not report rejected or unaccepted recipients as successful, and propagates transport errors", async () => {
    smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail });
    const sender = createContactSender(settings);
    for (const result of [{ accepted: [], rejected: [contactMailbox] }, { accepted: [], rejected: [] }]) {
      smtp.sendMail.mockResolvedValueOnce(result);
      await expect(sender(input)).rejects.toThrow("SMTP did not accept");
    }
    smtp.sendMail.mockRejectedValueOnce(new Error("synthetic network failure"));
    await expect(sender(input)).rejects.toThrow("synthetic network failure");
  });
});
