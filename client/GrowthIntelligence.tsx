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
import { journeyLink } from "./GrowthJourney";
import { GrowthActionWork } from "./GrowthActionWork";

const statusLabels = { planned: "Planned", in_progress: "In progress", completed: "Completed", dismissed: "Dismissed" };
const assessmentLabels = { unknown: "Not assessed", low: "Low", medium: "Medium", high: "High" };
const timelineLabels = { unknown: "Not assessed", days: "Days", weeks: "Weeks", months: "Months" };
function recommendationTitle(title: string) {
  return title.replace(/^\s*(?:experiment|research)\s+#?\d+\s*[:.)-]\s*/i, "").trim() || title;
}
function quadrant(item: GrowthPlanItem) {
  if (item.impact === "unknown" || item.effort === "unknown") return null;
  return item.impact === "high" ? item.effort === "low" ? "Quick wins" : "Strategic bets"
    : item.effort === "high" ? "Reconsider" : "Incremental improvements";
}
function ActionPlan({ opportunity }: { opportunity: GrowthOpportunity }) {
  const { strategy } = opportunity;
  const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  const shown = new Set([opportunity.title, opportunity.detail].map(normalize));
  const objective = strategy.objective.trim() && !shown.has(normalize(strategy.objective)) ? strategy.objective : null;
  if (objective) shown.add(normalize(objective));
  const actions = strategy.actions.filter((action) => {
    const key = normalize(action);
    if (!key || shown.has(key)) return false;
    shown.add(key);
    return true;
  });
  const hypothesis = strategy.hypothesis.trim()
    && normalize(strategy.hypothesis) !== normalize(`Test whether this recommendation improves the chosen metric: ${opportunity.title}`)
    ? strategy.hypothesis : null;
  return <div className="action-plan">
    <section className="action-proposal"><h3>What to try</h3><p>{opportunity.detail}</p></section>
    {objective && <section><h3>The goal</h3><p>{objective}</p></section>}
    {!!actions.length && <section><h3>Your next steps</h3><ol className="action-next-steps">
      {actions.map((action, index) => <li key={index}>{action}</li>)}
    </ol></section>}
    <section className="action-measurement"><h3>How to measure it</h3>
      <p><strong>Suggested measure:</strong> {strategy.metric}</p><p>{strategy.measurement}</p>
    </section>
    <details className="agent-sources action-background"><summary>Evidence and assumptions</summary>
      <div className="action-evidence-content">
        <dl className="action-evidence-summary">
          <div><dt>Research areas</dt><dd>{opportunity.agents.map((agent) => researchAgentLabels[agent]).join(", ")}</dd></div>
          <div><dt>Source pages</dt><dd>{new Set(opportunity.sources.map((source) => source.url)).size}</dd></div>
        </dl>
        {hypothesis && <section><h4>Assumption to test</h4><p>{hypothesis}</p></section>}
        <SupportingEvidence sources={opportunity.sources} />
        <details className="action-research-notes"><summary>Research notes</summary>
          <p>{opportunity.reviewReason}</p>
        </details>
      </div>
    </details>
  </div>;
}
function Strategy({ opportunity, businessId, planned = false, onSessionExpired, onSaved }: {
  opportunity: GrowthOpportunity; businessId: string; planned?: boolean;
  onSessionExpired: () => void; onSaved: (item: GrowthPlanItem) => void;
}) {
  return <Sheet><SheetTrigger asChild><Button variant="outline">Explore strategy<ArrowRight /></Button></SheetTrigger>
    <SheetContent className="research-drawer"><SheetHeader>
      <p className="section-eyebrow">GROWTH RECOMMENDATION</p><SheetTitle>{recommendationTitle(opportunity.title)}</SheetTitle>
      <SheetDescription>Review the recommendation and plan your next steps. Nothing has been launched or changed for you.</SheetDescription>
    </SheetHeader><div className="research-drawer-body growth-strategy">
      <ActionPlan opportunity={opportunity} />
      <GrowthActionWork businessId={businessId} actionId={opportunity.id} showAction={false} onSessionExpired={onSessionExpired} onSaved={onSaved} />
      {planned && <div className="journey-actions strategy-work-link"><Button asChild><a href={journeyLink("actions", businessId, opportunity.id)}>Work on this action<ArrowRight /></a></Button></div>}
      <section className="strategy-tools" aria-label="Optional tools">
        <h3>Continue with a tool</h3>
        <p>Work on confirmed targets in Products, or explore a business-level sales scenario using your own assumptions.</p>
        <div className="strategy-tool-links">
          <Button asChild><a href={journeyLink("products", businessId, opportunity.id)}>Open connected product workspace<ArrowRight /></a></Button>
          <Button asChild variant="outline"><a href={`#simulator?${new URLSearchParams({ business: businessId, action: opportunity.id })}`}>Explore in Growth Simulator<ArrowRight /></a></Button>
        </div>
      </section>
    </div></SheetContent>
  </Sheet>;
}
function AssessmentForm({ item, saving, onSave }: {
  item: GrowthPlanItem; saving: boolean; onSave: (event: FormEvent<HTMLFormElement>, item: GrowthPlanItem) => void;
}) {
  return <form className="growth-assessment" onSubmit={(event) => onSave(event, item)}>
    <fieldset disabled={saving}><legend>Set your priorities</legend>
      <label>Status<select name="status" defaultValue={item.status}>{growthStatuses.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></label>
      <label>Potential impact<select name="impact" defaultValue={item.impact}>{growthAssessment.map((level) => <option key={level} value={level}>{assessmentLabels[level]}</option>)}</select></label>
      <label>Effort required<select name="effort" defaultValue={item.effort}>{growthAssessment.map((level) => <option key={level} value={level}>{assessmentLabels[level]}</option>)}</select></label>
      <label>Time to see results<select name="timeToValue" defaultValue={item.timeToValue}>{growthTimelines.map((time) => <option key={time} value={time}>{timelineLabels[time]}</option>)}</select></label>
      <Button variant="outline" type="submit">{saving ? "Saving..." : "Save assessment"}</Button>
    </fieldset>
  </form>;
}

function ActionStatusForm({ item, saving, onSave }: {
  item: GrowthPlanItem; saving: boolean; onSave: (event: FormEvent<HTMLFormElement>, item: GrowthPlanItem) => void;
}) {
  return <form className="growth-action-status" onSubmit={(event) => onSave(event, item)}>
    <fieldset disabled={saving}><legend>Record your work</legend>
      <label>Work status<select name="status" defaultValue={item.status}>{growthStatuses.map((status) =>
        <option key={status} value={status}>{status === "completed" ? "Marked complete by me" : statusLabels[status]}</option>)}</select></label>
      <input type="hidden" name="impact" value={item.impact} /><input type="hidden" name="effort" value={item.effort} />
      <input type="hidden" name="timeToValue" value={item.timeToValue} />
      <Button variant="outline" type="submit">{saving ? "Saving..." : "Save status"}</Button>
    </fieldset>
  </form>;
}

export function GrowthIntelligence({ business, onSessionExpired, onPlanSaved, actionOnly = false }: {
  business: Business; onSessionExpired: () => void; onPlanSaved?: () => void; actionOnly?: boolean;
}) {
  const [context, setContext] = useState(() => new URLSearchParams(window.location.hash.split("?")[1] ?? ""));
  const [data, setData] = useState<GrowthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [notice, setNotice] = useState("");
  const [savingId, setSavingId] = useState("");
  const [reload, setReload] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [workView, setWorkView] = useState<"active" | "completed" | "dismissed">("active");
  const [expandedActionId, setExpandedActionId] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const followLink = () => setContext(new URLSearchParams(window.location.hash.split("?")[1] ?? ""));
    window.addEventListener("hashchange", followLink);
    return () => window.removeEventListener("hashchange", followLink);
  }, []);
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
  useEffect(() => {
    if (context.get("business") !== business.id) return;
    const actionId = context.get("action");
    if (!actionId) return;
    if (actionOnly) {
      const selected = data?.plan.find((item) => item.opportunity.id === actionId);
      if (selected) setWorkView(selected.status === "completed" || selected.status === "dismissed" ? selected.status : "active");
    }
  }, [business.id, context, data, actionOnly]);
  useEffect(() => {
    if (context.get("business") !== business.id) return;
    const actionId = context.get("action");
    if (!actionId) return;
    const target = document.getElementById(`growth-action-${actionId}`) ?? document.getElementById(`growth-opportunity-${actionId}`);
    if (target instanceof HTMLDetailsElement) { target.open = true; target.querySelector("summary")?.focus(); }
    else if (target) target.focus();
    else if (!actionOnly && data?.opportunities.some((item) => item.id === actionId)) setShowAll(true);
  }, [business.id, context, data, actionOnly, workView, showAll]);
  function acceptSaved(saved: GrowthPlanItem) {
    setData((current) => current && ({ ...current, plan: [...current.plan.filter((entry) => entry.opportunity.id !== saved.opportunity.id), saved] }));
    onPlanSaved?.();
  }
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
      acceptSaved(saved);
      setNotice(item ? `${actionOnly ? "Your action status" : "Your planning assessment"} is saved. Completion is owner-reported, not measured growth.` : "Added to your growth plan. No website change or campaign has been made.");
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
  const primary = available[0];
  const moreOpportunities = available.slice(1);
  if (actionOnly) {
    const visible = workView === "active" ? [...pending].sort((a, b) => Number(b.status === "in_progress") - Number(a.status === "in_progress"))
      : data.plan.filter((item) => item.status === workView);
    const requestedAction = context.get("business") === business.id ? context.get("action") : null;
    return <section className="growth-intelligence action-workspace" aria-label={`Action workspace for ${business.name}`}>
      <div className="dashboard-intro"><div><p className="section-eyebrow">YOUR CHOSEN ACTIONS. YOUR NEXT STEPS.</p>
        <h2>Put your plan into practice.</h2><p>Work through the actions you chose, then record what you did. Nothing is executed or published automatically.</p></div>
        <Button asChild variant="outline"><a href={journeyLink("growth", business.id)}>Choose or assess an action<ArrowRight /></a></Button></div>
      {error && <p role="alert" className="form-error">{error}</p>}
      {mutationError && <p role="alert" className="form-error">{mutationError}</p>}
      {notice && <p role="status" className="dashboard-notice">{notice}</p>}
      {requestedAction && !data.plan.some((item) => item.opportunity.id === requestedAction) && <p role="alert" className="form-error">
        This action is not in this business's saved plan. <a className="text-button" href={journeyLink("growth", business.id, requestedAction)}>Review recommendations before adding an action.</a>
      </p>}
      <div className="journey-actions action-filters" aria-label="Filter plan actions">
        {(["active", "completed", "dismissed"] as const).map((value) => <Button key={value} variant={workView === value ? "default" : "outline"}
          aria-pressed={workView === value} onClick={() => setWorkView(value)}>{value === "active" ? `To do & in progress (${pending.length})`
            : `${value === "completed" ? "Marked complete" : "Dismissed"} (${data.plan.filter((item) => item.status === value).length})`}</Button>)}
      </div>
      {!visible.length && <Card><CardContent><h3>{!data.plan.length ? "No chosen actions yet." : workView === "active" ? "No open actions." : `No ${workView} actions.`}</h3>
        <p>{!data.plan.length ? "Choose an opportunity in Decide and add it to your plan. Your product catalogue stays separate."
          : "Use the filters to review your saved work, or return to Decide to choose another action."}</p>
        <Button asChild variant="outline"><a href={journeyLink("growth", business.id)}>Review opportunities<ArrowRight /></a></Button></CardContent></Card>}
      {visible.map((item, index) => <details className="agent-sources growth-plan-item" open={index === 0} key={item.opportunity.id} id={`growth-action-${item.opportunity.id}`}
        onToggle={(event) => { if (event.currentTarget.open) setExpandedActionId(item.opportunity.id); }}>
        <summary>{recommendationTitle(item.opportunity.title)} <Badge variant="outline">{item.status === "completed" ? "Marked complete by you" : statusLabels[item.status]}</Badge></summary>
        <div className="growth-plan-body">
          <ActionPlan opportunity={item.opportunity} />
          {(expandedActionId === item.opportunity.id || requestedAction === item.opportunity.id || !requestedAction && index === 0) &&
            <GrowthActionWork businessId={business.id} actionId={item.opportunity.id} showAction={false} onSessionExpired={onSessionExpired} onSaved={acceptSaved} />}
          <details className="agent-sources action-tools"><summary>Optional tools for this action</summary>
            <p>Open the same action and targets in Products, or explore a business-level sales scenario.</p>
            <div className="journey-actions"><Button asChild variant="outline"><a href={journeyLink("products", business.id, item.opportunity.id)}>Open connected product workspace<ArrowRight /></a></Button>
              <Button asChild variant="ghost"><a href={journeyLink("simulator", business.id, item.opportunity.id)}>Explore a what-if<ArrowRight /></a></Button></div>
          </details>
          <ActionStatusForm key={`${item.opportunity.id}:${item.revision}`} item={item} saving={!!savingId} onSave={(event, item) => void save(item.opportunity, item, event)} />
          <p className="field-note">Updated <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString()}</time></p>
        </div>
      </details>)}
      <div className="journey-actions"><Button asChild variant="outline"><a href={journeyLink("progress", business.id)}>Review my progress<ArrowRight /></a></Button>
        <Button variant="ghost" disabled={loading || !!savingId} onClick={() => setReload((value) => value + 1)}>{loading ? "Loading..." : "Reload saved actions"}</Button></div>
    </section>;
  }
  return <section className="growth-intelligence" aria-label={`Growth intelligence for ${business.name}`}>
    <div className="growth-context"><p className="section-eyebrow">SAVED EVIDENCE. YOUR NEXT MOVE.</p>
      <Badge variant="outline">{data.researchStatus === "unavailable" ? data.plan.length ? "Saved plan evidence" : "Needs saved research" : data.researchStatus === "partial" ? "Partial evidence" : data.researchStatus === "running" ? "Research in progress" : "Saved evidence"}</Badge>
    </div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {mutationError && <p role="alert" className="form-error">{mutationError}</p>}
    {notice && <p role="status" className="dashboard-notice">{notice}</p>}
    {(primary || !data.plan.length) && <BlurFade duration={0.25} blur="2px"><Card className="growth-next-move">
      <CardHeader id={primary ? `growth-opportunity-${primary.id}` : undefined} tabIndex={primary ? -1 : undefined}>
        <CardDescription>{primary ? "Suggested experiment" : "Growth plan"}</CardDescription>
        <CardTitle><h2>{primary ? recommendationTitle(primary.title) : "Gathering evidence before your next move."}</h2></CardTitle></CardHeader>
      <CardContent>{primary ? <><p className="dashboard-clamped growth-experiment-description">{primary.detail}</p>
        <div className="growth-card-actions"><Strategy opportunity={primary} businessId={business.id} onSessionExpired={onSessionExpired} onSaved={acceptSaved} /><Button disabled={!!savingId} onClick={() => void save(primary)}>
          {savingId === primary.id ? "Saving..." : "Add to my growth plan"}</Button></div></>
        : <><p>Your next recommendation will appear here after the evidence is reviewed.</p>
          <a className="text-button" href={`#overview?view=business&business=${business.id}`}>Manage website analysis<ArrowRight className="inline size-4" /></a></>}
      </CardContent>
    </Card></BlurFade>}
    <div className="growth-summary" aria-label="Growth plan summary">
      <Card><CardContent><Lightbulb /><strong>{data.opportunities.length}</strong><span>Research recommendations</span></CardContent></Card>
      <Card><CardContent><Target /><strong>{pending.filter((item) => item.impact === "high").length}</strong><span>Owner-rated high impact</span></CardContent></Card>
      <Card><CardContent><CheckCircle2 /><strong>{active.filter((item) => item.status === "completed").length}/{active.length}</strong><span>Plan actions marked complete</span></CardContent></Card>
    </div>
    {!!moreOpportunities.length && <section aria-labelledby="growth-opportunities-heading"><div className="dashboard-intro"><div>
      <h3 id="growth-opportunities-heading">More opportunities to review</h3>
      <p>Potential, not predicted uplift. Review source coverage and assess impact before committing.</p>
    </div></div>
      <div className="opportunity-grid">{moreOpportunities.slice(0, showAll ? moreOpportunities.length : 3).map((opportunity) => <Card key={opportunity.id} className="opportunity-card">
        <CardHeader id={`growth-opportunity-${opportunity.id}`} tabIndex={-1}><Badge variant="secondary">{opportunity.agents.map((agent) => researchAgentLabels[agent]).join(" + ")}</Badge>
          <CardTitle><h4>{recommendationTitle(opportunity.title)}</h4></CardTitle></CardHeader>
        <CardContent><p className="dashboard-clamped">{opportunity.detail}</p>
          <div className="growth-card-actions"><Strategy opportunity={opportunity} businessId={business.id} onSessionExpired={onSessionExpired} onSaved={acceptSaved} /><Button disabled={!!savingId} onClick={() => void save(opportunity)}>
            {savingId === opportunity.id ? "Saving..." : "Add to my growth plan"}</Button></div>
        </CardContent>
      </Card>)}</div>
      {moreOpportunities.length > 3 && <Button variant="ghost" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show fewer opportunities" : `View all ${moreOpportunities.length} more opportunities`}</Button>}
    </section>}
    <details className="agent-sources growth-map"><summary>Growth opportunity map ({assessed.length} assessed actions)</summary>
      <p>Based on your planning estimates, not measured growth. High impact + low effort = quick win; high impact + medium/high effort = strategic bet. Other assessed actions are incremental unless effort is high.</p>
      <div className="growth-matrix">{["Quick wins", "Strategic bets", "Incremental improvements", "Reconsider"].map((label) => <section key={label} aria-label={label}>
        <h4>{label}</h4>{assessed.filter((item) => quadrant(item) === label).length
          ? <ul>{assessed.filter((item) => quadrant(item) === label).map((item) => <li key={item.opportunity.id}><button className="text-button" type="button" onClick={() => {
            const action = document.getElementById(`growth-action-${item.opportunity.id}`);
            if (action instanceof HTMLDetailsElement) { action.open = true; action.querySelector("summary")?.focus(); }
          }}>{recommendationTitle(item.opportunity.title)}</button></li>)}</ul>
          : <p className="field-note">No assessed actions here.</p>}
      </section>)}</div>
      <p className="field-note">{pending.length - assessed.length} actions need an impact and effort assessment before appearing on the map.</p>
    </details>
    <section aria-labelledby="growth-plan-heading"><div className="dashboard-intro"><div><h3 id="growth-plan-heading">Your growth action plan</h3>
      <p>Saved for this business. Status tracks your work, not proven business results.</p></div>
      <Button asChild variant="outline"><a href={journeyLink("progress", business.id)}>Review my progress<ArrowRight /></a></Button></div>
      {!data.plan.length && <p>Add a recommendation above to start your plan. Nothing is published or executed automatically.</p>}
      {!!data.plan.length && <p className="field-note">{pending.length
        ? "Assessed actions come first, then higher owner-rated impact, lower effort and shorter time to value. Unassessed actions still need review."
        : "No pending growth actions. Review your completed or dismissed work before choosing another move."}</p>}
      {[...ranked, ...data.plan.filter((item) => item.status === "completed" || item.status === "dismissed")].map((item) =>
        <details className="agent-sources growth-plan-item" key={item.opportunity.id} id={`growth-action-${item.opportunity.id}`}>
          <summary>{recommendationTitle(item.opportunity.title)} <Badge variant="outline">{statusLabels[item.status]}</Badge></summary>
          <div className="growth-plan-body">
            <section className="growth-plan-overview"><h4>Suggested action</h4><p>{item.opportunity.detail}</p></section>
            <div className="journey-actions growth-plan-actions"><Strategy opportunity={item.opportunity} businessId={business.id} planned onSessionExpired={onSessionExpired} onSaved={acceptSaved} />
              <Button asChild><a href={journeyLink("actions", business.id, item.opportunity.id)}>Work on this action<ArrowRight /></a></Button></div>
            <details className="agent-sources growth-plan-notes"><summary>About this saved recommendation</summary>
              <p>Based on the evidence available when you added this action. New research does not update it automatically.</p>
              {!data.opportunities.some((opportunity) => opportunity.id === item.opportunity.id) && <p className="field-note">This action is from earlier research. Review its sources before starting.</p>}
            </details>
            <AssessmentForm key={`${item.opportunity.id}:${item.revision}`} item={item} saving={!!savingId} onSave={(event, item) => void save(item.opportunity, item, event)} />
          </div>
        </details>)}
    </section>
    <div className="growth-footer">
      <Button variant="ghost" disabled={loading || !!savingId} onClick={() => setReload((value) => value + 1)}>{loading ? "Loading..." : "Reload saved findings"}</Button>
    </div>
  </section>;
}
