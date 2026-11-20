import { useEffect, useRef, useState } from "react";
import { growthPlanResponseSchema, growthResponseSchema, type GrowthPlanItem } from "../shared/growth";
import { api, ApiFailure, errorMessage } from "./api";

export function AttachProductImprovement({ businessId, productId, analysisId, index, disabled, onSessionExpired }: {
  businessId: string; productId: string; analysisId: string; index: number; disabled: boolean; onSessionExpired: () => void;
}) {
  const [open, setOpen] = useState(false), [plan, setPlan] = useState<GrowthPlanItem[]>([]);
  const [selected, setSelected] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError(""); setPlan([]); setSelected(""); setConfirmed(false);
    void api(`/api/businesses/${businessId}/growth`, growthResponseSchema, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setPlan(data.plan.filter((item) => item.status !== "dismissed" && item.status !== "completed")); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiFailure && error.status === 401) onSessionExpired(); else setError(errorMessage(error));
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, businessId, reload, onSessionExpired]);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  return <div className="attach-product-improvement">
    <button className="text-button" disabled={disabled || saving} onClick={() => setOpen(!open)}>Attach to an existing growth action</button>
    {notice && <p role="status">{notice}</p>}
    {open && <form onSubmit={(event) => {
      event.preventDefault();
      const item = plan.find((entry) => entry.opportunity.id === selected);
      if (!item || !confirmed || saving) return;
      const controller = new AbortController(); active.current = controller;
      setSaving(true); setError("");
      void api(`/api/businesses/${businessId}/products/${productId}/growth-plan`, growthPlanResponseSchema, {
        method: "POST", signal: controller.signal,
        body: JSON.stringify({ analysisId, index, attachTo: { actionId: selected, revision: item.revision } }),
      }).then(() => {
        if (!controller.signal.aborted) { setNotice("Attached as a draft supporting step. No duplicate growth action was created."); setOpen(false); }
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiFailure && error.status === 401) onSessionExpired(); else setError(errorMessage(error));
      }).finally(() => { if (!controller.signal.aborted) setSaving(false); });
    }}>
      {loading && <p role="status">Loading your saved actions...</p>}
      {error && <p role="alert" className="form-error">{error} <button className="text-button" type="button" onClick={() => setReload((value) => value + 1)}>Reload actions</button></p>}
      {!loading && !error && !plan.length && <p>No open growth actions. Add this improvement as a new action instead.</p>}
      {!!plan.length && <fieldset disabled={disabled || loading || saving}>
        <legend>Keep this independent improvement linked to the right goal</legend>
        <label>Existing action<select value={selected} required onChange={(event) => { setSelected(event.target.value); setConfirmed(false); }}>
          <option value="">Choose an action</option>{plan.map((item) => <option key={item.opportunity.id} value={item.opportunity.id}>{item.opportunity.title}</option>)}
        </select></label>
        {selected && <p>{plan.find((item) => item.opportunity.id === selected)?.opportunity.detail}</p>}
        <label><input type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the goal and confirm this product improvement supports it.</label>
        <button className="secondary-button" type="submit" disabled={!selected || !confirmed}>Save as a supporting step</button>
      </fieldset>}
    </form>}
  </div>;
}
