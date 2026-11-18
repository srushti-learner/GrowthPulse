import { useEffect, useRef, useState, type FormEvent } from "react";
import { businessesSchema, type Business } from "../shared/contracts";
import { savedScanResponseSchema, scanResponseSchema, scansResponseSchema, scanLimits, type SavedScan, type ScanResult, type ScanSummary } from "../shared/website";
import { api, ApiFailure, errorMessage } from "./api";
import { Icon } from "./Icon";

const statusLabels = { complete: "Scan complete", partial: "Partial scan", failed: "Scan failed" } as const;
export function WebsiteWorkspace({ authenticated, onSessionExpired, selectedBusinessId, onBusinessSelected, businessManaged = false }: {
  authenticated: boolean; onSessionExpired: () => void; selectedBusinessId?: string;
  onBusinessSelected?: (id: string) => void; businessManaged?: boolean;
}) {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [url, setUrl] = useState("");
  const [permission, setPermission] = useState(false);
  const [loading, setLoading] = useState(authenticated);
  const [loadError, setLoadError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | SavedScan | null>(null);
  const [scans, setScans] = useState<ScanSummary[]>([]);
  const [scanId, setScanId] = useState("");
  const [reload, setReload] = useState(0);
  const [historyReload, setHistoryReload] = useState(0);
  const [detailReload, setDetailReload] = useState(0);
  const running = useRef<AbortController | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  function report(error: unknown, update: (message: string) => void) {
    if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
    else update(errorMessage(error));
  }
  useEffect(() => () => running.current?.abort(), []);
  useEffect(() => { if (result) resultHeading.current?.focus(); }, [result]);
  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void api("/api/businesses", businessesSchema, { signal: controller.signal }).then(({ businesses }) => {
      if (controller.signal.aborted) return;
      setBusinesses(businesses);
      const selected = selectedBusinessId !== undefined ? businesses.find((item) => item.id === selectedBusinessId) : businesses[0];
      setBusinessId(selected?.id ?? "");
      setUrl(selected?.website ?? "");
    }).catch((error: unknown) => { if (!controller.signal.aborted) report(error, setLoadError); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [authenticated, reload, onSessionExpired]);

  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setScans([]);
    setScanId("");
    setHistoryError("");
    setError("");
    if (!businessId) { setHistoryLoading(false); return; }
    setHistoryLoading(true);
    void api(`/api/businesses/${businessId}/scans`, scansResponseSchema, { signal: controller.signal }).then(({ scans }) => {
      if (controller.signal.aborted) return;
      setScans(scans);
      setScanId(scans[0]?.id ?? "");
    }).catch((error: unknown) => { if (!controller.signal.aborted) report(error, setHistoryError); })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [businessId, historyReload, onSessionExpired]);

  useEffect(() => {
    if (!scanId || !businessId) { setReading(false); return; }
    const controller = new AbortController();
    setReading(true);
    setResult(null);
    setError("");
    void api(`/api/businesses/${businessId}/scans/${scanId}`, savedScanResponseSchema, { signal: controller.signal }).then(({ scan }) => {
      if (!controller.signal.aborted) setResult(scan);
    }).catch((error: unknown) => { if (!controller.signal.aborted) report(error, setError); })
      .finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [businessId, scanId, detailReload, onSessionExpired]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!permission) { setError("Confirm that you have permission to scan these public pages."); return; }
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    setResult(null);
    setScanId("");
    setError("");
    try {
      const options = { method: "POST", body: JSON.stringify({ url, permission }), signal: controller.signal };
      if (businessId) {
        const { scan } = await api(`/api/businesses/${businessId}/scans`, savedScanResponseSchema, options, scanLimits.milliseconds + 10_000);
        if (controller.signal.aborted) return;
        setResult(scan);
        setScans((current) => [{
          id: scan.id, businessId: scan.businessId, requestedUrl: scan.requestedUrl, status: scan.status,
          startedAt: scan.startedAt, completedAt: scan.completedAt, pageCount: scan.pages.length,
        }, ...current].slice(0, 20));
      } else {
        const { scan } = await api("/api/website/scan", scanResponseSchema, options, scanLimits.milliseconds + 10_000);
        if (!controller.signal.aborted) setResult(scan);
      }
    } catch (error) { if (!controller.signal.aborted) report(error, setError); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  if (loading) return <p className="loading-message">Loading your businesses...</p>;
  if (loadError) return <p role="alert" className="form-error">{loadError} <button className="text-button" onClick={() => setReload((value) => value + 1)}>Reload businesses</button></p>;
  const disabled = busy || reading || historyLoading;
  return <section className="website-workspace">
    <div className="business-columns">
      <form className="workspace-form profile-card scan-form" onSubmit={(event) => void submit(event)}>
        <div className="card-heading"><p className="section-eyebrow">WEBSITE SCAN</p><h2>Start with a public page.</h2><p>Read up to {scanLimits.pages} public business and product pages without changing your website.</p></div>
        <fieldset disabled={disabled}>
          <legend className="sr-only">Website scan</legend>
          {authenticated && !businessManaged && <label>Save results to<select name="scanBusiness" value={businessId} onChange={(event) => {
            setBusinessId(event.target.value);
            onBusinessSelected?.(event.target.value);
            setScanId("");
            setResult(null);
            setUrl(businesses.find((business) => business.id === event.target.value)?.website ?? "");
            setPermission(false);
          }}><option value="">Preview only (not saved)</option>{businesses.map((business) => <option key={business.id} value={business.id}>{business.name}</option>)}</select></label>}
          {authenticated && businessManaged && <p className="field-note">{businessId ? `Saving evidence to ${businesses.find((item) => item.id === businessId)?.name}. Change the active business above to switch.` : "Preview only: choose an active business above to save evidence."}</p>}
          {authenticated && businessManaged && <label className="permission-check"><input type="checkbox" checked={!businessId} onChange={(event) => {
            setBusinessId(event.target.checked ? "" : businesses.find((item) => item.id === selectedBusinessId)?.id ?? "");
            setScanId(""); setResult(null); setPermission(false);
          }} />Preview without saving to this business</label>}
          <label>Public website URL<input type="url" name="scanUrl" required maxLength={2048} value={url} placeholder="https://your-public-website.com" onChange={(event) => { setUrl(event.target.value); setPermission(false); }} /><span className="field-note">HTTP(S) only. No login, custom ports, signed links, or query parameters.</span></label>
          <label className="permission-check"><input type="checkbox" name="scanPermission" required checked={permission} onChange={(event) => setPermission(event.target.checked)} /><span>I own this website or have permission to scan its public pages.</span></label>
          <p className="field-note">{businessId ? "This run and its evidence will be saved to the selected business. Valid, unambiguous website products are added to your catalogue automatically. Your profile and manual product edits will not be overwritten." : "Preview only: this result will not be saved to a business."}</p>
          <button type="submit" className="primary-link">{busy ? "Scanning public pages..." : result ? "Rescan website" : "Scan website"}<Icon name="arrow" /></button>
        </fieldset>
        {busy && <p role="status" className="loading-message">Reading allowed pages and checking robots rules. This may take up to {scanLimits.milliseconds / 1000} seconds.</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
      </form>
      <aside className="ownership-card"><Icon name="shield" /><h2>Your agent's evidence tool.</h2><p>Review saved website findings without AI interpretation. Prefer a guided review? Your business agent can use this same safe scanner for you.</p><hr /><p>Robots restrictions, private networks, and unsafe redirects are blocked. No login, JavaScript execution, website changes, or background monitoring. A blocked page stays unknown, not invented.</p><p><a href="#overview?view=business" className="text-button">{authenticated ? "Open your business agent" : "Create a profile to meet your business agent"} <Icon name="arrow" /></a></p></aside>
    </div>
    {businessId && <section className="profile-card scan-history" aria-labelledby="scan-history-heading">
      <div className="card-heading"><h2 id="scan-history-heading">Saved scans</h2><p>Latest 20 runs for this business. Previous evidence is preserved; rescans do not rewrite it.</p></div>
      {historyLoading ? <p className="loading-message">Loading scan history...</p> : historyError ? <p className="form-error" role="alert">{historyError} <button className="text-button" onClick={() => setHistoryReload((value) => value + 1)}>Retry history</button></p>
        : scans.length ? <label className="scan-picker">View a run<select value={result && "id" in result ? result.id : scanId} disabled={disabled} onChange={(event) => setScanId(event.target.value)}>
          <option value="" disabled>Choose a saved scan</option>{scans.map((scan) => <option value={scan.id} key={scan.id}>{new Date(scan.completedAt).toLocaleString()} · {statusLabels[scan.status]} · {scan.pageCount} pages</option>)}
        </select></label> : <p className="field-note">No scans have been saved for this business yet.</p>}
      {reading && <p className="loading-message">Loading saved result...</p>}
      {scanId && error && <button className="text-button" onClick={() => setDetailReload((value) => value + 1)}>Retry saved scan</button>}
    </section>}
    {result && <section className={`profile-card scan-result ${result.status}`} aria-labelledby="scan-result-heading">
      <p className="section-eyebrow">WEBSITE FINDINGS</p>
      <h2 ref={resultHeading} tabIndex={-1} id="scan-result-heading">{statusLabels[result.status]}</h2>
      <p className="scan-meta" role={result.status === "failed" ? "alert" : "status"}>{result.pages.length} HTML pages captured. {"id" in result ? "Saved locally to this business." : "Preview only, not saved."}</p>
      <p className="scan-meta">{result.requestedUrl}<br /><time dateTime={result.completedAt}>{new Date(result.completedAt).toLocaleString()}</time></p>
      {result.catalogue && <div className="scan-catalogue">
        <p role="status">{result.catalogue.created} products added, {result.catalogue.updated} listings refreshed, {result.catalogue.unchanged} unchanged, {result.catalogue.skipped} source records needing attention. No import confirmation needed.</p>
        {"businessId" in result && <a className="primary-link" href={`#products?business=${result.businessId}`}>Open your products<Icon name="arrow" /></a>}
        {!!result.catalogue.issues.length && <details className="agent-sources"><summary>Product records needing attention ({result.catalogue.skipped})</summary>
          <ul>{result.catalogue.issues.map((issue, index) => <li key={index}><strong>{issue.name}</strong> · {issue.reference}<br />{issue.message}</li>)}</ul>
          <p className="field-note">Usable products are already available. Resolve uncertain records with the optional saved-scan tools in Products, or add a missed product manually.</p>
        </details>}
      </div>}
      {"businessId" in result && !result.catalogue && <p className="field-note">No products were added automatically by this run. If no supported product data was captured, add missing products manually in <a href={`#products?business=${result.businessId}`}>Products</a>.</p>}
      {result.failures.length > 0 && <div className="form-error"><h3>Pages we could not read</h3><ul>{result.failures.map((failure) => <li key={failure.url}><strong>{failure.url}</strong><br />{failure.message}</li>)}</ul></div>}
      {!!result.notes.length && <details className="agent-sources scan-details"><summary>Scan details</summary><ul className="scan-notes">{result.notes.map((note) => <li key={note}>{note}</li>)}</ul></details>}
      <div className="scan-pages">{result.pages.map((page) => <article key={page.url} className="scan-page">
        <div className="card-heading"><h3>{page.title || "No HTML title provided"}</h3><a href={page.url} target="_blank" rel="noopener noreferrer">{page.url}</a><p>Captured <time dateTime={page.capturedAt}>{new Date(page.capturedAt).toLocaleString()}</time></p></div>
        <details className="agent-sources page-details"><summary>Page details</summary><dl className="saved-profile-details">
          <div><dt>Meta description</dt><dd>{page.description || "Not provided"}</dd></div>
          <div><dt>Headings</dt><dd>{page.headings.length ? <ul>{page.headings.map((heading, index) => <li key={index}>H{heading.level}: {heading.text || "(empty heading)"}</li>)}</ul> : "None found"}</dd></div>
          <div><dt>Published contact links</dt><dd>{page.contacts.join(" · ") || "None found"}</dd></div>
          <div><dt>Call-to-action labels</dt><dd>{page.callsToAction.join(" · ") || "None found"}</dd></div>
        </dl>
        {page.warnings.length > 0 && <ul className="scan-notes">{page.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}</details>
      </article>)}</div>
    </section>}
  </section>;
}
