import { useState, type FormEvent } from "react";
import { loginSchema, registerSchema, sessionSchema, type User } from "../shared/contracts";
import { api, errorMessage } from "./api";
import { Icon } from "./Icon";

export function AuthForm({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [register, setRegister] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = { email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") };
    const input = register ? registerSchema.safeParse({ ...values, name: String(form.get("name") ?? "") }) : loginSchema.safeParse(values);
    if (!input.success) {
      setError(input.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    setPending(true);
    setError("");
    try {
      const { user } = await api(`/api/auth/${register ? "register" : "login"}`, sessionSchema, { method: "POST", body: JSON.stringify(input.data) });
      onAuthenticated(user);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="auth-card" aria-labelledby="auth-heading">
      <div className="auth-intro">
        <span className="auth-symbol"><Icon name="shield" /></span>
        <p className="section-eyebrow">YOUR BUSINESS. YOUR WORKSPACE.</p>
        <h2 id="auth-heading">{register ? "Make room for clarity." : "Welcome back."}</h2>
        <p>{register ? "Create a local account to save your business profile and keep its history." : "Log in to your GrowthPulse account to manage your business."}</p>
        <p className="local-note">Development preview: data stays on this computer. Email verification and password recovery are not available. Use a test password, not one you use elsewhere.</p>
      </div>
      <form className="workspace-form auth-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={pending}>
          <legend className="sr-only">{register ? "Create account" : "Log in"}</legend>
          {register && <label>Your name<input name="name" autoComplete="name" required minLength={2} maxLength={100} /></label>}
          <label>Email address<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
          <label>Password<input name="password" type="password" autoComplete={register ? "new-password" : "current-password"} required minLength={register ? 12 : 1} maxLength={128} />{register && <span className="field-note">At least 12 characters. Spaces and passphrases are welcome.</span>}</label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-link" type="submit">{pending ? "Please wait..." : register ? "Create account" : "Log in"}<Icon name="arrow" /></button>
          <button className="text-button" type="button" onClick={() => { setRegister(!register); setError(""); }}>{register ? "Already have an account? Log in" : "New here? Create an account"}</button>
        </fieldset>
      </form>
    </section>
  );
}
