import { useEffect, useRef, useState, type FormEvent } from "react";
import { growthPlanResponseSchema, growthWorkResponseSchema, type GrowthPlanItem, type GrowthWorkResponse } from "../shared/growth";
import { isActionGeneratedStep, workScopeLabels, workStepStatuses, type WorkSelection, type WorkStep } from "../shared/growth-work";
import { api, ApiFailure, errorMessage } from "./api";
import { SupportingEvidence } from "./BusinessBriefing";
import { journeyLink } from "./GrowthJourney";

export function GrowthActionWork({ businessId, actionId, onSessionExpired, onSaved, showAction = true }: {
  businessId: string; actionId: string; onSessionExpired: () => void; onSaved?: (item: GrowthPlanItem) => void;
  showAction?: boolean;
}) {
  const [data, setData] = useState<GrowthWorkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [scope, setScope] = useState<WorkSelection["scope"]>("business");
  const [selected, setSelected] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  const callbacks = useRef({ onSessionExpired, onSaved });
  callbacks.current = { onSessionExpired, onSaved };
  const endpoint = `/api/businesses/${businessId}/growth/${actionId}`;
  function report(error: unknown) {
    if (error instanceof ApiFailure && error.status === 401) callbacks.current.onSessionExpired();
    else setError(errorMessage(error));
  }
  function accept(snapshot: GrowthWorkResponse) {
    setData(snapshot);
    const selection = snapshot.opportunity.work?.selection;
    const suggestedScope = selection?.scope ?? snapshot.decision?.scope;
    setScope(suggestedScope && suggestedScope !== "unclear" ? suggestedScope : "business");
    setSelected(selection?.products.map((product) => product.productId) ?? snapshot.decision?.candidates.map((candidate) => candidate.productId) ?? []);
  }
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    setData(null); setLoading(true); setBusy(false); setError(""); setNotice("");
    void api(`${endpoint}/work`, growthWorkResponseSchema, { signal: active.signal })
      .then((snapshot) => { if (!active.signal.aborted) accept(snapshot); })
      .catch((error: unknown) => { if (!active.signal.aborted) report(error); })
      .finally(() => { if (!active.signal.aborted) setLoading(false); });
    return () => active.abort();
  }, [endpoint, reload]);
  async function mutate(path: string, method: "POST" | "PATCH", input: object, message: string) {
    if (busy || !controller.current || controller.current.signal.aborted) return;
    const signal = controller.current.signal;
    setBusy(true); setError(""); setNotice("");
    try {
      const snapshot = await api(`${endpoint}/work/${path}`, growthWorkResponseSchema,
        { method, body: JSON.stringify(input), signal }, 60_000);
      if (!signal.aborted) {
        accept(snapshot); setNotice(message);
        if (snapshot.item) callbacks.current.onSaved?.(snapshot.item);
      }
    } catch (error) { if (!signal.aborted) report(error); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  async function addToPlan() {
    if (busy || !controller.current) return;
    const signal = controller.current.signal;
    setBusy(true); setError("");
    try {
      const { item } = await api(`${endpoint}/plan`, growthPlanResponseSchema, { method: "POST", body: "{}", signal });
      if (!signal.aborted) { callbacks.current.onSaved?.(item); setReload((value) => value + 1); }
    } catch (error) { if (!signal.aborted) report(error); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  if (loading) return <p role="status">Loading this action's connected work...</p>;
  if (!data) return <p role="alert" className="form-error">{error} <button className="text-button" onClick={() => setReload((value) => value + 1)}>Reload action</button></p>;
  const work = data.opportunity.work;
  const item = data.item;
  const revision = item?.revision ?? 0;
  const productScope = scope === "product" || scope === "products";
  const validSelection = productScope ? scope === "product" ? selected.length === 1 : selected.length >= 2 && selected.length <= 8 : true;
  return <section className="journey-task connected-action-work" aria-label="Work on this growth action">
    <p className="section-eyebrow">CONNECTED TO YOUR GROWTH ACTION</p>
    {showAction ? <><h3>{data.opportunity.title}</h3><p>{data.opportunity.detail}</p></> : <h3>Choose targets and supporting work</h3>}
    {error && <p role="alert" className="form-error">{error} <button className="text-button" disabled={busy} onClick={() => setReload((value) => value + 1)}>Reload saved work</button></p>}
    {notice && <p role="status">{notice}</p>}
    {!item ? <div><p>Add this recommendation to your plan before confirming targets or saving supporting work.</p>
      <button className="primary-link" disabled={busy} onClick={() => void addToPlan()}>Add to my growth plan</button></div> : <>
      <section aria-label="Recommendation scope and product matching">
        <h4>{data.decision ? workScopeLabels[data.decision.scope] : "Choose where this action belongs"}</h4>
        {data.decision ? <><p>{data.decision.reason}</p><SupportingEvidence sources={data.decision.sources} />
          {data.decision.candidates.map((candidate) => <article className="action-match" key={candidate.productId}>
            <strong>{data.products.find((product) => product.id === candidate.productId)?.name ?? "Product no longer available"}</strong>
            <p>{candidate.reason}</p><SupportingEvidence sources={candidate.sources} />
          </article>)}</> : <p>Choose the scope manually, or ask the agent to assess the saved recommendation and catalogue. It may find that no product match is appropriate.</p>}
        {data.stale && <p role="alert">Product evidence changed since this decision or confirmation. Review current records and confirm again before generating steps.</p>}
        {data.configured && (!data.decision || data.stale) && <div>
          <p className="field-note">This sends the recommendation, its evidence and bounded saved catalogue excerpts to Anthropic. AI charges may apply. No new website scan or search is run.</p>
          <button className="secondary-button" disabled={busy} onClick={() => void mutate("decision", "POST", { consent: true, revision }, "Scope suggestions saved. Confirm the targets you approve.")}>
            {busy ? "Preparing guidance..." : "Ask agent to suggest scope and products"}
          </button>
        </div>}
        {!data.configured && <p className="field-note">AI guidance is unavailable on this server. Manual selection and saved work remain available.</p>}
        <form onSubmit={(event) => {
          event.preventDefault();
          if (validSelection) void mutate("selection", "PATCH", { revision, catalogueFingerprint: data.catalogueFingerprint, scope, productIds: productScope ? selected : [] },
            "Targets confirmed for this action. No product or website was changed.");
        }}>
          <fieldset disabled={busy}><legend>Your decision</legend>
            <label>Action scope<select value={scope} onChange={(event) => {
              const value = event.target.value as WorkSelection["scope"];
              setScope(value); if (value !== "product" && value !== "products") setSelected([]);
            }}>
              {(["product", "products", "business", "new_product"] as const).map((value) => <option key={value} value={value}>{workScopeLabels[value]}</option>)}
            </select></label>
            {productScope && <div className="action-target-options"><p>{scope === "product" ? "Choose one product." : "Choose two to eight products. A bundle may need different categories."}</p>
              {!data.products.length && <p>No saved products are available. Add catalogue products, choose a new-product concept, or keep this business-focused.</p>}
              {data.products.map((product) => <label key={product.id}>
                <input type={scope === "product" ? "radio" : "checkbox"} name="actionProduct" value={product.id} checked={selected.includes(product.id)}
                  onChange={(event) => setSelected(scope === "product" ? [product.id] : event.target.checked ? [...selected, product.id] : selected.filter((id) => id !== product.id))} />
                <span>{product.name}{product.sku ? ` (${product.sku})` : ""}</span>
                <a className="text-button" href={`${journeyLink("products", businessId, actionId)}&product=${product.id}&mode=action`}>Inspect product</a>
              </label>)}
            </div>}
            <p className="field-note">Confirming is your choice, not proof of suitability. Changing targets resets unapproved action-generated drafts; linked independent product suggestions stay separate.</p>
            <button className="primary-link" type="submit" disabled={!validSelection}>{work?.selection ? "Confirm current scope and targets" : "Confirm scope and targets"}</button>
          </fieldset>
        </form>
      </section>
      {work?.selection && <section aria-label="Action-specific supporting work">
        <h4>Supporting steps for this action</h4>
        <p>Confirmed: {workScopeLabels[work.selection.scope]}{work.selection.products.length ? ` — ${work.selection.products.map((selected) => data.products.find((product) => product.id === selected.productId)?.name ?? "Unavailable product").join(", ")}` : ""}.</p>
        {data.configured && !work.steps.some(isActionGeneratedStep) && <div>
          <p className="field-note">Generate steps for this action and its confirmed targets—not a general product analysis. This sends the saved action and selected catalogue excerpts to Anthropic; AI charges may apply.</p>
          <button className="secondary-button" disabled={busy || data.stale} onClick={() => void mutate("proposals", "POST", { consent: true, revision }, "Action-specific draft steps saved under this action.")}>Generate action-specific steps</button>
        </div>}
        {!work.steps.length && <p>No supporting steps saved yet.</p>}
      </section>}
      {work?.steps.map((step) => <WorkStepForm key={`${step.id}:${revision}`} step={step} busy={busy} onSave={(status, outcome) =>
        void mutate("steps", "PATCH", { revision, stepId: step.id, status, outcome }, "Supporting work updated. Status and results are owner-reported, not automatically verified.")} />)}
      <form className="workspace-form action-manual-step" onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        void mutate("steps", "POST", { revision, title: values.get("title"), detail: values.get("detail") }, "Your supporting step is saved as a draft under this action.");
      }}>
        <fieldset disabled={busy}><legend>Add a supporting step yourself</legend>
          <label>Step title<input name="title" required maxLength={150} /></label>
          <label>What you will do<textarea name="detail" required maxLength={600} rows={2} /></label>
          <button className="secondary-button" type="submit">Save draft step</button>
        </fieldset>
      </form>
    </>}
    <div className="journey-actions"><a className="text-button" href={journeyLink("actions", businessId, actionId)}>Back to this action</a>
      <a className="text-button" href={journeyLink("progress", businessId)}>Review my progress</a></div>
  </section>;
}

function WorkStepForm({ step, busy, onSave }: { step: WorkStep; busy: boolean; onSave: (status: WorkStep["status"], outcome: string) => void }) {
  const [status, setStatus] = useState(step.status), [outcome, setOutcome] = useState(step.outcome);
  return <article className="action-supporting-step">
    <h4>{step.title}</h4><p>{step.detail}</p>
    {step.productId && <p>Attached product suggestion</p>}
    <SupportingEvidence sources={step.sources} />
    <form onSubmit={(event) => { event.preventDefault(); onSave(status, outcome); }}>
      <fieldset disabled={busy}><legend>Record your work</legend>
        <label>Step status<select value={status} onChange={(event) => setStatus(event.target.value as WorkStep["status"])}>
          {workStepStatuses.map((value) => <option value={value} key={value}>{({ draft: "Draft", approved: "Approved by you", implemented: "Implemented by you", measured: "Result recorded by you" })[value]}</option>)}
        </select></label>
        <label>Observed result or notes<textarea value={outcome} required={status === "measured"} maxLength={1000} rows={2} onChange={(event) => setOutcome(event.target.value)} /></label>
        <button className="secondary-button" type="submit">Save step progress</button>
      </fieldset>
    </form>
  </article>;
}
