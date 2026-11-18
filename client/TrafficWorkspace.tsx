import { useEffect, useMemo, useRef, useState } from "react";
import { analyticsResponseSchema, type AnalyticsData } from "../shared/analytics";
import { trafficImportResponseSchema, trafficMetrics, type TrafficImport } from "../shared/traffic";
import { api, ApiFailure, errorMessage } from "./api";
import { TrafficChart } from "./AnalyticsCharts";
import { Icon } from "./Icon";

export function TrafficWorkspace({ businessId, data, start, end, onUpdated, onSessionExpired }: {
  businessId: string; data: AnalyticsData; start: string; end: string;
  onUpdated: (data: AnalyticsData) => void; onSessionExpired: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sourceName, setSourceName] = useState("Google Analytics export");
  const [draft, setDraft] = useState<TrafficImport | null>(null);
  const [reviewVersion, setReviewVersion] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [matchSales, setMatchSales] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const requests = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); requests.current = controller;
    return () => controller.abort();
  }, [businessId]);
  const days = useMemo(() => (data.traffic?.snapshot.days ?? []).filter((day) => !matchSales || day.date >= start && day.date <= end), [data.traffic, matchSales, start, end]);
  const metrics = trafficMetrics(days);
  const overlap = draft?.snapshot.days.filter((day) => data.days.some((sales) => sales.date === day.date)).length ?? 0;
  function report(error: unknown) {
    if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
    else setError(errorMessage(error));
  }
  async function upload(file: File) {
    const signal = requests.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setBusy(true); setError(""); setNotice(""); setDraft(null); setConfirmed(false); setReviewVersion(data.version);
    try {
      if (!/\.csv$/i.test(file.name) || !file.size || file.size > 1024 * 1024) throw new Error("Choose a nonempty traffic CSV up to 1 MiB.");
      const query = new URLSearchParams({ filename: file.name, sourceName });
      const response = await api(`/api/businesses/${businessId}/traffic-imports?${query}`, trafficImportResponseSchema, {
        method: "POST", headers: { "Content-Type": "text/csv" }, body: await file.arrayBuffer(), signal,
      });
      if (!signal.aborted) setDraft(response.draft);
    } catch (error) { if (!signal.aborted) report(error); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  async function commit() {
    if (!draft || !confirmed) return;
    const signal = requests.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setBusy(true); setError("");
    try {
      const { analytics } = await api(`/api/businesses/${businessId}/traffic-imports/${draft.id}/commit`, analyticsResponseSchema, {
        method: "POST", signal, body: JSON.stringify({ expectedVersion: reviewVersion, sameBusiness: true }),
      });
      if (signal.aborted) return;
      onUpdated(analytics); setDraft(null); setOpen(false);
      setNotice("Website visits saved. Sales history is unchanged.");
    } catch (error) { if (!signal.aborted) report(error); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  return <section className="a-card a-traffic" aria-label="Website traffic">
    <div className="a-card-header"><div><h3>Website visits & conversion</h3><p className="a-muted">{data.traffic ? data.traffic.sourceName : "Add a daily traffic CSV to see how visits turn into purchases. Sales and traffic stay separate."}</p></div><button type="button" className="a-button a-outline" disabled={busy} onClick={() => { setOpen(!open); setDraft(null); setError(""); }}>Import website visits <Icon name="plus" /></button></div>
    {error && <p role="alert" className="analytics-alert error">{error}</p>}
    {notice && <p role="status" className="analytics-alert">{notice}</p>}
    {open && <div className="a-traffic-upload">
      <label className="a-field">Website / property source<input value={sourceName} minLength={3} maxLength={120} disabled={busy} onChange={(event) => { setSourceName(event.target.value); setDraft(null); }} placeholder="e.g. Google Merchandise Store sample (GA4)" /></label>
      <p className="a-muted">CSV headers: date, sessions, purchasing_sessions. Optional: event_count, user_count, events_without_session_key. Up to 1 MiB / 3,660 dates. A confirmed upload replaces only the active traffic report, never sales.</p>
      <button type="button" className="a-button a-primary" disabled={busy || sourceName.trim().length < 3} onClick={() => input.current?.click()}>{busy ? "Reading traffic..." : "Choose traffic CSV"}</button>
      <input ref={input} className="sr-only" aria-label="Traffic file" type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ""; }} />
      {draft && <div className="a-review" aria-label="Review traffic import">
        <h3>{draft.filename}</h3>
        <p>{draft.snapshot.days.length} daily rows · {draft.snapshot.days[0].date} to {draft.snapshot.days.at(-1)!.date}</p>
        <p className="a-muted">{data.days.length ? `${overlap} dates overlap your sales history; ${draft.snapshot.days.length - overlap} traffic dates have no sales record. Missing sales stay unknown, not zero.` : "Traffic-only import: no sales, order counts or revenue will be invented."}</p>
        <label className="a-checkbox"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />I confirm this traffic is for the same business and sales channel, not an unrelated dataset.</label>
        <button type="button" className="a-button a-primary" disabled={busy || !confirmed || draft.committed || (data.days.length > 0 && overlap === 0)} onClick={() => void commit()}>{draft.committed ? "Already imported" : "Confirm traffic import"}</button>
        {data.days.length > 0 && overlap === 0 && <p role="alert" className="analytics-alert error">No dates overlap. Use matching exports or a separate business workspace.</p>}
      </div>}
    </div>}
    {data.traffic && <>
      <div className="a-traffic-totals" aria-label="Traffic metrics">
        <div><span>Website sessions</span><strong>{days.length ? metrics.sessions.toLocaleString("en-GB") : "Not available"}</strong></div>
        <div><span>Purchasing sessions</span><strong>{days.length ? metrics.purchasingSessions.toLocaleString("en-GB") : "Not available"}</strong></div>
        <div><span>Purchase conversion</span><strong>{metrics.conversion === null ? "Not available" : `${metrics.conversion.toFixed(2)}%`}</strong></div>
      </div>
      <div className="a-traffic-range"><label className="a-checkbox"><input type="checkbox" checked={matchSales} disabled={!start || !end} onChange={(event) => setMatchSales(event.target.checked)} />Use selected sales date range</label><span className="a-muted">{days.length} of {data.traffic.snapshot.days.length} traffic dates shown{days.length ? ` · ${days[0].date} to ${days.at(-1)!.date}` : ""}</span></div>
      {!days.length && <p role="status" className="analytics-alert">No traffic records in this range. Missing traffic is unknown, not zero visits.</p>}
      {!!days.length && <TrafficChart days={days} />}
      <p className="a-chart-caption">Conversion = purchasing sessions ÷ sessions, not orders ÷ visits. Sessions active on a day can also appear on another day; daily user counts are not added into a unique-user total.</p>
      {metrics.missingSessionEvents === null ? <p className="a-muted">Missing-session-event counts were not provided. Tracking completeness is unknown.</p> : metrics.missingSessionEvents > 0 ? <p className="analytics-alert">{metrics.missingSessionEvents.toLocaleString("en-GB")} events lack a usable session key. This rate covers identified sessions only.</p> : <p className="a-muted">The selected report records zero events without a session key. This is a quality check, not proof of complete or unobfuscated tracking.</p>}
      <p className="a-chart-caption">Source: {data.traffic.filename} · {data.traffic.sourceName}. No Google account is connected; this is a file import.</p>
    </>}
  </section>;
}
