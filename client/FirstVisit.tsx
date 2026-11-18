import { useEffect, useRef, useState, type FormEvent } from "react";
import type { User } from "../shared/contracts";
import { onboardingClaimResponseSchema, onboardingPreviewResponseSchema, onboardingScanResponseSchema, type OnboardingPreview } from "../shared/onboarding";
import { scanInputSchema, scanLimits, type ScannedPage } from "../shared/website";
import { api, ApiFailure, errorMessage } from "./api";
import { AuthForm } from "./AuthForm";
import { BusinessAgentReview } from "./BusinessAgentReview";
import { businessAnalysisDisclosure } from "../shared/understanding";
import { Icon } from "./Icon";
import type { z } from "zod";

type Claimed = z.infer<typeof onboardingClaimResponseSchema>;

export function FirstVisit({ authenticated, startBriefing, onAuthenticated, onStarted, onSessionExpired, onNoPreview }: {
  authenticated: boolean;
  startBriefing: boolean;
  onAuthenticated: (user: User, continueBriefing: boolean) => void;
  onStarted: () => void;
  onSessionExpired: () => void;
  onNoPreview?: () => void;
}) {
  const [preview, setPreview] = useState<OnboardingPreview | null>(null);
  const [claimed, setClaimed] = useState<Claimed | null>(null);
  const [url, setUrl] = useState("");
  const [permission, setPermission] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [authVisible, setAuthVisible] = useState(false);
  const [requestBriefing, setRequestBriefing] = useState(startBriefing);
  const running = useRef<AbortController | null>(null);
  const callbacks = useRef({ onAuthenticated, onStarted, onSessionExpired, onNoPreview });
  callbacks.current = { onAuthenticated, onStarted, onSessionExpired, onNoPreview };

  useEffect(() => () => running.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void api("/api/onboarding/preview", onboardingPreviewResponseSchema, { signal: controller.signal }).then(({ preview }) => {
      if (controller.signal.aborted) return;
      setPreview(preview); setUrl(preview?.scan.requestedUrl ?? "");
      if (!preview && authenticated && !startBriefing) callbacks.current.onNoPreview?.();
      if (!preview && startBriefing) {
        setRequestBriefing(false); callbacks.current.onStarted();
        setError("Your public findings have expired. Read the website again to continue.");
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!authenticated || !requestBriefing || loading || !preview) return;
    const controller = new AbortController();
    setClaiming(true); setError("");
    void api("/api/onboarding/claim", onboardingClaimResponseSchema, {
      method: "POST", body: JSON.stringify({ permission: true }), signal: controller.signal,
    }).then((result) => {
      if (!controller.signal.aborted) setClaimed(result);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiFailure && error.status === 401) callbacks.current.onSessionExpired();
      else setError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) {
        setClaiming(false); setRequestBriefing(false); callbacks.current.onStarted();
      }
    });
    return () => controller.abort();
  }, [authenticated, requestBriefing, loading, preview]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = scanInputSchema.safeParse({ url, permission });
    if (!input.success) { setError(input.error.issues.map((issue) => issue.message).join(" ")); return; }
    const controller = new AbortController();
    running.current = controller;
    setBusy(true); setError(""); setAuthVisible(false); setPreview(null);
    try {
      const { preview } = await api("/api/onboarding/scan", onboardingScanResponseSchema, {
        method: "POST", body: JSON.stringify(input.data), signal: controller.signal,
      }, scanLimits.milliseconds + 10_000);
      if (!controller.signal.aborted) setPreview(preview);
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  if (claimed) return <section className="first-visit">
    <p className="field-note">Your public findings are saved to <strong>{claimed.business.name}</strong>. You can rename it in <a href="#business">Business Profile</a>. Website evidence is not verified business performance.</p>
    <BusinessAgentReview business={claimed.business} scanId={claimed.scan.id} scanCapturedAt={claimed.scan.completedAt} mode="research"
      autoStart={!claimed.understanding || (claimed.understanding.scanId !== claimed.scan.id
        && Date.parse(claimed.understanding.createdAt) < Date.parse(claimed.scan.completedAt))}
      onRecorded={() => undefined}
      onSessionExpired={onSessionExpired}
      onSaved={(business) => setClaimed((current) => current ? { ...current, business } : current)} />
  </section>;

  const scan = preview?.scan;
  const usable = !!scan?.pages.length && scan.status !== "failed";
  return <section className="first-visit" aria-label="Get to know your business">
    <ol className="onboarding-steps" aria-label="First visit steps">
      <li>1. Your website</li><li>2. Public findings</li><li>3. Your AI briefing</li>
    </ol>
    <form className="workspace-form profile-card" onSubmit={(event) => void submit(event)}>
      <div className="card-heading"><p className="section-eyebrow">START WITH WHAT YOUR CUSTOMERS SEE</p><h2>A website. A clearer next move.</h2><p>No account needed to read your public pages. See the findings first, then choose whether to save them and ask your business agent for advice.</p></div>
      <fieldset disabled={loading || busy || claiming}>
        <legend className="sr-only">Read your public website</legend>
        <label>Public website URL<input name="onboardingUrl" type="url" required maxLength={2048} value={url} placeholder="https://your-business.com" onChange={(event) => { setUrl(event.target.value); setPermission(false); }} /></label>
        <label className="permission-check"><input name="onboardingPermission" type="checkbox" required checked={permission} onChange={(event) => setPermission(event.target.checked)} />I own this website or have permission to read its public pages.</label>
        <p className="field-note">Read-only: up to {scanLimits.pages} permitted public pages, including discoverable collection and product pages. No login, website changes, or AI provider calls at this step. Findings are held temporarily for 30 minutes so you can continue after sign-in.</p>
        <button className="primary-link" type="submit">{busy ? "Reading public pages..." : preview ? "Read website again" : "Show my public-site findings"}<Icon name="arrow" /></button>
      </fieldset>
      {loading && <p className="loading-message">Checking for your recent public findings...</p>}
      {busy && <p role="status">Discovering allowed business and product pages. This may take up to {scanLimits.milliseconds / 1000} seconds.</p>}
      {error && <p role="alert" className="form-error">{error} <button type="button" className="text-button" disabled={busy || claiming} onClick={() => setReload((value) => value + 1)}>Reload public findings</button></p>}
    </form>
    {preview && scan && !busy && <section className="profile-card public-findings" aria-labelledby="public-findings-heading">
      <p className="section-eyebrow">OBSERVED PUBLIC CONTENT / NO AI YET</p>
      <h2 id="public-findings-heading">{usable ? "What your public website shows" : "We couldn't read this website"}</h2>
      <p className="field-note">Findings for {scan.requestedUrl}</p>
      <p>{usable ? `${scan.pages.length} public page${scan.pages.length === 1 ? "" : "s"} captured. These are website statements, not independently verified facts.` : "No usable public pages were captured. AI analysis will not start. Try another permitted URL, or sign in to add business information yourself."}</p>
      {scan.coverage && <p className="field-note">{scan.coverage.productRecords} structured product records captured. {scan.coverage.limited ? "Discovery was limited; this is a sample, not the full website or catalogue." : "Only discoverable static public content was read; catalogue completeness is not guaranteed."}</p>}
      {usable && <details><summary>Coverage and unavailable content</summary><ul>{[...scan.notes, ...scan.pages.flatMap((page) => page.warnings.map((warning) => `${page.url}: ${warning}`)), ...scan.failures.map((failure) => `${failure.url}: ${failure.message}`)].map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
      {scan?.status === "partial" && <p role="status" className="field-note">Discovery is partial. These findings cover captured pages, not everything on the website.</p>}
      {!usable && scan?.failures[0] && <p className="form-error">{scan.failures[0].message}</p>}
      {scan.pages.slice(0, 3).map((page) => <PublicFinding key={page.url} page={page} />)}
      {scan.pages.length > 3 && <details className="public-findings-more"><summary>View {scan.pages.length - 3} more captured pages</summary>
        {scan.pages.slice(3).map((page) => <PublicFinding key={page.url} page={page} />)}
      </details>}
      <p className="field-note">Available to continue until {new Date(preview.expiresAt).toLocaleTimeString()}. Reading these findings does not change your website.</p>
      {usable && !authVisible && <div className="onboarding-continue">
        <h3>Turn these findings into a useful next step.</h3>
        <p>{authenticated ? "Continue" : "Sign in or create an account"} to save these findings and a basic business profile, then receive a streamed AI briefing, competitor study and a recommended next action. Your saved website evidence is reused; competitor sites are checked separately.</p>
        <p className="field-note">By continuing, captured products with valid, unambiguous details are saved to your catalogue automatically. You also agree to this business and competitor analysis. {businessAnalysisDisclosure} Profile suggestions remain optional.</p>
        <button className="primary-link" disabled={claiming || loading} type="button" onClick={() => {
          if (authenticated) setRequestBriefing(true);
          else setAuthVisible(true);
        }}>{claiming ? "Saving your public findings..." : authenticated ? "Prepare my AI briefing" : "Sign in for my AI briefing"}<Icon name="spark" /></button>
      </div>}
    </section>}
    {authVisible && !authenticated && <div className="onboarding-auth">
      <p className="field-note">Your public findings will carry across sign-in. Your briefing will start after you authenticate; nothing will be applied to your website.</p>
      <AuthForm onAuthenticated={(user) => callbacks.current.onAuthenticated(user, true)} />
      <button className="text-button" type="button" onClick={() => setAuthVisible(false)}>Back to public findings</button>
    </div>}
    <p className="field-note">{authenticated ? <a href="#business">Manage your saved business profiles or add one manually</a> : <a href="#business">No website? Sign in to add information manually</a>}</p>
  </section>;
}

function PublicFinding({ page }: { page: ScannedPage }) {
  return <article className="public-finding">
    <h3>{page.title || "Captured public page"}</h3>
    <p>{page.description || page.headings[0]?.text || "No page summary was published in the captured HTML."}</p>
    <a href={page.url} target="_blank" rel="noopener noreferrer">View source page <Icon name="diagonal" /></a>
    <p className="field-note">Captured {new Date(page.capturedAt).toLocaleString()}</p>
  </article>;
}
