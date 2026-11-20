import { useEffect, useRef, useState, type FormEvent } from "react";
import { onboardingClaimResponseSchema, onboardingPreviewResponseSchema, onboardingScanResponseSchema, type OnboardingPreview } from "../shared/onboarding";
import { scanInputSchema, scanLimits } from "../shared/website";
import { api, ApiFailure, errorMessage } from "./api";
import { BusinessAgentReview } from "./BusinessAgentReview";
import { Icon } from "./Icon";
import type { z } from "zod";

type Claimed = z.infer<typeof onboardingClaimResponseSchema>;

export function FirstVisit({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [preview, setPreview] = useState<OnboardingPreview | null>(null);
  const [claimed, setClaimed] = useState<Claimed | null>(null);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<"reading" | "saving" | null>(null);
  const [error, setError] = useState("");
  const running = useRef<AbortController | null>(null);
  const callbacks = useRef({ onSessionExpired });
  callbacks.current = { onSessionExpired };

  useEffect(() => () => running.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void api("/api/onboarding/preview", onboardingPreviewResponseSchema, { signal: controller.signal }).then(({ preview }) => {
      if (controller.signal.aborted) return;
      setPreview(preview); setUrl(preview?.scan.requestedUrl ?? "");
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        if (error instanceof ApiFailure && error.status === 401) callbacks.current.onSessionExpired();
        else setError(errorMessage(error));
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || running.current) return;
    const input = scanInputSchema.safeParse({ url, permission: true });
    if (!input.success) { setError(input.error.issues.map((issue) => issue.message).join(" ")); return; }
    const controller = new AbortController();
    running.current = controller;
    setPhase("reading"); setError("");
    try {
      let findings = preview;
      if (!findings || new URL(findings.scan.requestedUrl).href !== new URL(input.data.url).href
        || Date.parse(findings.expiresAt) <= Date.now() || !findings.scan.pages.length || findings.scan.status === "failed") {
        setPreview(null);
        ({ preview: findings } = await api("/api/onboarding/scan", onboardingScanResponseSchema, {
          method: "POST", body: JSON.stringify(input.data), signal: controller.signal,
        }, scanLimits.milliseconds + 10_000));
      }
      if (controller.signal.aborted) return;
      setPreview(findings);
      if (!findings.scan.pages.length || findings.scan.status === "failed") {
        setError(`We couldn't read this website. No AI analysis was started. ${findings.scan.failures[0]?.message ?? "Try another permitted URL, or add your business manually."}`);
        return;
      }
      setPhase("saving");
      const result = await api("/api/onboarding/claim", onboardingClaimResponseSchema, {
        method: "POST", body: JSON.stringify({ permission: true }), signal: controller.signal,
      });
      if (!controller.signal.aborted) setClaimed(result);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof ApiFailure && error.status === 410) setPreview(null);
        if (error instanceof ApiFailure && error.status === 401) callbacks.current.onSessionExpired();
        else setError(errorMessage(error));
      }
    } finally {
      if (!controller.signal.aborted) setPhase(null);
      if (running.current === controller) running.current = null;
    }
  }

  if (claimed) return <section className="first-visit">
    <div className="journey-task"><p className="section-eyebrow">YOUR BUSINESS HAS A HOME</p>
      <h2>Meet your business agent.</h2><p>Your findings are saved to <strong>{claimed.business.name}</strong>. Website evidence is not verified business performance.</p>
      <div className="journey-actions"><a className="primary-link" href={`#overview?business=${claimed.business.id}`}>Open my growth journey<Icon name="arrow" /></a>
        <a className="text-button" href={`#overview?view=business&business=${claimed.business.id}`}>Review business details</a></div></div>
    <BusinessAgentReview business={claimed.business} scanId={claimed.scan.id} scanCapturedAt={claimed.scan.completedAt} mode="research" showProgressDetails={false}
      autoStart={!claimed.understanding || (claimed.understanding.scanId !== claimed.scan.id
        && Date.parse(claimed.understanding.createdAt) < Date.parse(claimed.scan.completedAt))}
      onRecorded={() => undefined}
      onSessionExpired={onSessionExpired}
      onSaved={(business) => setClaimed((current) => current ? { ...current, business } : current)} />
  </section>;

  return <section className="first-visit" aria-label="Get to know your business">
    <ol className="onboarding-steps" aria-label="First visit steps">
      <li>1. Your website</li><li>2. AI analysis</li>
    </ol>
    <form className="workspace-form profile-card" aria-busy={loading || phase !== null} onSubmit={(event) => void submit(event)}>
      <div className="card-heading"><p className="section-eyebrow">LET'S START WITH YOUR BUSINESS</p><h2>What's your business website?</h2><p>Add your website and start your AI analysis. Your agent reads the public pages and continues straight into your business briefing and competitor research.</p></div>
      <fieldset disabled={loading || phase !== null}>
        <legend className="sr-only">Your business website</legend>
        <label>Public website URL<input name="onboardingUrl" type="url" required maxLength={2048} value={url} placeholder="https://your-business.com" onChange={(event) => setUrl(event.target.value)} /></label>
        <button className="primary-link" type="submit">{phase === "reading" ? "Reading your website..." : phase === "saving" ? "Preparing AI analysis..." : "Start AI analysis"}<Icon name="spark" /></button>
        {!phase && <p className="field-note">Starting confirms you own this website or have permission to read its public pages and save your business and usable products. Public website evidence goes to Anthropic; research queries go to Tavily. AI and search charges may apply. No login bypass or website changes; you review suggestions before applying them.</p>}
      </fieldset>
      {loading && <p className="loading-message">Loading website setup...</p>}
      {phase && <p role="status">{phase === "reading" ? `Gathering permitted website evidence. This may take up to ${scanLimits.milliseconds / 1000} seconds. AI analysis follows automatically.` : "Saving your business and products, then opening your AI analysis..."}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </form>
    <p className="field-note"><a className="text-button" href="#overview?view=manual&new=1">I don't have a website. Add my business manually<Icon name="arrow" /></a></p>
  </section>;
}
