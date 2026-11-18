import { useEffect, useState } from "react";
import { growthResponseSchema, type GrowthOpportunity } from "../shared/growth";
import { api, ApiFailure, errorMessage } from "./api";
import { SupportingEvidence } from "./BusinessBriefing";
import { journeyLink } from "./GrowthJourney";

export function GrowthTaskContext({ businessId, actionId, onSessionExpired }: {
  businessId: string; actionId: string | null; onSessionExpired: () => void;
}) {
  const [action, setAction] = useState<GrowthOpportunity | null>(null);
  const [planned, setPlanned] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setAction(null); setPlanned(false); setError("");
    if (!businessId || !actionId) { setLoading(false); return; }
    setLoading(true);
    void api(`/api/businesses/${businessId}/growth`, growthResponseSchema, { signal: controller.signal }).then((growth) => {
      if (controller.signal.aborted) return;
      const selectedPlan = growth.plan.find((item) => item.opportunity.id === actionId);
      const selected = selectedPlan?.opportunity
        ?? growth.opportunities.find((item) => item.id === actionId);
      setPlanned(!!selectedPlan);
      if (selected) setAction(selected);
      else setError("This recommendation is no longer available. Return to your plan to choose another action.");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
      else setError(errorMessage(error));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [businessId, actionId, reload, onSessionExpired]);
  if (!actionId) return null;
  return <aside className="journey-task" aria-label="Selected growth recommendation">
    <p className="section-eyebrow">FROM YOUR GROWTH PLAN</p>
    {loading && <p role="status">Loading the evidence for this action...</p>}
    {error && <p role="alert" className="form-error">{error} <button type="button" className="text-button" onClick={() => setReload((value) => value + 1)}>Retry recommendation</button></p>}
    {action && <><h2>{action.title}</h2><p>{action.detail}</p>
      <p>Choose the relevant product below, review its recorded details, then make the edits you approve. This recommendation has not been applied and no product has been selected for you.</p>
      <SupportingEvidence sources={action.sources} /></>}
    <div className="journey-actions"><a className="text-button" href={journeyLink(planned ? "actions" : "growth", businessId, actionId)}>Back to this action</a>
      <a className="text-button" href={journeyLink("progress", businessId)}>Review my progress</a></div>
  </aside>;
}
