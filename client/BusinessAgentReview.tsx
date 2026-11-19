import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Business } from "../shared/contracts";
import { businessAnalysisDisclosure, partialBriefingNotice, understandingResponseSchema, understandingReviewInputSchema, understandingReviewResponseSchema, type BriefingPreview, type Understanding, type UnderstandingUpdate } from "../shared/understanding";
import { api, ApiFailure, errorMessage } from "./api";
import { followAnalysisJob, streamUnderstanding } from "./understanding-stream";
import { activeAnalysis, analysisJobResponseSchema, analysisJobSchema, type AnalysisJob } from "../shared/analysis";
import { Icon } from "./Icon";
import { BusinessBriefing, SupportingEvidence } from "./BusinessBriefing";
import { ResearchReport } from "./ResearchReport";
import { researchLimits, type ResearchReport as SavedResearch } from "../shared/research";
import type { ResearchView } from "./ResearchDashboard";
import { AnalysisProgress } from "./AnalysisProgress";

export function BusinessAgentReview({ business, autoStart, scanId, scanCapturedAt, onSaved, onRecorded, onSessionExpired, initialView = "overview", mode = "full", showProgressDetails = true }: {
  business: Business; autoStart: boolean; scanId?: string; scanCapturedAt?: string;
  onSaved: (business: Business) => void;
  onRecorded: () => void; onSessionExpired: () => void;
  initialView?: ResearchView;
  mode?: "full" | "research" | "manage";
  showProgressDetails?: boolean;
}) {
  const researchOnly = mode === "research";
  const managementOnly = mode === "manage";
  const [draft, setDraft] = useState<Understanding | null>(null);
  const [lastSuccessful, setLastSuccessful] = useState<Understanding | null>(null);
  const [profile, setProfile] = useState({ category: business.category, description: business.description });
  const [state, setState] = useState<"loading" | "idle" | "running" | "saving">("loading");
  const [error, setError] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const coolingDown = retryAt > now;
  const [saveError, setSaveError] = useState("");
  const [preview, setPreview] = useState<BriefingPreview | null>(null);
  const [briefingRun, setBriefingRun] = useState(0);
  const [reusingScan, setReusingScan] = useState(false);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [retainedResearch, setRetainedResearch] = useState<SavedResearch | null>(null);
  const [phase, setPhase] = useState<Extract<UnderstandingUpdate, { type: "phase" }>["phase"]>("connecting");
  const controller = useRef<AbortController | null>(null);
  const requestKey = useRef<string | null>(null);
  const scope = useRef(`${business.id}:${business.website}`);
  const callbacks = useRef({ onSaved, onRecorded, onSessionExpired });
  callbacks.current = { onSaved, onRecorded, onSessionExpired };

  function report(error: unknown, saving = false) {
    if (error instanceof ApiFailure && error.status === 401) callbacks.current.onSessionExpired();
    else if (saving) setSaveError(errorMessage(error));
    else {
      setError(errorMessage(error));
      setRetryAt(0);
      if (error instanceof ApiFailure && error.status === 429 && error.retryAfterSeconds) {
        setNow(Date.now()); setRetryAt(Date.now() + error.retryAfterSeconds * 1000);
      }
    }
  }
  function receive(next: Understanding | null) {
    setError(""); setRetryAt(0);
    setRetainedResearch(null);
    setDraft(next);
    if (next?.briefing && next.scanStatus !== "failed") setLastSuccessful(next);
    setProfile({
      category: next?.suggestions.find((item) => item.field === "category")?.value ?? business.category,
      description: next?.suggestions.find((item) => item.field === "description")?.value ?? business.description,
    });
  }
  function updateJob(next: AnalysisJob) {
    setJob(next); requestKey.current = null;
    if (next.scanId) setReusingScan(true);
  }
  function updateLive(update: UnderstandingUpdate) {
    if (update.type === "phase") setPhase(update.phase);
    else setPreview(update.briefing);
  }
  async function reconnect(next: AnalysisJob, signal: AbortSignal) {
    setState("running"); setError(""); setJob(next); setPreview(next.preview); setPhase(next.phase);
    try {
      const understanding = await followAnalysisJob(next, signal, (value) => { if (!signal.aborted) updateLive(value); },
        (value) => { if (!signal.aborted) updateJob(value); });
      if (!signal.aborted) { receive(understanding); callbacks.current.onRecorded(); }
    } catch (error) { if (!signal.aborted) report(error); }
    finally { if (!signal.aborted) { setPreview(null); setState("idle"); } }
  }
  async function run(signal: AbortSignal, { reuseScan = false, resumeAccepted = false }: {
    reuseScan?: boolean; resumeAccepted?: boolean;
  } = {}) {
    setBriefingRun((value) => value + 1);
    const savedScan = reuseScan ? job?.scanId ?? scanId : undefined;
    const resumeJobId = resumeAccepted && savedScan && job?.research?.enabled
      && job.researchVersion === researchLimits.version ? job.id : undefined;
    if (job?.research) setRetainedResearch(job.research);
    setReusingScan(!!savedScan);
    setState("running"); setError(""); setSaveError(""); setPreview(null); setPhase("connecting"); setJob(null);
    requestKey.current ??= crypto.randomUUID();
    try {
      const understanding = await streamUnderstanding(`/api/businesses/${business.id}/understanding`, signal, (update) => {
        if (signal.aborted) return;
        updateLive(update);
      }, savedScan, (value) => { if (!signal.aborted) updateJob(value); }, requestKey.current, {
        resumeJobId,
      });
      if (!signal.aborted) { receive(understanding); callbacks.current.onRecorded(); }
    } catch (error) {
      if (!signal.aborted) report(error);
    } finally { if (!signal.aborted) { setPreview(null); setState("idle"); } }
  }
  async function cancel() {
    if (!job || !activeAnalysis(job)) return;
    const signal = controller.current?.signal;
    try {
      const result = await api(`/api/businesses/${business.id}/analysis-jobs/${job.id}/cancel`, analysisJobResponseSchema, {
        method: "POST", body: "{}",
      });
      if (signal?.aborted) return;
      setJob(result.job);
      if (!activeAnalysis(result.job)) {
        controller.current?.abort();
        setPreview(null); setState("idle");
        if (result.job.understanding) { receive(result.job.understanding); callbacks.current.onRecorded(); }
        else setError(result.job.error ?? "This background analysis stopped. Your profile is unchanged.");
      }
    } catch (error) { report(error); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || state !== "idle") return;
    const input = understandingReviewInputSchema.safeParse({ ...profile, expectedUpdatedAt: business.updatedAt });
    if (!input.success) { setSaveError(input.error.issues.map((issue) => issue.message).join(" ")); return; }
    const active = new AbortController();
    controller.current?.abort(); controller.current = active;
    setState("saving"); setSaveError("");
    try {
      const result = await api(`/api/businesses/${business.id}/understanding/${draft.id}/apply`, understandingReviewResponseSchema, {
        method: "POST", body: JSON.stringify(input.data), signal: active.signal,
      });
      if (!active.signal.aborted) { receive(result.understanding); callbacks.current.onSaved(result.business); }
    } catch (error) {
      if (!active.signal.aborted) report(error, true);
    } finally { if (!active.signal.aborted) setState("idle"); }
  }
  useEffect(() => {
    if (!coolingDown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [coolingDown]);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    const nextScope = `${business.id}:${business.website}`;
    if (scope.current !== nextScope) {
      scope.current = nextScope;
      setLastSuccessful(null); setDraft(null); setJob(null); setPreview(null); setRetainedResearch(null); setState("loading");
      setError(""); setSaveError(""); setRetryAt(0); requestKey.current = null;
    }
    void api(`/api/businesses/${business.id}/understanding`, understandingResponseSchema.extend({ job: analysisJobSchema.nullable().optional() }), { signal: active.signal })
      .then(async ({ understanding, lastSuccessfulUnderstanding, job }) => {
        if (active.signal.aborted) return;
        receive(understanding);
        const retained = lastSuccessfulUnderstanding === undefined ? understanding : lastSuccessfulUnderstanding;
        setLastSuccessful(retained?.briefing && retained.scanStatus !== "failed" ? retained : null);
        const matching = job && business.website && job.requestedUrl === new URL(business.website).href;
        setJob(matching ? job : null);
        const newerEvidence = matching && scanId && scanId !== job.scanId && scanCapturedAt
          && Date.parse(scanCapturedAt) > Date.parse(job.createdAt);
        if (matching && activeAnalysis(job)) await reconnect(job, active.signal);
        else if (matching && !newerEvidence && job.status !== "completed") {
          setJob(job); setError(job.error ?? "This analysis stopped. Retry explicitly when ready."); setState("idle");
        }
        else if (autoStart && (!matching || newerEvidence)) await run(active.signal, { reuseScan: true });
        else setState("idle");
      }).catch((error: unknown) => {
        if (!active.signal.aborted) { report(error); setState("idle"); }
      });
    return () => { active.abort(); controller.current?.abort(); };
  }, [business.id, business.website, autoStart, scanId, scanCapturedAt]);

  const busy = state !== "idle";
  const research = job?.research ?? retainedResearch ?? draft?.research;
  const displayedResearch = research ?? (initialView === "intelligence" && state !== "loading" ? {
    version: 1, status: "partial", enabled: false, steps: [],
    usage: { searches: 0, modelCalls: 0, competitorScans: 0 },
  } satisfies SavedResearch : undefined);
  const catalogueProducts = draft?.catalogue ? draft.catalogue.created + draft.catalogue.updated + draft.catalogue.unchanged : 0;
  const hasFindings = !!draft && (!!draft.briefing || !!draft.suggestions.length || !!draft.productImportId || catalogueProducts > 0
    || !!draft.research?.steps.some((step) => step.findings.length));
  const failed = draft?.scanStatus === "failed";
  const partial = draft?.scanStatus === "partial";
  const completed = !!draft?.reviewedAt;
  const live = state === "running";
  const resumable = !!job && activeAnalysis(job);
  const showResearchControls = !researchOnly || !draft || !hasFindings || !!error || failed || resumable;
  const visibleBriefing = live ? preview : failed ? null : draft?.briefing;
  const researchBriefing = live ? job?.research ? preview : null
    : !job?.research || job.understanding?.id === draft?.id ? visibleBriefing : null;
  const briefingKey = `${business.id}:${briefingRun}`;
  const heading = state === "running" ? job?.status === "queued" ? "Your business briefing is queued." : "Getting to know your business."
    : state === "saving" ? "Saving your business details."
    : job?.status === "cancelled" ? "Your analysis was cancelled."
    : saveError ? "Your changes haven't been saved yet."
    : coolingDown ? "Your next analysis is on cooldown."
    : error && retryAt ? "No new analysis was started."
    : error ? "This analysis couldn't finish."
    : completed ? "Your business understanding is saved."
    : failed ? "I couldn't analyse this website."
    : draft && !hasFindings ? "No supported findings yet."
    : draft?.briefing ? partial ? "Your business briefing, from a partial scan." : "Your business, explained."
    : draft?.suggestions.length ? partial ? "Profile suggestions from a partial scan." : "Saved profile suggestions."
    : draft?.productImportId || catalogueProducts > 0 ? "Your website products are ready."
    : research?.steps.some((step) => step.findings.length) ? "Research findings are saved."
    : "Let's understand your business.";
  function renderResearchOptions(forMarketComparison: boolean) {
    if (state !== "idle") return null;
    if (!showResearchControls) return null;
    return <details className="agent-rerun" open={!!error || !draft || failed || !hasFindings}>
      <summary className={forMarketComparison ? "primary-link" : undefined}>{forMarketComparison ? <>Build visual comparison<Icon name="arrow" /></>
        : resumable ? "Reconnect to background analysis" : draft ? "Run a new analysis (optional)" : "Start business analysis"}</summary>
      <div className="agent-controls">
        {!resumable && <><p className="field-note">Starting analysis confirms you own this website or have permission to scan it. Public website evidence goes to Anthropic and research queries go to Tavily. AI and search charges may apply. Nothing is published.</p>
          <details className="agent-sources"><summary>Analysis scope and providers</summary><p>{businessAnalysisDisclosure}</p></details></>}
        <button className="primary-link" type="button" disabled={!resumable && coolingDown} onClick={() => {
          const active = new AbortController(); controller.current?.abort(); controller.current = active;
          if (job && activeAnalysis(job)) void reconnect(job, active.signal);
          else void run(active.signal, { reuseScan: !!error, resumeAccepted: !!error });
        }}>{resumable ? "Reconnect to analysis" : forMarketComparison ? "Start visual market research" : error || failed ? "Retry business agent" : draft && !hasFindings ? "Try business analysis again" : draft ? "Refresh business understanding" : "Understand my business"}<Icon name="spark" /></button>
        {resumable && <button className="text-button" type="button" onClick={() => void cancel()}>Cancel analysis</button>}
        {!forMarketComparison && !resumable && research?.steps.some((step) => step.status === "failed") && job?.scanId && <button className="text-button" type="button" disabled={coolingDown} onClick={() => {
          const active = new AbortController(); controller.current?.abort(); controller.current = active;
          void run(active.signal, { reuseScan: true, resumeAccepted: true });
        }}>Retry failed research steps</button>}
        <p className="field-note">{resumable ? "Reconnecting does not start a new analysis or incur another AI charge."
          : forMarketComparison ? "Competitor research is included; nothing runs until you click Start visual market research."
          : "Saved usable website evidence is reused by default. To capture changes, read the website again in Website first. You approve all changes. AI charges may apply."}</p>
        {!resumable && <p className="field-note">Eligible saved Customer voice themes and their original review excerpts may also inform business recommendations. This does not collect new reviews or start an extra customer-analysis call.</p>}
      </div>
    </details>;
  }
  return <section className="profile-card agent-review workspace-form" aria-labelledby="agent-heading" aria-busy={busy && !live}>
    <div className={`card-heading${displayedResearch && !managementOnly ? " compact-agent-heading" : ""}${displayedResearch && !managementOnly && !busy && !error && !failed ? " sr-only" : ""}`}><p className="section-eyebrow"><Icon name="spark" /> YOUR BUSINESS AGENT</p><h2 id="agent-heading">{managementOnly && !busy && !error ? "Website analysis" : displayedResearch && !busy && !error && !failed ? business.name : heading}</h2>
      {managementOnly && !busy && <p>Review optional profile changes or explicitly approve another analysis. Saved findings remain in Overview and Market intelligence.</p>}
      {!managementOnly && !live && !displayedResearch && <p>{completed ? "Your profile changes are saved. The analysis stays available below; no need to approve the same suggestions again."
      : draft?.briefing ? "What the evidence says, why it matters, and useful next checks. Your briefing is saved automatically."
      : draft?.suggestions.length ? "These are profile suggestions, not a business briefing. You can edit and save them once, or run a new analysis for the briefing."
      : "With your permission, I'll read your public website and explain what I understand about your business, what is uncertain, and useful next checks."}</p>}</div>
    {!live && !completed && !draft?.briefing && <p className="field-note">Website: {business.website}</p>}
    {state === "loading" && <p role="status">Loading your latest business review...</p>}
    {live && <AnalysisProgress key={job?.id ?? briefingKey} job={job} phase={phase} reusingScan={reusingScan}
      showDetails={showProgressDetails} onCancel={() => void cancel()} />}
    {error && <p className="form-error" role="alert">{error}</p>}
    {coolingDown && <p className="field-note" role="status">No new analysis started. Retry available in {Math.ceil((retryAt - now) / 1000)} seconds. Saved findings remain available.</p>}
    {saveError && <p className="form-error" role="alert">{saveError}</p>}
    {researchOnly && !live && draft && (partial || !!draft.validationIssues?.length) && <p className="field-note" role="status">This saved analysis has limited evidence. Some pages or proposed findings could not be verified.</p>}
    {live && !job?.research && retainedResearch && <p className="field-note">Previously saved findings remain below while the new attempt starts.</p>}
    {displayedResearch && !managementOnly && (!live || !!researchBriefing || displayedResearch.steps.some((step) => step.findings.length || step.profile)) && <ResearchReport report={displayedResearch} businessName={business.name} briefing={researchBriefing}
      initialView={initialView}
      evidence={!live && researchBriefing ? draft?.briefing ?? undefined : undefined} briefingKey={briefingKey}
      previousBriefing={lastSuccessful}
      renderResearchOptions={showResearchControls ? renderResearchOptions : undefined} />}
    {!managementOnly && !displayedResearch && !visibleBriefing && lastSuccessful?.briefing && <section aria-label="Last successful Store briefing">
      <h3>Last successful Store briefing</h3>
      <p className="field-note">Saved on <time dateTime={lastSuccessful.createdAt}>{new Date(lastSuccessful.createdAt).toLocaleString()}</time>. This is the previous accepted result, not a new analysis.</p>
      <BusinessBriefing key={lastSuccessful.id} businessName={business.name} briefing={lastSuccessful.briefing} evidence={lastSuccessful.briefing} streaming={false} />
    </section>}
    {(live ? !!preview && !research : !!draft) && <div className={live ? "agent-live" : "agent-findings"} aria-label={live ? "Live business analysis" : "Saved business analysis"}>
      {live && <p className="field-note">Live draft - still being generated. Sources have not been checked and this has not been saved as a completed briefing.</p>}
      {!live && (failed ? <p className="form-error" role="alert">The website could not be read, so AI analysis could not run. Your saved profile and catalogue are unchanged. Try again or <a href="#website">view scan details in Website</a>.</p>
        : !hasFindings ? <p className="field-note" role="status">{partial ? "Only some public pages could be read." : "Public pages were read."} No evidence-backed briefing, profile suggestions or supported product listings could be prepared. Your saved profile and catalogue are unchanged.</p>
        : partial && !researchOnly && <p className="field-note" role="status">Some pages could not be read.</p>)}
      {!managementOnly && visibleBriefing && (!displayedResearch
        ? <BusinessBriefing key={briefingKey} businessName={business.name} briefing={visibleBriefing} evidence={live ? undefined : draft?.briefing ?? undefined} />
        : !live && !researchBriefing && displayedResearch.steps.some((step) => step.agent === "store" && step.findings.length > 0)
          && <details className="agent-sources"><summary>Previous saved briefing</summary>
            <BusinessBriefing key={briefingKey} businessName={business.name} briefing={visibleBriefing} evidence={draft?.briefing ?? undefined} />
          </details>)}
      {!live && draft && !researchOnly && <>
      {!!draft.validationIssues?.length && <p className="field-note" role="status">{partialBriefingNotice}</p>}
      {!draft.briefing && !draft.research && !failed && hasFindings && <p className="agent-legacy-note" role="status">This saved result does not include a business briefing. Run a new analysis to generate one; your profile will not be overwritten and no paid request starts automatically.</p>}
      <p className="field-note">{error ? "Previous saved analysis" : completed || draft.briefing ? "Saved analysis" : hasFindings ? "Draft" : "Analysis attempt"} from {new Date(draft.createdAt).toLocaleString()}.</p>
      {!!draft.suggestions.length && !completed && !failed && <details className="agent-profile-editor"><summary>Review optional profile changes</summary><p className="field-note">These fields are separate from the briefing. Edit them if needed, then save once. Your website and product catalogue will not change.</p><form className="agent-profile-form" onSubmit={(event) => void save(event)}>
        <fieldset disabled={busy}>
          <legend className="sr-only">Review your business details</legend>
          {draft.suggestions.map((suggestion) => <article className="agent-suggestion" key={suggestion.field}>
            <label>{suggestion.field === "category" ? "Category" : "Business description"}
              {suggestion.field === "category"
                ? <input name="agentCategory" value={profile.category} maxLength={120} onChange={(event) => setProfile({ ...profile, category: event.target.value })} />
                : <textarea name="agentDescription" rows={5} value={profile.description} maxLength={2000} onChange={(event) => setProfile({ ...profile, description: event.target.value })} />}
            </label>
            <SupportingEvidence sources={suggestion.sources} />
          </article>)}
          <button className="primary-link" type="submit">{state === "saving" ? "Saving..." : "Save to business profile"}<Icon name="check" /></button>
        </fieldset>
      </form></details>}
      {mode === "full" && (!!draft.productImportId || catalogueProducts > 0) && <details className="agent-product-review"><summary>Your website products</summary><article className="agent-suggestion"><h3>Open your product catalogue</h3><p>Usable website products are saved automatically, with source details and their own workspace. You can add missing products manually. Uncertain matches are never merged automatically.</p><a className="secondary-button" href={`#products?business=${business.id}`}>View products <Icon name="arrow" /></a></article></details>}
      </>}
    </div>}
    {(!displayedResearch || managementOnly) && renderResearchOptions(false)}
  </section>;
}
