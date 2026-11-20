import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, Mail, MessageCircle } from "lucide-react";
import { contactCategories, contactInputSchema, contactMailbox, contactResponseSchema, type ContactInput } from "../shared/contact";
import { api, ApiFailure, errorMessage } from "./api";
import { Icon } from "./Icon";
import "./contact.css";

type Field = keyof ContactInput;
const emptyForm: ContactInput = { category: "product", name: "", email: "", company: "", message: "", website: "" };
const categoryKeys = Object.keys(contactCategories) as ContactInput["category"][];

export function ContactPage() {
  const [form, setForm] = useState<ContactInput>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const request = useRef<AbortController | null>(null);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const formElement = useRef<HTMLFormElement>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (sent) successHeading.current?.focus(); }, [sent]);

  function change(field: Field, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setError("");
  }
  function validate() {
    const parsed = contactInputSchema.safeParse(form);
    if (!parsed.success) {
      const fields: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as Field;
        fields[field] ??= field === "name" ? "Enter your name (2-100 characters)."
          : field === "email" ? "Enter a valid email address."
          : field === "company" ? "Use a business name of up to 120 characters on one line."
          : field === "message" ? "Write a message between 10 and 5,000 characters."
          : issue.message;
      }
      setErrors(fields);
      const first = Object.keys(fields)[0];
      formElement.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
    }
    return parsed;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    setError("");
    const parsed = validate();
    if (!parsed.success) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    try {
      await api("/api/contact", contactResponseSchema, {
        method: "POST", body: JSON.stringify(parsed.data), signal: controller.signal,
      }, 60_000);
      if (!controller.signal.aborted) { setSent(true); setForm(emptyForm); }
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof ApiFailure
        ? errorMessage(error)
        : "We couldn't confirm that your message was sent. Check before sending it again, or email us directly.");
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setPending(false);
      }
    }
  }
  const fieldError = (field: Field) => errors[field] && <span className="contact-field-error" id={`contact-${field}-error`}>{errors[field]}</span>;

  return <div className="contact-page">
    <a className="skip-link" href="#contact-content" onClick={(event) => {
      event.preventDefault();
      const target = formElement.current?.querySelector<HTMLInputElement>("input") ?? successHeading.current;
      target?.scrollIntoView();
      target?.focus();
    }}>Skip to contact form</a>
    <header className="contact-header">
      <a className="brand" href="#overview"><span className="brand-mark"><Icon name="pulse" /></span>GrowthPulse</a>
      <a className="contact-back" href="#overview"><ArrowLeft />Back to GrowthPulse</a>
    </header>
    <main id="contact-content" className="contact-layout">
      <section className="contact-intro" aria-labelledby="contact-heading">
        <p className="contact-eyebrow"><MessageCircle />CONTACT US</p>
        <h1 id="contact-heading">Let's talk.</h1>
        <p>Have a question, an idea, or a partnership in mind? We'd love to hear from you.</p>
        <div className="contact-email"><span><Mail /></span><div><h2>Prefer email?</h2><a href={`mailto:${contactMailbox}`}>{contactMailbox}</a></div></div>
      </section>
      <section className="contact-card" aria-label="Send GrowthPulse a message">
        {sent ? <div className="contact-success">
          <span className="contact-success-icon"><Check /></span>
          <h2 ref={successHeading} tabIndex={-1}>Thanks for reaching out.</h2>
          <p role="status">Your message has been submitted. We'll use the email address you shared to reply.</p>
          <button type="button" className="contact-submit" onClick={() => { setSent(false); setErrors({}); setError(""); }}>Send another message<ArrowRight /></button>
          <a className="contact-back" href="#overview">Back to GrowthPulse</a>
        </div> : <form ref={formElement} onSubmit={(event) => void submit(event)} noValidate>
          <fieldset className="contact-categories" disabled={pending}>
            <legend>What brings you here today?</legend>
            <p>Choose the option that best describes your enquiry.</p>
            <div>{categoryKeys.map((category) => <label key={category} className={`contact-category${form.category === category ? " selected" : ""}`}>
              <input type="radio" name="category" value={category} checked={form.category === category} onChange={() => change("category", category)} />
              <span><strong>{contactCategories[category].label}</strong><small>{contactCategories[category].detail}</small></span>
            </label>)}</div>
          </fieldset>
          <fieldset className="contact-details" disabled={pending}>
            <legend>Your details</legend>
            <div className="contact-fields">
              <div className="contact-field"><label htmlFor="contact-name">Name</label><input id="contact-name" name="name" autoComplete="name" maxLength={100} required value={form.name} aria-invalid={!!errors.name} aria-describedby={errors.name ? "contact-name-error" : undefined} onChange={(event) => change("name", event.target.value)} />{fieldError("name")}</div>
              <div className="contact-field"><label htmlFor="contact-email">Email address</label><input id="contact-email" name="email" type="email" autoComplete="email" maxLength={254} required value={form.email} aria-invalid={!!errors.email} aria-describedby={errors.email ? "contact-email-error" : undefined} onChange={(event) => change("email", event.target.value)} />{fieldError("email")}</div>
              <div className="contact-field contact-full-field"><label htmlFor="contact-company">Company / Business name <span>(optional)</span></label><input id="contact-company" name="company" autoComplete="organization" maxLength={120} value={form.company} aria-invalid={!!errors.company} aria-describedby={errors.company ? "contact-company-error" : undefined} onChange={(event) => change("company", event.target.value)} />{fieldError("company")}</div>
              <div className="contact-field contact-full-field"><label htmlFor="contact-message">How can we help?</label><textarea id="contact-message" name="message" rows={5} maxLength={5000} required value={form.message} aria-invalid={!!errors.message} aria-describedby={`contact-message-hint${errors.message ? " contact-message-error" : ""}`} onChange={(event) => change("message", event.target.value)} />{fieldError("message")}<small id="contact-message-hint">Please don't include passwords, payment details or private customer data.</small></div>
            </div>
            <div className="contact-honeypot" aria-hidden="true"><label>Leave this empty<input name="website" tabIndex={-1} autoComplete="off" value={form.website} onChange={(event) => change("website", event.target.value)} /></label></div>
          </fieldset>
          {error && <p className="contact-error" role="alert">{error}</p>}
          {errors.website && <p className="contact-error" role="alert">{errors.website}</p>}
          <button className="contact-submit" type="submit" disabled={pending}>{pending ? "Sending your message..." : "Send message"}<ArrowRight /></button>
          <p className="contact-privacy">Your details and message will be emailed to GrowthPulse. We'll use them only to respond to your enquiry.</p>
        </form>}
      </section>
    </main>
    <footer className="contact-footer">A LITTLE CLARITY GOES A LONG WAY.</footer>
  </div>;
}
