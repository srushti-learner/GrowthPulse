import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, CheckCircle2, Lightbulb, Target } from "lucide-react";
import type { Business } from "../shared/contracts";
import {
  growthAssessment, growthPlanInputSchema, growthPlanResponseSchema, growthResponseSchema, growthStatuses, growthTimelines,
  type GrowthOpportunity, type GrowthPlanItem, type GrowthResponse,
} from "../shared/growth";
import { researchAgentLabels } from "../shared/research";
import { api, ApiFailure, errorMessage } from "./api";
import { SupportingEvidence } from "./BusinessBriefing";
import { Badge } from "./components/ui/badge";
import { BlurFade } from "./components/ui/blur-fade";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./components/ui/sheet";

const statusLabels = { planned: "Planned", in_progress: "In progress", completed: "Completed", dismissed: "Dismissed" };
const assessmentLabels = { unknown: "Not assessed", low: "Low", medium: "Medium", high: "High" };
const timelineLabels = { unknown: "Not assessed", days: "Days", weeks: "Weeks", months: "Months" };
function quadrant(item: GrowthPlanItem) {
  if (item.impact === "unknown" || item.effort === "unknown") return null;
  return item.impact === "high" ? item.effort === "low" ? "Quick wins" : "Strategic bets"
    : item.effort === "high" ? "Reconsider" : "Incremental improvements";
}
function Strategy({ opportunity, businessId }: { opportunity: GrowthOpportunity; businessId: string }) {
  return <Sheet><SheetTrigger asChild><Button variant="outline">Explore strategy<ArrowRight /></Button></SheetTrigger>
    <SheetContent className="research-drawer"><SheetHeader>
      <p className="section-eyebrow">GROWTH RECOMMENDATION</p><SheetTitle>{opportunity.title}</SheetTitle>
      <SheetDescription>A planning scaffold from saved AI findings, not an executed change or a promised outcome.</SheetDescription>
    </SheetHeader><div className="research-drawer-body growth-strategy">
      <h3>Why consider it</h3><p>{opportunity.detail}</p>
      <p className="field-note">{opportunity.reviewReason}</p>
      <h3>Objective</h3><p>{opportunity.strategy.objective}</p>
      <h3>Suggested action sequence</h3><ol>{opportunity.strategy.actions.map((action, index) => <li key={index}>{action}</li>)}</ol>
      <h3>Experiment proposal</h3><p>{opportunity.strategy.hypothesis}</p>
      <p><strong>Suggested metric:</strong> {opportunity.strategy.metric}</p>
      <p>{opportunity.strategy.measurement}</p>
      <p className="field-note">There is no automatic outcome tracking. Import sales or enter owner records in the Growth Simulator, then choose your own assumptions. Baseline, impact, effort and time to value still need owner validation. No experiment or campaign has been launched.</p>
      <Button asChild variant="outline"><a href={`#simulator?${new URLSearchParams({ business: businessId, action: opportunity.id })}`}>Explore in Growth Simulator<ArrowRight /></a></Button>
      <h3>Supporting evidence</h3><SupportingEvidence sources={opportunity.sources} />
    </div></SheetContent>
  </Sheet>;
}
function AssessmentForm({ item, saving, onSave }: {
  item: GrowthPlanItem; saving: boolean; onSave: (event: FormEvent<HTMLFormElement>, item: GrowthPlanItem) => void;
}) {
  return <form className="growth-assessment" onSubmit={(event) => onSave(event, item)}>
    <fieldset disabled={saving}><legend>Your planning assessment</legend>
      <label>Status<select name="status" defaultValue={item.status}>{growthStatuses.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></label>
      <label>Potential impact<select name="impact" defaultValue={item.impact}>{growthAssessment.map((level) => <option key={level} value={level}>{assessmentLabels[level]}</option>)}</select></label>
      <label>Implementation effort<select name="effort" defaultValue={item.effort}>{growthAssessment.map((level) => <option key={level} value={level}>{assessmentLabels[level]}</option>)}</select></label>
      <label>Time to value<select name="timeToValue" defaultValue={item.timeToValue}>{growthTimelines.map((time) => <option key={time} value={time}>{timelineLabels[time]}</option>)}</select></label>
      <Button variant="outline" type="submit">{saving ? "Saving..." : "Save assessment"}</Button>
    </fieldset>
  </form>;
}

export function GrowthIntelligence({ business, onSessionExpired }: { business: Business; onSessionExpired: () => void }) {
  const [data, setData] = useState<GrowthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [notice, setNotice] = useState("");
  const [savingId, setSavingId] = useState("");
  const [reload, setReload] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    setLoading(true); setError(""); setMutationError("");
    void api(`/api/businesses/${business.id}/growth`, growthResponseSchema, { signal: active.signal })
      .then((result) => { if (!active.signal.aborted) setData(result); })
      .catch((error: unknown) => {
        if (active.signal.aborted) return;
        if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
        else setError(errorMessage(error));
      }).finally(() => { if (!active.signal.aborted) setLoading(false); });
    return () => active.abort();
  }, [business.id, business.website, reload, onSessionExpired]);
  async function save(opportunity: GrowthOpportunity, item?: GrowthPlanItem, event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (savingId || !controller.current || controller.current.signal.aborted) return;
    const signal = controller.current.signal;
    const form = event ? new FormData(event.currentTarget) : undefined;
    const parsed = item && form ? growthPlanInputSchema.safeParse({
      status: form.get("status"), impact: form.get("impact"), effort: form.get("effort"), timeToValue: form.get("timeToValue"), revision: item.revision,
    }) : null;
    if (parsed && !parsed.success) { setMutationError("Choose valid planning assessments before saving."); return; }
    const input = parsed?.data ?? {};
    setSavingId(opportunity.id); setMutationError(""); setNotice("");
    try {
      const { item: saved } = await api(`/api/businesses/${business.id}/growth/${opportunity.id}/plan`, growthPlanResponseSchema, {
        method: item ? "PATCH" : "POST", body: JSON.stringify(input), signal,
      });
      if (signal.aborted) return;
      setData((current) => current && ({ ...current, plan: [...current.plan.filter((entry) => entry.opportunity.id !== saved.opportunity.id), saved] }));
      setNotice(item ? "Your planning assessment is saved. Completion is owner-reported, not measured growth." : "Added to your growth plan. No website change or campaign has been made.");
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
      else setMutationError(errorMessage(error));
    } finally { if (!signal.aborted) setSavingId(""); }
  }
  if (loading && !data) return <p role="status">Loading saved growth intelligence...</p>;
  if (error && !data) return <div role="alert" className="form-error">{error} <button type="button" className="text-button" onClick={() => setReload((value) => value + 1)}>Reload growth intelligence</button></div>;
  if (!data) return null;
  const active = data.plan.filter((item) => item.status !== "dismissed");
  const pending = active.filter((item) => item.status !== "completed");
  const assessed = pending.filter((item) => quadrant(item));
  const ranked = [...pending].sort((a, b) => {
    const impact = { unknown: 0, low: 1, medium: 2, high: 3 };
    const effort = { unknown: 0, low: 3, medium: 2, high: 1 };
    const time = { unknown: 0, days: 3, weeks: 2, months: 1 };
    return Number(!!quadrant(b)) - Number(!!quadrant(a)) || impact[b.impact] - impact[a.impact]
      || effort[b.effort] - effort[a.effort] || time[b.timeToValue] - time[a.timeToValue]
      || a.opportunity.id.localeCompare(b.opportunity.id);
  });
  const available = data.opportunities.filter((opportunity) => !data.plan.some((item) => item.opportunity.id === opportunity.id));
  const primary = ranked[0]?.opportunity ?? available[0];
  const hasSavedActions = !!(data.opportunities.length || data.plan.length);
  return <section className="growth-intelligence" aria-label={`Growth intelligence for ${business.name}`}>
    <div className="growth-context"><p className="section-eyebrow">SAVED EVIDENCE. YOUR NEXT MOVE.</p>
      <Badge variant="outline">{data.researchStatus === "unavailable" ? data.plan.length ? "Saved plan evidence" : "Needs saved research" : data.researchStatus === "partial" ? "Partial evidence" : data.researchStatus === "running" ? "Research in progress" : "Saved evidence"}</Badge>
    </div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {mutationError && <p role="alert" className="form-error">{mutationError}</p>}
    {notice && <p role="status" className="dashboard-notice">{notice}</p>}
    <BlurFade duration={0.25} blur="2px"><Card className="growth-next-move">
      <CardHeader><CardDescription>{ranked.length ? "YOUR FIRST PLANNED MOVE" : "START YOUR REVIEW HERE"}</CardDescription>
        <CardTitle><h2>{primary?.title ?? (hasSavedActions ? "No pending growth actions." : "Gather evidence before choosing a growth move.")}</h2></CardTitle></CardHeader>
      <CardContent>{primary ? <><p>{primary.detail}</p><p className="field-note">{ranked.length
        ? "Assessed actions come first, then higher owner-rated impact, lower effort and shorter time to value. Unassessed actions still need review."
        : primary.reviewReason}</p><Strategy opportunity={primary} businessId={business.id} /></>
        : <><p>{hasSavedActions ? "Review completed or dismissed actions below before choosing another move."
          : "No accepted growth suggestions are available. Missing evidence is not proof of a business problem."}</p>
          <a className="text-button" href="#business">Manage website analysis<ArrowRight className="inline size-4" /></a></>}
      </CardContent>
    </Card></BlurFade>
    <div className="growth-summary" aria-label="Growth plan summary">
      <Card><CardContent><Lightbulb /><strong>{data.opportunities.length}</strong><span>Research recommendations</span></CardContent></Card>
      <Card><CardContent><Target /><strong>{pending.filter((item) => item.impact === "high").length}</strong><span>Owner-rated high impact</span></CardContent></Card>
      <Card><CardContent><CheckCircle2 /><strong>{active.filter((item) => item.status === "completed").length}/{active.length}</strong><span>Plan actions marked complete</span></CardContent></Card>
    </div>
    <section aria-labelledby="growth-opportunities-heading"><div className="dashboard-intro"><div>
      <h3 id="growth-opportunities-heading">Your biggest opportunities to review</h3>
      <p>Potential, not predicted uplift. Review source coverage and assess impact before committing.</p>
    </div></div>
      <div className="opportunity-grid">{available.slice(0, showAll ? available.length : 3).map((opportunity) => <Card key={opportunity.id} className="opportunity-card">
        <CardHeader><Badge variant="secondary">{opportunity.agents.map((agent) => researchAgentLabels[agent]).join(" + ")}</Badge>
          <CardTitle><h4>{opportunity.title}</h4></CardTitle></CardHeader>
        <CardContent><p className="dashboard-clamped">{opportunity.detail}</p>
          <p className="field-note">Impact / effort: not assessed. Evidence: {new Set(opportunity.sources.map((source) => source.url)).size} captured page(s), needs validation.</p>
          <div className="growth-card-actions"><Strategy opportunity={opportunity} businessId={business.id} /><Button disabled={!!savingId} onClick={() => void save(opportunity)}>
            {savingId === opportunity.id ? "Saving..." : "Add to my growth plan"}</Button></div>
        </CardContent>
      </Card>)}</div>
      {!available.length && <p className="field-note">{data.opportunities.length ? "All current recommendations are already in your plan below, including dismissed actions." : "No new recommendation has been invented to fill this view."}</p>}
      {available.length > 3 && <Button variant="ghost" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show fewer opportunities" : `View all ${available.length} opportunities`}</Button>}
    </section>
    <details className="agent-sources growth-map"><summary>Growth opportunity map ({assessed.length} assessed actions)</summary>
      <p>Based on your planning estimates, not measured growth. High impact + low effort = quick win; high impact + medium/high effort = strategic bet. Other assessed actions are incremental unless effort is high.</p>
      <div className="growth-matrix">{["Quick wins", "Strategic bets", "Incremental improvements", "Reconsider"].map((label) => <section key={label} aria-label={label}>
        <h4>{label}</h4>{assessed.filter((item) => quadrant(item) === label).length
          ? <ul>{assessed.filter((item) => quadrant(item) === label).map((item) => <li key={item.opportunity.id}><button className="text-button" type="button" onClick={() => {
            const action = document.getElementById(`growth-action-${item.opportunity.id}`);
            if (action instanceof HTMLDetailsElement) { action.open = true; action.querySelector("summary")?.focus(); }
          }}>{item.opportunity.title}</button></li>)}</ul>
          : <p className="field-note">No assessed actions here.</p>}
      </section>)}</div>
      <p className="field-note">{pending.length - assessed.length} actions need an impact and effort assessment before appearing on the map.</p>
    </details>
    <section aria-labelledby="growth-plan-heading"><div className="dashboard-intro"><div><h3 id="growth-plan-heading">Your growth action plan</h3>
      <p>Saved locally for this business. Status tracks your work, not proven business results.</p></div></div>
      {!data.plan.length && <p>Add a recommendation above to start your plan. Nothing is published or executed automatically.</p>}
      {[...ranked, ...data.plan.filter((item) => item.status === "completed" || item.status === "dismissed")].map((item) =>
        <details className="agent-sources growth-plan-item" key={item.opportunity.id} id={`growth-action-${item.opportunity.id}`}>
          <summary>{item.opportunity.title} <Badge variant="outline">{statusLabels[item.status]}</Badge></summary>
          {!data.opportunities.some((opportunity) => opportunity.id === item.opportunity.id) && <p className="field-note">Saved plan evidence, separate from the current business-wide research. Recheck it before acting.</p>}
          <p className="field-note">This plan keeps the evidence saved when the action was added. New research does not refresh it automatically.</p>
          <p>{item.opportunity.detail}</p><Strategy opportunity={item.opportunity} businessId={business.id} />
          <AssessmentForm key={`${item.opportunity.id}:${item.revision}`} item={item} saving={!!savingId} onSave={(event, item) => void save(item.opportunity, item, event)} />
        </details>)}
    </section>
    <div className="growth-footer">
      <Button variant="ghost" disabled={loading || !!savingId} onClick={() => setReload((value) => value + 1)}>{loading ? "Loading..." : "Reload saved findings"}</Button>
    </div>
  </section>;
}
