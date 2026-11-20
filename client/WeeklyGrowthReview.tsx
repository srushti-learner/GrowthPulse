import { useEffect, useRef, useState, type FormEvent } from "react";
import { moneyScale } from "../shared/analytics";
import type { GrowthPlanItem } from "../shared/growth";
import {
  reviewMetricLabels, reviewMetrics, weeklyReviewResponseSchema,
  type ActionMeasurement, type WeeklyReviewState,
} from "../shared/weekly-review";
import { api, ApiFailure, errorMessage } from "./api";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import "./weekly-review.css";

const dateLabel = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const changeLabel = (value: number | null) => value === null ? "No positive baseline for a percentage" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;

export function WeeklyGrowthReview({ businessId, plan, onSessionExpired, expanded = false }: {
  businessId: string; plan: GrowthPlanItem[]; onSessionExpired: () => void; expanded?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{ businessId: string; value: WeeklyReviewState } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const requests = useRef<AbortController | null>(null);
  const activeBusiness = useRef(businessId);
  activeBusiness.current = businessId;
  const data = snapshot?.businessId === businessId ? snapshot.value : null;
  function report(error: unknown) {
    if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
    else setError(errorMessage(error));
  }
  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    setSnapshot(null); setLoading(true); setBusy(false); setError(""); setNotice("");
    void api(`/api/businesses/${businessId}/weekly-review`, weeklyReviewResponseSchema, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) setSnapshot({ businessId, value });
    }).catch((error: unknown) => { if (!controller.signal.aborted) report(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [businessId, reload, onSessionExpired]);

  async function save(path: string, input: unknown, message: string) {
    const signal = requests.current?.signal;
    if (!data || !signal || signal.aborted || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await api(`/api/businesses/${businessId}/${path}`, weeklyReviewResponseSchema, {
        method: "POST", signal, body: JSON.stringify(input),
      });
      if (!signal.aborted && activeBusiness.current === businessId) {
        setSnapshot({ businessId, value }); setNotice(message);
      }
    } catch (error) { if (!signal.aborted) report(error); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void save("action-measurements", {
      expectedVersion: data!.version, opportunityId: form.get("opportunityId"),
      metric: form.get("metric"), startDate: form.get("startDate"),
    }, "Baseline saved. Return with seven outcome dates on or after the review date.");
  }
  function decide(event: FormEvent<HTMLFormElement>, measurement: ActionMeasurement) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void save(`action-measurements/${measurement.id}/decision`, {
      expectedVersion: data!.version, decision: form.get("decision"), note: form.get("note"),
    }, form.get("decision") === "stop" && !measurement.outcome
      && data!.measurements.find((entry) => entry.measurement.id === measurement.id)?.status !== "ready"
      ? "Action stopped without claiming a measured outcome. The original baseline is retained."
      : "Outcome and your decision saved. The original baseline is unchanged.");
  }
  const format = (metric: ActionMeasurement["metric"], value: number | null, currency = data?.current.currency) =>
    value === null ? "Not measurable" : metric === "orders" ? new Intl.NumberFormat().format(value)
      : currency ? new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value / moneyScale) : "Currency needed";
  const available = plan.filter((item) => item.status !== "dismissed"
    && !data?.measurements.some((entry) => entry.measurement.opportunityId === item.opportunity.id && !entry.measurement.decision));
  const complete = !!data?.current.current.values && !!data.current.previous.values;
  const savedCurrent = data?.reviews.some((review) => review.version === data.version && review.report.current.end === data.current.current.end);

  return <section className="weekly-growth-review" aria-label="Weekly Growth Review">
    <Card>
      <CardHeader><CardDescription>WEEKLY GROWTH REVIEW / CSV &amp; OWNER RECORDS</CardDescription>
        <CardTitle><h2>Your business this week.</h2></CardTitle>
        <p>Update your numbers, review what changed, and follow through on one action. No automatic sales connection or background research.</p>
      </CardHeader>
      <CardContent>
        {loading && <p role="status">Loading your saved sales review...</p>}
        {error && <p role="alert" className="form-error">Weekly review: {error} <button type="button" className="text-button" disabled={busy} onClick={() => setReload((value) => value + 1)}>Reload weekly review</button></p>}
        {notice && <p role="status">{notice}</p>}
        {data && <>
          <div className="weekly-review-freshness">
            <p><strong>{data.stale || !complete ? "Sales update needed" : "Reporting weeks covered"}</strong><br />
              {data.coveredThrough ? <>Data covers through {dateLabel(data.coveredThrough)}.</> : "No dated sales records supplied yet."}
              {data.observedAt && <> Last recorded update: {dateLabel(data.observedAt)}.</>}</p>
            <Button asChild variant={data.stale || !complete ? "default" : "outline"}><a href={`#simulator?business=${encodeURIComponent(businessId)}&view=sales`}>Update sales</a></Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReload((value) => value + 1)}>Refresh review</Button>
          </div>
          <p>Latest complete week: <strong>{dateLabel(data.current.current.start)} - {dateLabel(data.current.current.end)}</strong> ({data.current.current.observedDates}/7 dates supplied).
            Compared with {dateLabel(data.current.previous.start)} - {dateLabel(data.current.previous.end)} ({data.current.previous.observedDates}/7).</p>
          {data.current.hasEstimates && <p className="weekly-review-gap">This history includes owner estimates. Do not treat it as exclusively verified actuals.</p>}
          {!!data.current.warnings.length && <p className="weekly-review-gap">Source caveat: {data.current.warnings[0]} {data.current.warnings.length > 1 && "More source caveats are listed below."}</p>}
          {!complete ? <p className="weekly-review-gap">Supply all 14 dates in these two weeks for a comparison. Missing dates are unknown, not zero. Record a genuine zero-sales day using Owner entry.</p>
            : <>
              <div className="weekly-review-metrics">{reviewMetrics.map((metric) => {
                const change = data.current.changes.find((item) => item.metric === metric);
                return <div key={metric}><h3>{reviewMetricLabels[metric]}</h3><strong>{format(metric, data.current.current.values![metric])}</strong>
                  <p>Previous: {format(metric, data.current.previous.values![metric])}</p>
                  <p>{change ? changeLabel(change.percent) : "Not measurable without orders"}{change?.attention && <span className="weekly-review-attention">Change to review</span>}</p>
                </div>;
              })}</div>
              <p>{data.current.changes.some((change) => change.attention)
                ? "Review the flagged changes alongside your records and current action. A change does not establish its cause."
                : "No supplied metric triggers the attention rule. Keep reviewing your chosen action rather than inventing another task."}</p>
              {(data.current.current.values!.orders < 20 || data.current.previous.values!.orders < 20) && <p>Small sample: at least one week has fewer than 20 recorded orders. Treat percentage changes as directional observations, not reliable evidence of a trend.</p>}
              <Button disabled={busy || savedCurrent} onClick={() => void save("weekly-review", {
                expectedVersion: data.version, periodEnd: data.current.current.end,
              }, "Weekly review saved. Later uploads will not rewrite this report.")}>{savedCurrent ? "Weekly review saved" : "Save weekly review"}</Button>
            </>}
          <details className="weekly-review-details"><summary>Coverage and measurement limits</summary>
            <p>Monday-Sunday reporting weeks use a UTC calendar; source dates are kept as supplied. Coverage counts supplied dates, not proof of a complete export. Attention flags mean a change of at least 10%, or a changed value without a positive baseline; they are not statistical significance.</p>
            <p>A confirmed CSV replaces the active imported baseline, not an append. Include both reporting weeks in replacement exports for weekly comparisons. Earlier snapshots, saved reports and action baselines are retained separately; their rows are not silently combined or double-counted.</p>
            <p>Net sales subtract discounts and recorded reversals. Average order value uses booked sales less discounts before reversals. This review does not infer profit, product-level ROI or campaign attribution.</p>
            {!!data.current.sourceNames.length && <p>Source records (up to 12): {data.current.sourceNames.join("; ")}.</p>}
            {data.current.warnings.map((warning, index) => <p key={`${index}:${warning}`}>{warning}</p>)}
            <p>{data.observationCount} dated sales snapshot(s) retained. Opening this page does not save a report, contact providers or start paid AI.</p>
          </details>
          <section className="weekly-review-actions" aria-label="Action outcome reviews">
            <h3>Your current experiments</h3>
            <p>Business-level, seven-day observations against the seven days before your action. Baselines stay fixed; observed changes do not prove causation.</p>
            {!data.measurements.length && <p>No results measured yet. A planned action is not a launched experiment. Choose one saved action, record when it actually starts, and supply seven baseline dates before collecting seven follow-up dates.</p>}
            {data.measurements.map((entry) => {
              const measurement = entry.measurement;
              return <details key={measurement.id} className="weekly-review-experiment" open={expanded && !measurement.decision && entry.status !== "waiting"}>
                <summary>{measurement.title} - {({ waiting: "In progress", needs_data: "Update sales to review", ready: "Ready to review", reviewed: "Decision recorded", stopped: "Stopped without outcome" })[entry.status]}</summary>
                <p><a href={`#actions?business=${encodeURIComponent(businessId)}&action=${measurement.opportunityId}`}>Open saved action</a></p>
                <p>{reviewMetricLabels[measurement.metric]} baseline ({dateLabel(measurement.baseline.period.start)} - {dateLabel(measurement.baseline.period.end)}): <strong>{format(measurement.metric, measurement.baseline.period.values![measurement.metric], measurement.currency)}</strong></p>
                <p>Action starts {dateLabel(measurement.startDate)}. Review from {dateLabel(measurement.reviewDate)}{entry.status !== "stopped" && <>; {entry.observedDates}/7 outcome dates supplied</>}.</p>
                {entry.status === "waiting" && <p>Return on the review date and update your sales records. This is an in-app reminder, not an email or scheduled data fetch.</p>}
                {entry.status === "needs_data" && <p>The review is due, but seven comparable outcome dates and a measurable value in the baseline currency are needed.</p>}
                {(entry.status === "waiting" || entry.status === "needs_data") && <details><summary>Stop this experiment without a result</summary>
                  <p>If you cannot continue, record why. This closes the review without claiming a measured outcome and lets you start a follow-up.</p>
                  <form onSubmit={(event) => decide(event, measurement)}><fieldset disabled={busy}>
                    <legend>Stop without a measured outcome</legend><input type="hidden" name="decision" value="stop" />
                    <label>Why are you stopping?<textarea name="note" required minLength={3} maxLength={500} /></label>
                    <Button type="submit" variant="outline">Stop without outcome</Button>
                  </fieldset></form>
                </details>}
                {(entry.status === "ready" || entry.status === "reviewed") && <p>Observed outcome: <strong>{format(measurement.metric, entry.value, measurement.currency)}</strong> · {changeLabel(entry.percent)}</p>}
                {(measurement.baseline.hasEstimates || entry.hasEstimates) && <p>Baseline or outcome history includes owner estimates.</p>}
                {entry.status === "ready" && <form onSubmit={(event) => decide(event, measurement)}>
                  <fieldset disabled={busy}><legend>Record your decision</legend>
                    <label>Next decision<select name="decision" required defaultValue=""><option value="" disabled>Choose a decision</option><option value="continue">Continue</option><option value="revise">Revise</option><option value="stop">Stop</option></select></label>
                    <label>What did you learn?<textarea name="note" required minLength={3} maxLength={500} /></label>
                    <Button type="submit">Save outcome and decision</Button>
                  </fieldset>
                </form>}
                {measurement.decision && <p><strong>{({ continue: "Continue", revise: "Revise", stop: "Stop" })[measurement.decision]}</strong>: {measurement.note}. Recorded {dateLabel(measurement.decidedAt!)}. {measurement.outcome ? "Outcome snapshot retained." : "No measured outcome was recorded."}</p>}
                <details><summary>Outcome evidence and caveats</summary>
                  <p>Baseline version: {measurement.baseline.version}. {measurement.outcome ? `Saved outcome version: ${measurement.outcome.version}.` : measurement.decision ? "No outcome snapshot." : `Current sales version: ${data.version}.`}</p>
                  {!!measurement.baseline.sourceNames?.length && <p>Baseline source records (up to 12): {measurement.baseline.sourceNames.join("; ")}.</p>}
                  {!!measurement.outcome?.sourceNames?.length && <p>Saved outcome source records (up to 12): {measurement.outcome.sourceNames.join("; ")}.</p>}
                  {[...new Set([...measurement.baseline.warnings, ...(entry.status === "stopped" ? [] : entry.warnings)])].map((warning) => <p key={warning}>{warning}</p>)}
                  <p>Other campaigns, seasonality, revised source records and changes in customer mix may explain differences. A controlled experiment is needed for causal attribution.</p>
                </details>
              </details>;
            })}
            <details className="weekly-review-details" open={expanded}><summary>Measure a saved action</summary>
              {!available.length ? <p>Choose an action in <a href={`#growth?business=${encodeURIComponent(businessId)}`}>My growth plan</a>, or finish its open review before starting a follow-up.</p>
                : <form key={businessId} onSubmit={start}><fieldset disabled={busy || !data.coveredThrough}>
                  <legend>Save a baseline before reviewing results</legend>
                  <label>Saved action<select name="opportunityId" required defaultValue=""><option value="" disabled>Choose your action</option>{available.map((item) => <option key={item.opportunity.id} value={item.opportunity.id}>{item.opportunity.title}</option>)}</select></label>
                  <label>Metric<select name="metric" defaultValue="net">{reviewMetrics.map((metric) => <option key={metric} value={metric}>{reviewMetricLabels[metric]}</option>)}</select></label>
                  <label>Action start date<input name="startDate" type="date" required max={new Date().toISOString().slice(0, 10)} defaultValue={new Date().toISOString().slice(0, 10)} /></label>
                  <p>Supply seven recorded dates immediately before the start. Choose today or a date within the past year when the action really started. Saving does not execute the action or change its task status.</p>
                  <Button type="submit">Start outcome review</Button>
                </fieldset></form>}
            </details>
          </section>
          {!!data.reviews.length && <details className="weekly-review-details"><summary>Saved weekly reviews</summary>
            {data.reviews.map((review) => <article key={review.id}><h3>Week ending {dateLabel(review.report.current.end)}</h3>
              <p>Saved {dateLabel(review.createdAt)}{review.version !== data.version ? " from an earlier sales baseline" : ""}.</p>
              {!!review.report.sourceNames.length && <p>Source records (up to 12): {review.report.sourceNames.join("; ")}.</p>}
              {reviewMetrics.map((metric) => <p key={metric}>{reviewMetricLabels[metric]}: {format(metric, review.report.current.values?.[metric] ?? null, review.report.currency)} (previous {format(metric, review.report.previous.values?.[metric] ?? null, review.report.currency)})</p>)}
              {review.report.hasEstimates && <p>Includes owner estimates.</p>}
              {!!review.report.warnings.length && <details><summary>Saved source caveats</summary>{review.report.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
            </article>)}
          </details>}
        </>}
      </CardContent>
    </Card>
  </section>;
}
