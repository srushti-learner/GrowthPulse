import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { businessesSchema, type Business } from "../shared/contracts";
import { analyticsResponseSchema, moneyScale, salesImportResponseSchema, scenarioInputSchema, type AnalyticsData, type SalesImport, type ScenarioInput } from "../shared/analytics";
import { forecastSales, netSales, nextDate, percentageChange, salesMetrics, scenarioDays } from "../shared/analytics-math";
import { api, ApiFailure, errorMessage } from "./api";
import { Icon } from "./Icon";
import { ForecastComparison, OrdersChart, SalesChart } from "./AnalyticsCharts";
import { TrafficWorkspace } from "./TrafficWorkspace";
import { trafficMetrics } from "../shared/traffic";
import { growthResponseSchema, type GrowthOpportunity } from "../shared/growth";
import { requiredSalesFields, salesFieldLabels, salesFields, salesHeadersResponseSchema, type SalesHeaderInspection, type SalesMapping } from "../shared/sales-mapping";
import "./analytics.css";

const emptyAnalytics: AnalyticsData = { currency: null, version: "", days: [], products: [], sources: [], imports: [], scenarios: [], warnings: [], traffic: null };
const fmt = new Intl.NumberFormat("en-GB");
const dateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const scenarioSummary = (input: ScenarioInput) => ([
  ["Orders", input.ordersPct], ["Spend/order", input.aovPct], ["Costs", input.costPct],
] as const).filter(([, value]) => value !== 0).map(([label, value]) => `${label} ${value > 0 ? "+" : ""}${value}%`).join(", ") || "No percentage changes";
const sameScenario = (left: ScenarioInput, right: ScenarioInput) => left.name === right.name
  && left.start === right.start && left.end === right.end && left.ordersPct === right.ordersPct
  && left.aovPct === right.aovPct && left.costPct === right.costPct && left.opportunityId === right.opportunityId;
type Tab = "overview" | "forecast" | "scenario";
type ScenarioControl = "ordersPct" | "aovPct" | "costPct";
const mappingIssueLabels = {
  duplicate: "More than one column could match this field. Choose one and skip the others.",
  unit_price: "Is this the price of one unit? Do not use an order or line total.",
  discount_amount: "Only map this as a discount if it is an amount per line, not a percentage.",
};

export function AnalyticsWorkspace({ onSessionExpired, studio = false, selectedBusinessId, onBusinessSelected, businessManaged = false }: {
  onSessionExpired: () => void; studio?: boolean; selectedBusinessId?: string; onBusinessSelected?: (id: string) => void;
  businessManaged?: boolean;
}) {
  const [context, setContext] = useState(() => new URLSearchParams(window.location.hash.split("?")[1] ?? ""));
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [data, setData] = useState<AnalyticsData>(emptyAnalytics);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savingImport, setSavingImport] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState<Tab>(studio ? "scenario" : "overview");
  const [panel, setPanel] = useState<"import" | "manual" | null>(null);
  const [currency, setCurrency] = useState("");
  const [draft, setDraft] = useState<SalesImport | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [salesFile, setSalesFile] = useState<File | null>(null);
  const [salesHeaders, setSalesHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<SalesMapping>([]);
  const [mappingIssues, setMappingIssues] = useState<SalesHeaderInspection["issues"]>([]);
  const [reviewColumns, setReviewColumns] = useState<number[]>([]);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [salesStage, setSalesStage] = useState<"reading" | "checking" | null>(null);
  const [range, setRange] = useState({ start: "", end: "" });
  const [scenario, setScenario] = useState<ScenarioInput>({ name: "My growth scenario", start: "", end: "", ordersPct: 0, aovPct: 0, costPct: 0 });
  const [savedId, setSavedId] = useState("");
  const [growthAction, setGrowthAction] = useState<(Pick<GrowthOpportunity, "id" | "title"> & { planned: boolean }) | null>(null);
  const [growthError, setGrowthError] = useState("");
  const [scenarioGoal, setScenarioGoal] = useState<ScenarioControl | null>(null);
  const [costOpen, setCostOpen] = useState(false);
  const scenarioInputs = useRef<Partial<Record<ScenarioControl, HTMLInputElement | null>>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const errorHeading = useRef<HTMLDivElement>(null);
  const savedNotice = useRef<HTMLParagraphElement>(null);
  const requests = useRef<AbortController | null>(null);
  const salesRequest = useRef<AbortController | null>(null);
  const requestedSelection = useRef({ id: selectedBusinessId, onSelected: onBusinessSelected });
  requestedSelection.current = { id: selectedBusinessId, onSelected: onBusinessSelected };
  const requestedView = context.get("view");
  useEffect(() => { setTab(requestedView === "sales" ? "overview" : studio ? "scenario" : "overview"); }, [studio, requestedView]);
  function report(error: unknown) {
    if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
    else setError(errorMessage(error));
  }
  useEffect(() => {
    if (busy) return;
    if (error) errorHeading.current?.focus();
    else if (notice) savedNotice.current?.focus();
  }, [error, notice, busy]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void api("/api/businesses", businessesSchema, { signal: controller.signal }).then(({ businesses }) => {
      if (controller.signal.aborted) return;
      setBusinesses(businesses);
      const selected = businessManaged && requestedSelection.current.id !== undefined
        ? businesses.find((item) => item.id === requestedSelection.current.id)
        : businesses.find((item) => item.id === context.get("business"))
          ?? businesses.find((item) => item.id === requestedSelection.current.id) ?? businesses[0];
      setBusinessId(selected?.id ?? "");
      if (selected) requestedSelection.current.onSelected?.(selected.id);
      if (!selected) setLoading(false);
    }).catch((error: unknown) => { if (!controller.signal.aborted) { report(error); setLoading(false); } });
    return () => controller.abort();
  }, [reload, onSessionExpired]);
  useEffect(() => {
    if (selectedBusinessId !== undefined) setBusinessId(businesses.find((item) => item.id === selectedBusinessId)?.id ?? "");
  }, [selectedBusinessId]);
  useEffect(() => {
    function followLink() {
      if (window.location.hash.split("?")[0] !== "#simulator") return;
      const next = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
      const requested = next.get("business");
      if (requested && !businesses.some((item) => item.id === requested)) return;
      setContext(next);
      if (requested) { setBusinessId(requested); requestedSelection.current.onSelected?.(requested); }
    }
    window.addEventListener("hashchange", followLink);
    return () => window.removeEventListener("hashchange", followLink);
  }, [businesses]);
  useEffect(() => {
    clearSalesImport();
    if (!businessId) return;
    const controller = new AbortController();
    requests.current = controller;
    setLoading(true); setBusy(false); setError(""); setDraft(null); setNotice(""); setSavedId(""); setPanel(null); setData(emptyAnalytics);
    void api(`/api/businesses/${businessId}/analytics`, analyticsResponseSchema, { signal: controller.signal }).then(({ analytics }) => {
      if (!controller.signal.aborted) setData(analytics);
    }).catch((error: unknown) => { if (!controller.signal.aborted) report(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); salesRequest.current?.abort(); };
  }, [businessId, reload, onSessionExpired]);
  useEffect(() => {
    setGrowthAction(null); setGrowthError("");
    const actionId = context.get("business") === businessId ? context.get("action") : null;
    if (!businessId || !actionId) return;
    const controller = new AbortController();
    void api(`/api/businesses/${businessId}/growth`, growthResponseSchema, { signal: controller.signal }).then((growth) => {
      if (controller.signal.aborted) return;
      const selectedPlan = growth.plan.find((item) => item.opportunity.id === actionId);
      const action = selectedPlan?.opportunity
        ?? growth.opportunities.find((item) => item.id === actionId);
      if (action) setGrowthAction({ ...action, planned: !!selectedPlan });
      else setGrowthError("This recommendation is no longer available. You can still explore your saved sales with your own assumptions.");
    }).catch((error: unknown) => { if (!controller.signal.aborted) {
      if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
      else setGrowthError(`The recommendation could not be loaded: ${errorMessage(error)}`);
    } });
    return () => controller.abort();
  }, [businessId, context, reload, onSessionExpired]);
  useEffect(() => {
    if (!growthAction) return;
    setTab("scenario"); setSavedId("");
    setScenarioGoal(null); setCostOpen(false);
    setScenario((current) => ({ ...current, name: growthAction.title.slice(0, 80), opportunityId: growthAction.planned ? growthAction.id : undefined, ordersPct: 0, aovPct: 0, costPct: 0 }));
  }, [growthAction]);
  useEffect(() => {
    setRange({ start: data.days[0]?.date ?? "", end: data.days.at(-1)?.date ?? "" });
    const action = context.get("business") === businessId ? growthAction : null;
    setScenario({ name: action?.title.slice(0, 80) ?? "My growth scenario", opportunityId: action?.planned ? action.id : undefined, start: data.days[0]?.date ?? "", end: data.days.at(-1)?.date ?? "", ordersPct: 0, aovPct: 0, costPct: 0 });
    setScenarioGoal(null); setCostOpen(false);
    setCurrency(data.currency ?? "");
  }, [data.version, businessId]);
  useEffect(() => { clearSalesImport(); }, [currency]);
  useEffect(() => { if (scenarioGoal) scenarioInputs.current[scenarioGoal]?.focus(); }, [scenarioGoal, costOpen]);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const signal = requests.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(signal); }
    catch (error) { if (!signal.aborted) report(error); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  const days = useMemo(() => data.days.filter((day) => day.date >= range.start && day.date <= range.end), [data.days, range.start, range.end]);
  const salesSummary = useMemo(() => salesMetrics(days), [days]);
  const metrics = { ...salesSummary, conversion: data.traffic ? trafficMetrics(data.traffic.snapshot.days.filter((day) => day.date >= range.start && day.date <= range.end)).conversion : salesSummary.conversion };
  const forecast = useMemo(() => forecastSales(days), [days]);
  const validScenario = scenarioInputSchema.safeParse(scenario);
  const saved = data.scenarios.find((item) => item.id === savedId);
  const alreadySaved = validScenario.success ? data.scenarios.find((item) => item.baselineVersion === data.version && sameScenario(item.input, validScenario.data)) : undefined;
  const staleScenario = !!saved && saved.baselineVersion !== data.version;
  const alternative = useMemo(() => saved && !staleScenario ? saved.days : scenarioInputSchema.safeParse(scenario).success ? scenarioDays(data.days, scenario) : [], [saved, staleScenario, data.days, scenario]);
  const scenarioBaseline = data.days.filter((day) => day.date >= scenario.start && day.date <= scenario.end);
  const scenarioComparison = alternative.filter((day) => day.date >= scenario.start && day.date <= scenario.end);
  const scenarioMetrics = salesMetrics(scenarioComparison);
  const originalMetrics = salesMetrics(scenarioBaseline);
  const scenarioNetChange = percentageChange(scenarioMetrics.net, originalMetrics.net);
  const baselineForecast = useMemo(() => forecastSales(data.days), [data.days]);
  const scenarioForecast = useMemo(() => alternative.length && !staleScenario ? forecastSales(alternative) : null, [alternative, staleScenario]);
  const monetary = (value: number | null, compact = false) => value === null ? "Not available" : new Intl.NumberFormat("en-GB", { style: "currency", currency: data.currency ?? currency, notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : 2 }).format(value / moneyScale);
  const windowSize = range.start && range.end ? Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1 : 0;
  const historyAge = days.length ? Math.floor((Date.now() - Date.parse(`${days.at(-1)!.date}T00:00:00Z`)) / 86_400_000) : 0;
  const previous = windowSize > 0 ? data.days.filter((day) => day.date >= nextDate(range.start, -windowSize) && day.date < range.start) : [];
  const growth = windowSize === days.length && previous.length === windowSize ? percentageChange(metrics.net, salesMetrics(previous).net) : null;
  function clearSalesImport() {
    if (salesRequest.current) setBusy(false);
    salesRequest.current?.abort(); salesRequest.current = null;
    setSalesFile(null); setSalesHeaders([]); setMapping([]); setDraft(null); setConfirmed(false);
    setMappingIssues([]); setReviewColumns([]); setMappingOpen(false); setSalesStage(null); setSavingImport(false);
  }
  async function readUpload(file: File, approved?: SalesMapping) {
    salesRequest.current?.abort();
    const controller = new AbortController();
    salesRequest.current = controller;
    const signal = controller.signal;
    setDraft(null); setConfirmed(false); setBusy(true); setError(""); setNotice(""); setSalesStage(approved ? "checking" : "reading");
    try {
      if (!currency) throw new Error("Choose the currency used in your sales file.");
      if (!/\.(csv|xlsx)$/i.test(file.name) || !file.size || file.size > 32 * 1024 * 1024) throw new Error("Choose a nonempty CSV or XLSX file up to 32 MiB.");
      const body = await file.arrayBuffer();
      if (signal.aborted) return;
      const query = new URLSearchParams({ currency, filename: file.name, mode: approved ? "preview" : "headers" });
      if (approved) query.set("mapping", JSON.stringify(approved));
      const options = {
        method: "POST", body, signal,
        headers: { "Content-Type": /\.xlsx$/i.test(file.name) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv" },
      };
      const path = `/api/businesses/${businessId}/sales-imports`;
      async function preview(columns: SalesMapping) {
        setSalesStage("checking");
        query.set("mode", "preview"); query.set("mapping", JSON.stringify(columns));
        const { draft } = await api(`${path}?${query}`, salesImportResponseSchema, options, 120_000);
        if (!signal.aborted) { setDraft(draft); setMappingOpen(false); }
      }
      if (approved) await preview(approved);
      else {
        const { headers, suggestions, issues } = await api(`${path}?${query}`, salesHeadersResponseSchema, options, 120_000);
        if (signal.aborted) return;
        const missing = requiredSalesFields.some((field) => !suggestions.includes(field));
        const unknownRequired = requiredSalesFields.some((field) => !suggestions.includes(field) && !issues.some((issue) => issue.field === field));
        setSalesFile(file); setSalesHeaders(headers); setMapping(suggestions); setMappingIssues(issues);
        setReviewColumns(headers.flatMap((_, column) => (unknownRequired && suggestions[column] === null) || issues.some((issue) => issue.column === column) ? [column] : []));
        setMappingOpen(missing || !!issues.length);
        if (!missing && !issues.length) await preview(suggestions);
      }
    } catch (error) { if (!signal.aborted) report(error); }
    finally {
      if (salesRequest.current === controller) {
        salesRequest.current = null;
        if (!signal.aborted) { setBusy(false); setSalesStage(null); }
      }
    }
  }
  async function upload(file: File) {
    clearSalesImport();
    await readUpload(file);
  }
  const missingMappings = requiredSalesFields.filter((field) => !mapping.includes(field));
  const duplicateMappings = mapping.some((field, index) => field !== null && mapping.indexOf(field) !== index);
  async function commit() {
    if (!draft || busy) return;
    await run(async (signal) => {
      setSavingImport(true);
      try {
        const { analytics } = await api(`/api/businesses/${businessId}/sales-imports/${draft.id}/commit`, analyticsResponseSchema, { method: "POST", signal, body: JSON.stringify({ expectedVersion: data.version, confirmRejected: confirmed }) });
        if (signal.aborted) return;
        setData(analytics); setPanel(null); clearSalesImport(); setTab("overview");
        setNotice("Sales baseline saved. Previous imports and scenarios are preserved.");
      } finally { if (!signal.aborted) setSavingImport(false); }
    });
  }
  async function saveManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async (signal) => {
      if (!currency) throw new Error("Choose the currency used in your owner records.");
      const number = (key: string) => {
        const value = Number(form.get(key));
        if (!Number.isFinite(value)) throw new Error(`Enter a valid ${key}.`);
        return value;
      };
      const units = (key: string) => Math.round(number(key) * moneyScale);
      const optional = (key: string, money = false) => String(form.get(key) ?? "").trim() ? (money ? units(key) : number(key)) : null;
      const { analytics } = await api(`/api/businesses/${businessId}/analytics/manual`, analyticsResponseSchema, { method: "POST", signal, body: JSON.stringify({
        expectedVersion: data.version,
        entry: { currency, evidence: form.get("evidence"), estimated: form.get("estimated") === "on", day: {
          date: form.get("date"), gross: units("gross"), discounts: units("discounts"), reversals: units("reversals"),
          orders: number("orders"), units: number("units"), cogs: optional("cogs", true), operatingExpenses: optional("operatingExpenses", true),
          sessions: optional("sessions"), purchasingSessions: optional("purchasingSessions"),
        } },
      }) });
      if (!signal.aborted) { setData(analytics); setPanel(null); setNotice("Owner entry saved with its source. Existing history was not changed."); }
    });
  }
  async function saveScenario() {
    if (!validScenario.success) { setError(validScenario.error.issues.map((item) => item.message).join(" ")); return; }
    if (!scenarioBaseline.length) { setError("Choose a historical period containing recorded sales."); return; }
    if (alreadySaved) { setSavedId(alreadySaved.id); return; }
    await run(async (signal) => {
      const { analytics } = await api(`/api/businesses/${businessId}/analytics/scenarios`, analyticsResponseSchema, { method: "POST", signal, body: JSON.stringify({ expectedVersion: data.version, scenario: validScenario.data }) });
      if (!signal.aborted) { setData(analytics); setSavedId(analytics.scenarios[0]?.id ?? ""); setNotice("Scenario saved separately. Original sales records are unchanged."); }
    });
  }
  function downloadTemplate() {
    const blob = new Blob(["order_id,date,sku,product,quantity,unit_price,line_discount_amount,currency,status\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = "growthpulse-sales-template.csv"; anchor.click(); URL.revokeObjectURL(url);
  }
  const changeScenario = (value: Partial<ScenarioInput>) => { setSavedId(""); setScenario((current) => ({ ...current, ...value })); };
  function columnMapping(index: number) {
    const header = salesHeaders[index], issue = mappingIssues.find((item) => item.column === index);
    return <label className="a-field" key={index}><span className="a-column-heading">{header || `Column ${index + 1} (blank heading)`}</span>
      <select aria-label={`Map column ${index + 1}: ${header || "(blank heading)"}`} value={mapping[index] ?? ""} onChange={(event) => {
        salesRequest.current?.abort(); setDraft(null); setConfirmed(false); setBusy(false);
        const selected = salesFields.find((field) => field === event.target.value) ?? null;
        setMapping((current) => current.map((field, position) => position === index ? selected : field));
      }}><option value="">Skip column (not saved)</option>{salesFields.map((field) => <option key={field} value={field}>{salesFieldLabels[field]}{requiredSalesFields.includes(field) ? " (required)" : ""}</option>)}</select>
      {issue && <small>{mappingIssueLabels[issue.reason]}</small>}
    </label>;
  }
  const hasData = data.days.length > 0;
  if (error && !data.version && !loading) return <div role="alert" className="analytics-alert error">{error} <button type="button" onClick={() => setReload((value) => value + 1)}>Reload workspace</button></div>;
  return <section className="analytics-workspace">
    <div className="analytics-heading">
      <div><p className="analytics-eyebrow"><span /> YOUR SALES WORKSPACE</p><h2>Explore a change. Keep the facts.</h2><p>Website, Instagram, WhatsApp or offline sales. No website required.</p></div>
      <div className="analytics-heading-actions"><span className="analytics-private"><Icon name="shield" /> Private workspace</span><button className="a-button a-primary" disabled={busy || loading || !businessId} onClick={() => { setPanel("import"); clearSalesImport(); }}><Icon name="plus" /> Import sales</button></div>
    </div>
    {error && <div role="alert" className="analytics-alert error" ref={errorHeading} tabIndex={-1}>{error} <button type="button" onClick={() => { setError(""); setReload((value) => value + 1); }}>Reload workspace</button></div>}
    {notice && <p role="status" className="analytics-alert" ref={savedNotice} tabIndex={-1}>{notice}</p>}
    {growthError && <p role="alert" className="analytics-alert">{growthError}</p>}
    {growthAction && <div className="analytics-alert"><strong>Exploring: {growthAction.title}</strong><p>This recommendation is context, not a predicted uplift. Choose your own assumptions below; no action is executed.{!growthAction.planned && " Add it to your growth plan first if you want to save an action-linked scenario."}</p><a href={`#${growthAction.planned ? "actions" : "growth"}?business=${encodeURIComponent(businessId)}&action=${growthAction.id}`}>Back to this growth action</a></div>}
    <div className="analytics-toolbar">
      {!businessManaged && <label className="a-business"><Icon name="box" /><span className="sr-only">Analytics business</span><select aria-label="Analytics business" value={businessId} disabled={busy || loading} onChange={(event) => {
        const id = event.target.value;
        const next = new URLSearchParams({ business: id });
        window.history.replaceState(null, "", `#simulator?${next}`);
        setContext(next); setBusinessId(id); requestedSelection.current.onSelected?.(id);
      }}>{!businesses.length && <option value="">No businesses yet</option>}{businesses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <div className="a-tabs" role="tablist" aria-label="Analytics views">{(["overview", "forecast", "scenario"] as const).map((value) => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{value === "overview" ? "My sales" : value === "forecast" ? "Forecast" : "What if?"}</button>)}</div>
      <button className="a-button a-outline" disabled={busy || loading || !businessId} onClick={() => setPanel("manual")}><Icon name="plus" /> Owner entry</button>
    </div>
    {loading ? <div className="a-loading" role="status"><span className="a-loading-dot" /> Bringing your numbers into focus...</div> : !businessId ? <div className="a-empty"><Icon name="box" /><h2>A home for your business first.</h2><p>Create a business profile to keep sales and scenarios private.</p><a className="a-button a-primary" href="#overview?view=setup&new=1">Create business profile <Icon name="arrow" /></a></div> : <>
      {panel && <section className="a-card a-input-panel" aria-label={panel === "import" ? "Sales import" : "Owner entry"}>
        <div className="a-card-header"><div><p className="analytics-eyebrow">YOUR DATA, NOT A GUESS</p><h2>{panel === "import" ? "Bring your sales history." : "Start with what you know."}</h2></div><button className="a-button a-outline" disabled={busy} onClick={() => { setPanel(null); clearSalesImport(); }}>Close</button></div>
        <label className="a-field a-currency">Currency<select required value={currency} disabled={busy || !!data.currency} onChange={(event) => { setCurrency(event.target.value); clearSalesImport(); setBusy(false); }}><option value="" disabled>Choose currency</option>{Intl.supportedValuesOf("currency").map((item) => <option key={item}>{item}</option>)}</select></label>
        {panel === "import" ? <>
          <div className="a-upload"><span className="a-upload-icon"><Icon name="chart" /></span><div><h3>Upload once. Review your sales.</h3><p>CSV or Excel · Up to 32 MiB / 600,000 rows<br />We match familiar columns and only ask when something is unclear.</p></div><button className="a-button a-primary" disabled={busy || !currency} onClick={() => fileInput.current?.click()}>{salesStage === "checking" ? "Checking sales..." : salesStage === "reading" ? "Matching columns..." : "Choose sales file"}</button><input ref={fileInput} className="sr-only" aria-label="Sales file" type="file" accept=".csv,.xlsx" disabled={busy || !currency} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ""; }} /></div>
          <div className="a-import-help"><p>{!currency ? "Choose the currency in your file to begin. We never guess it." : `Amounts will be read as ${currency}.`} You will review the sales summary before anything is imported.</p><button className="a-text-button" onClick={downloadTemplate}>Download CSV template <Icon name="arrow" /></button></div>
          <details className="a-form-extras"><summary>File format and import rules</summary><p className="a-muted">Required: stable order ID, date, quantity and unit selling price. Familiar column headings are matched using fixed rules, not AI; all matches remain editable. Optional: sku, product, per-line discount amount, currency, status. Dates must use ISO YYYY-MM-DD (for example 2025-01-31); ambiguous slash dates are rejected. Quantity is never assumed and unit price is not calculated from totals. Use booked selling prices, not line totals; no net/gross or currency conversion is inferred. One currency and one worksheet per file. Imported dates cannot overlap owner-entered dates. Use Owner entry for daily totals. UCI Online Retail uses GBP; InvoiceNo / Invoice mappings retain C-prefixed reversal rules.</p></details>
          {salesStage && <p role="status" className="a-muted">{salesStage === "reading" ? "Matching the columns in your file." : "Checking sales and preparing your review."} Large workbooks can take a minute. Nothing is imported until you confirm.</p>}
          {salesFile && <section className="a-review" aria-label="Sales column mapping">
            <div className="a-card-header"><h3>{mappingOpen ? "A quick check before your sales review" : "Columns matched"}</h3>{!mappingOpen && <button className="a-text-button" disabled={busy} onClick={() => setMappingOpen(true)}>Edit column matching</button>}</div>
            {mappingOpen ? <>
              <p id="sales-mapping-help">Choose the sales field for the columns below, or skip any you do not need. Skipped columns are not saved. Do not map customer identifiers to sales fields.</p>
              <fieldset className="a-manual-grid" disabled={busy} aria-describedby="sales-mapping-help"><legend className="sr-only">Columns needing your review</legend>
                {(reviewColumns.length ? reviewColumns : salesHeaders.map((_, index) => index)).map(columnMapping)}
              </fieldset>
              {!!reviewColumns.length && reviewColumns.length < salesHeaders.length && <details className="a-form-extras"><summary>Review other columns</summary><fieldset className="a-manual-grid" disabled={busy}><legend className="sr-only">Other source columns</legend>{salesHeaders.flatMap((_, index) => reviewColumns.includes(index) ? [] : [columnMapping(index)])}</fieldset></details>}
              {!!missingMappings.length && <p role="status">Match required fields: {missingMappings.map((field) => salesFieldLabels[field]).join(", ")}.</p>}
              {duplicateMappings && <p role="alert">Map each sales field only once. Skip or change duplicate mappings.</p>}
              <button className="a-button a-primary" disabled={busy || !!missingMappings.length || duplicateMappings} onClick={() => void readUpload(salesFile, mapping)}>Preview sales</button>
            </> : <p>{mapping.filter(Boolean).length} columns matched · {mapping.filter((field) => field === null).length} skipped. You can inspect or change every match before importing.</p>}
          </section>}
          {draft && <div className="a-review" aria-label="Review sales import"><div className="a-card-header"><h3>{draft.filename}</h3><span className="a-badge">{draft.committed ? "Already imported" : "Review before saving"}</span></div>
            <p className="a-import-total"><span>Net sales in this file</span><strong>{monetary(salesMetrics(draft.snapshot.days).net)}</strong></p>
            <div className="a-review-stats"><span><strong>{fmt.format(draft.snapshot.accepted)}</strong> accepted rows</span><span><strong>{fmt.format(draft.snapshot.rejected)}</strong> rejected</span><span><strong>{fmt.format(draft.snapshot.excluded)}</strong> cancelled rows excluded</span><span><strong>{draft.snapshot.days.length}</strong> observed dates</span></div>
            <p>{dateLabel(draft.snapshot.days[0].date)} – {dateLabel(draft.snapshot.days.at(-1)!.date)} · {draft.snapshot.currency} · No automatic currency conversion</p>
            {!!draft.snapshot.warnings.length && <details className="a-form-extras a-import-notes"><summary>Import notes ({draft.snapshot.warnings.length})</summary><ul>{draft.snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
            {!!draft.snapshot.rejected && <><ul className="a-row-errors">{draft.snapshot.errors.map((message) => <li key={message}>{message}</li>)}</ul><label className="a-checkbox"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Import valid rows only; I acknowledge the rejected rows above.</label></>}
            <p><strong>Confirming replaces your imported sales history; it does not add to it.</strong> Previous imports and scenario snapshots stay saved. Owner entries, traffic and costs are not changed.</p>
            {savingImport && <p role="status">Saving your reviewed sales history. Please wait for confirmation.</p>}
            {error && <p className="form-error">Sales import was not confirmed: {error}</p>}
            <button className="a-button a-primary" disabled={busy || draft.committed || (!!draft.snapshot.rejected && !confirmed)} onClick={() => void commit()}>{savingImport ? "Saving sales..." : "Confirm sales import"} <Icon name="check" /></button>
          </div>}
        </> : <form onSubmit={(event) => void saveManual(event)}><fieldset className="a-manual-grid" disabled={busy}><legend className="sr-only">Daily owner-reported metrics</legend>
          <label className="a-field">Recorded date<input required name="date" type="date" max={new Date().toISOString().slice(0, 10)} /></label>
          <label className="a-field">Sales before discounts and refunds<input name="gross" type="number" step="0.0001" min="0" required /></label>
          <label className="a-field">Number of orders<input name="orders" type="number" step="1" min="0" required /></label>
          <label className="a-field a-wide">Where did these numbers come from?<input name="evidence" required minLength={3} maxLength={300} placeholder="e.g. Daily register report" /></label>
          <details className="a-form-extras a-wide"><summary>Add discounts, costs or website visits (optional)</summary><div className="a-manual-grid">
            {[["discounts", "Discounts"], ["reversals", "Refunds / sales reversals"], ["units", "Net units sold"], ["cogs", "Cost of goods sold"], ["operatingExpenses", "Other operating expenses"], ["sessions", "Website sessions"], ["purchasingSessions", "Sessions with a purchase"]].map(([key, label]) => <label className="a-field" key={key}>{label}<input name={key} type="number" step={["units", "sessions", "purchasingSessions"].includes(key) ? "1" : "0.0001"} min={key === "units" ? undefined : "0"} defaultValue={["discounts", "reversals", "units"].includes(key) ? "0" : undefined} /></label>)}
          </div><p className="a-muted">Leave unknown costs and traffic blank—not zero. Expenses exclude the cost of goods. Sessions and purchasing sessions must describe the same business and day.</p></details>
          <label className="a-checkbox a-wide"><input name="estimated" type="checkbox" />These are estimates, not verified actuals.</label>
          <p className="a-muted a-wide">Save one day at a time. Existing dates are never overwritten.</p>
          <button className="a-button a-primary" type="submit" disabled={!currency}>{busy ? "Saving..." : "Save owner entry"}</button>
        </fieldset></form>}
      </section>}
      {!hasData ? <div className="a-empty"><div className="a-empty-art"><i /><i /><i /><i /><i /><i /><span><Icon name="spark" /></span></div><span className="a-badge">A FRESH PERSPECTIVE STARTS HERE</span><h2>Your next chapter starts<br />with your numbers.</h2><p>Upload historical sales or enter a daily record.<br />Website, Instagram, WhatsApp and offline sellers use the same flow.<br />We will never fill the gaps with made-up growth.</p><div className="a-actions"><button className="a-button a-primary" onClick={() => setPanel("import")}>Import sales history <Icon name="arrow" /></button><button className="a-button a-outline" onClick={() => setPanel("manual")}>Enter data manually</button></div><p className="a-muted">No website or AI key needed. Reading saved results uses no scan or AI allowance.</p></div> : <>
        <div className="a-section-heading"><div><h2>{tab === "overview" ? "Your sales at a glance" : tab === "forecast" ? "What might come next?" : "What if things changed?"}</h2></div>{tab !== "scenario" && <div className="a-date-range"><label>From<input aria-label="Start date" type="date" value={range.start} onChange={(event) => setRange({ ...range, start: event.target.value })} /></label><span>—</span><label>To<input aria-label="End date" type="date" value={range.end} onChange={(event) => setRange({ ...range, end: event.target.value })} /></label></div>}</div>
        {data.sources.some((source) => source.kind === "estimate") && <p className="analytics-alert">This history contains owner estimates. Forecasts are not based exclusively on verified actuals.</p>}
        {tab !== "scenario" ? <>
          {tab === "overview" && <div className="a-kpi-grid">
            {[{ label: "Net sales", value: days.length ? monetary(metrics.net) : "—", note: growth === null ? "After discounts & sales reversals" : `${growth >= 0 ? "+" : ""}${growth.toFixed(1)}% vs previous equal calendar window`, icon: "chart" as const },
              { label: "Orders", value: days.length ? fmt.format(metrics.orders) : "—", note: "Distinct order IDs, not line items", icon: "box" as const },
              { label: "Average order value", value: monetary(metrics.aov), note: "Sales per order, before later refunds", icon: "pulse" as const }].map((item) => <article className="a-kpi" key={item.label}><div><span>{item.label}</span><Icon name={item.icon} /></div><strong>{item.value}</strong><p>{item.note}</p></article>)}
          </div>}
          {tab === "forecast" && !!days.length && <div className="a-forecast-context" aria-label="Forecast period">
            <h3>{forecast ? `${dateLabel(forecast.points[0].date)} – ${dateLabel(forecast.points.at(-1)!.date)}` : "More recorded dates needed"}</h3>
            <p>{forecast ? "30 calendar days after the last selected sales record." : `${days.length} of at least 28 observed dates available. Missing dates do not count as zero-sales days.`}</p>
            {historyAge > 30 && <p className="analytics-alert">Selected history ends on {dateLabel(days.at(-1)!.date)}, more than 30 days ago. This is an outlook for that historical period, not a forecast starting today. Import recent sales for a current outlook.</p>}
            {windowSize > days.length && <p className="analytics-alert">{windowSize - days.length} calendar days in this range have no sales record. Missing sales stay unknown; gaps can reduce forecast reliability.</p>}
          </div>}
          {!days.length ? <p className="analytics-alert">No recorded dates in this range. Choose a valid range containing your history.</p> : <>
            <div className={`a-main-grid${tab === "overview" ? " a-history-grid" : ""}`}><section className="a-card a-sales-card"><div className="a-card-header"><div><p className="analytics-eyebrow">{tab === "forecast" ? "HISTORY → POSSIBILITIES" : "YOUR PERFORMANCE, OVER TIME"}</p><h3>{tab === "forecast" ? "Net sales + 30-day forecast" : "Sales trajectory"}</h3></div><span className="a-legend"><i />Actual {tab === "forecast" && <><i className="purple" />Forecast</>}</span></div><SalesChart days={days} currency={data.currency!} forecast={tab === "forecast" ? forecast : null} /><p className="a-chart-caption">{data.currency} · {days.length} observed dates / {windowSize} calendar days. Missing dates are unknown; plotted lines connect observations.</p></section>
              {tab === "forecast" && <aside className="a-forecast-card"><span className="a-card-icon"><Icon name="spark" /></span><span className="a-badge">SALES ESTIMATE</span><p>Total for the forecast period</p><strong>{forecast ? monetary(forecast.total, true) : "More history needed"}</strong><p>{forecast ? `${dateLabel(forecast.points[0].date)} – ${dateLabel(forecast.points.at(-1)!.date)}` : "Add at least 28 observed dates to compare forecasting methods."}</p>{forecast && <div className="a-forecast-meta"><span>Average error on past days<strong>{monetary(forecast.mae)}</strong></span><span>Days checked<strong>{forecast.testedDays}</strong></span></div>}<div className="a-forecast-foot"><Icon name="shield" /><span>An estimate, not a guarantee. The shaded range is illustrative, not a calibrated probability interval.</span></div></aside>}</div>
            {tab === "forecast" ? <details className="a-more-details"><summary>How we check this estimate</summary><section className="a-card"><p className="a-muted">We compare three simple methods using later historical days that were not available when each prediction was made. The method with the smallest average daily error is selected. This one-day test does not guarantee 30-day accuracy.</p>{forecast ? <div className="a-model-grid">{forecast.scores.map((score, index) => <div key={score.model}><span className="a-badge">{index === 0 ? "SELECTED" : "BENCHMARK"}</span><h4>{score.model}</h4><strong>{monetary(score.mae)}</strong><p>Average daily test error</p></div>)}</div> : <p className="a-muted">More history is needed to compare methods.</p>}<p className="a-muted">The shaded range is an indicative residual band, not a calibrated 95% prediction interval. Missing dates, incomplete exports, unusual promotions and stock changes can reduce reliability. Forecasts start after your latest recorded date, not necessarily today.</p></section></details> :
              <details className="a-more-details"><summary>Sales breakdown, profit and monthly orders</summary><div className="a-secondary-grid"><section className="a-card"><div className="a-card-header"><h3>Orders, month by month</h3><span className="a-badge">RECORDED HISTORY</span></div><OrdersChart days={days} /><p className="a-chart-caption">Partial months are not extrapolated. Missing dates are not treated as zero.</p></section><section className="a-card"><div className="a-card-header"><h3>The sales breakdown</h3><Icon name="sliders" /></div><dl className="a-breakdown">{[["Gross sales", metrics.gross], ["Discounts", -metrics.discounts], ["Sales reversals", -metrics.reversals], ["Net sales", metrics.net]].map(([label, amount]) => <div key={String(label)}><dt>{label}</dt><dd>{monetary(Number(amount))}</dd></div>)}</dl><p className="a-muted">No separate tax/shipping fields are imported. Source-coded charges remain line items. A sale is not profit.</p><div className="a-mini-metrics"><span>Gross margin<strong>{metrics.grossMargin === null ? "Add cost of goods" : `${metrics.grossMargin.toFixed(1)}%`}</strong></span><span>Session conversion<strong>{metrics.conversion === null ? "Add website sessions" : `${metrics.conversion.toFixed(2)}%`}</strong></span><span>Operating profit<strong>{metrics.operatingProfit === null ? "Add costs" : monetary(metrics.operatingProfit)}</strong></span></div></section></div></details>}
          </>}
        </> : <div className="a-scenario-layout"><section className="a-card a-scenario-controls"><div className="a-card-header"><div><span className="a-badge">WHAT-IF STUDIO</span><h3>Change the assumptions.<br />Not the facts.</h3></div><Icon name="sliders" /></div>
          <label className="a-field">Saved scenarios<select value={savedId} disabled={busy} onChange={(event) => {
            setSavedId(event.target.value); setScenarioGoal(null);
            const selected = data.scenarios.find((item) => item.id === event.target.value);
            if (selected) { setScenario(selected.input); setGrowthAction(null); setCostOpen(selected.input.costPct !== 0); }
          }}><option value="">Unsaved scenario</option>{data.scenarios.map((item, index) => <option key={item.id} value={item.id}>#{data.scenarios.length - index} {item.input.name} · {scenarioSummary(item.input)}{item.baselineVersion !== data.version ? " · older baseline" : ""}</option>)}</select></label>
          {saved && <p className="a-muted">Saved {new Date(saved.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · {scenarioSummary(saved.input)}</p>}
          {scenario.opportunityId && <a className="a-linked-action" href={`#actions?business=${encodeURIComponent(businessId)}&action=${scenario.opportunityId}`}>View linked growth action</a>}
          <label className="a-field">Scenario name<input value={scenario.name} maxLength={80} onChange={(event) => changeScenario({ name: event.target.value })} /></label>
          <div className="a-scenario-goals" role="group" aria-label="Choose a change to explore"><p>What would you like to explore?</p>{([
            ["ordersPct", "More orders"], ["aovPct", "Higher spending per order"], ["costPct", "Changed product costs"],
          ] as const).map(([field, label]) => <button key={field} type="button" aria-pressed={scenarioGoal === field} onClick={() => { if (field === "costPct") setCostOpen(true); setScenarioGoal(field); scenarioInputs.current[field]?.focus(); }}>{label}</button>)}<small>Choose a focus, then set your own percentage. You can combine changes.</small></div>
          <p className="a-period">Historical period: {scenario.start && scenario.end ? `${dateLabel(scenario.start)} – ${dateLabel(scenario.end)}` : "Choose recorded dates"}</p>
          <details className="a-form-extras"><summary>Choose which historical dates to change</summary><div className="a-two-fields"><label className="a-field">History from<input type="date" value={scenario.start} onChange={(event) => changeScenario({ start: event.target.value })} /></label><label className="a-field">History to<input type="date" value={scenario.end} onChange={(event) => changeScenario({ end: event.target.value })} /></label></div></details>
          {([["ordersPct", "Order volume"], ["aovPct", "Average order value"], ["costPct", "Unit cost of goods"]] as const).map(([field, label]) => {
            const valid = Number.isFinite(scenario[field]) && scenario[field] >= -100 && scenario[field] <= 300;
            const control = <fieldset className="a-slider" key={field}><legend>{label}</legend><div className="a-slider-inputs">
              <input aria-label={label} type="range" min="-100" max="300" step="1" value={valid ? scenario[field] : 0} onChange={(event) => changeScenario({ [field]: Number(event.target.value) })} />
              <label><input ref={(input) => { scenarioInputs.current[field] = input; }} aria-label={`${label} change (%)`} aria-invalid={!valid} type="number" min="-100" max="300" step="any" value={Number.isFinite(scenario[field]) ? scenario[field] : ""} onChange={(event) => changeScenario({ [field]: event.target.valueAsNumber })} /><span>%</span></label>
            </div><small>{field === "costPct" ? "Only changes results where product costs are recorded. Unknown costs stay unknown." : field === "ordersPct" ? "Changes order counts and related sales and costs." : "Changes sales per order, keeping the same discount and return proportions."}</small></fieldset>;
            return field === "costPct" ? <details className="a-form-extras" key={field} open={costOpen} onToggle={(event) => setCostOpen(event.currentTarget.open)}><summary>Adjust product costs (optional)</summary>{control}</details> : control;
          })}
          <p className="a-muted">Operating expenses stay fixed. Session conversion is not inferred from order changes. These are assumptions, not estimated causal effects.</p><button className="a-button a-primary" disabled={busy || !validScenario.success || !scenarioBaseline.length || staleScenario || !!alreadySaved} onClick={() => void saveScenario()}><Icon name="check" />Save separate scenario</button>
          {alreadySaved && <p className="a-muted" role="status">These settings are already saved. Change the name, dates or assumptions to save another scenario.</p>}
        </section><div className="a-scenario-results"><p className="a-scenario-explanation">This changes a copy of historical sales, not your actual records. It does not predict the future effect of a campaign or growth action.</p>{staleScenario ? <div className="analytics-alert">This saved scenario belongs to an older baseline. Its snapshot is retained, but is not compared with changed actuals. Edit a control to start a new scenario on current history.</div> : !validScenario.success ? <p role="alert" className="analytics-alert error">Enter a scenario name, a valid date range and percentage changes between -100% and 300%.</p> : !scenarioBaseline.length ? <p role="alert" className="analytics-alert">Choose a historical period containing recorded sales before comparing results.</p> : <>
          <p className="a-period">Comparing {scenarioBaseline.length} recorded dates in the selected historical period. Missing dates stay unknown.</p>
          <div className="a-scenario-summary" aria-label="Net sales comparison"><span><small>Original net sales</small><strong>{monetary(originalMetrics.net)}</strong></span><span><small>What-if net sales</small><strong>{monetary(scenarioMetrics.net)}</strong></span><span><small>Difference in net sales</small><strong>{scenarioMetrics.net > originalMetrics.net ? "+" : ""}{monetary(scenarioMetrics.net - originalMetrics.net)}</strong>{scenarioNetChange !== null && <small>{scenarioNetChange > 0 ? "+" : ""}{scenarioNetChange.toFixed(1)}% vs original</small>}</span></div>
          <div className="a-scenario-kpis">{[
            ["Orders", fmt.format(originalMetrics.orders), fmt.format(scenarioMetrics.orders)],
            ["Average order value", monetary(originalMetrics.aov), monetary(scenarioMetrics.aov)],
            ...(originalMetrics.grossProfit === null ? [] : [["Gross profit", monetary(originalMetrics.grossProfit), monetary(scenarioMetrics.grossProfit)]]),
            ...(originalMetrics.operatingProfit === null ? [] : [["Operating profit", monetary(originalMetrics.operatingProfit), monetary(scenarioMetrics.operatingProfit)]]),
          ].map(([label, original, changed]) => <div key={label}><span>{label}</span><small>Original: {original}</small><strong>What-if: {changed}</strong></div>)}</div>
          <section className="a-card"><div className="a-card-header"><h3>The alternative history</h3><span className="a-legend"><i />Actual<i className="purple" />What-if</span></div><SalesChart days={scenarioBaseline} scenario={scenarioComparison} currency={data.currency!} /><p className="a-chart-caption">Original imported and owner-entered records remain unchanged. Fractional order assumptions are rounded per day.</p></section>
          {baselineForecast && scenarioForecast && <details className="a-more-details"><summary>Compare forecasts from both histories</summary><section className="a-card"><div className="a-card-header"><div><h3>Two histories. Two possible outlooks.</h3><p className="a-muted">{dateLabel(baselineForecast.points[0].date)} – {dateLabel(baselineForecast.points.at(-1)!.date)} · Original: {monetary(baselineForecast.total)} · Alternative: {monetary(scenarioForecast.total)}</p></div></div><ForecastComparison original={baselineForecast} changed={scenarioForecast} /><p className="a-muted">These outlooks use each full history and start after the last recorded date, not necessarily today. Each history is backtested independently. A changed historical input does not prove a website change would cause this uplift.</p></section></details>}
        </>}</div></div>}
        <details className="a-more-details"><summary>Imported items, sources and how it works</summary>
        {tab === "overview" && data.products.length > 0 && <section className="a-card"><div className="a-card-header"><div><h3>Leading imported items</h3><p className="a-muted">Entire active import, independent of date filter · ranked by net sales, not margin · source items may include services or postage</p></div><Icon name="box" /></div><div className="a-products">{data.products.slice(0, 6).map((product, index) => <div key={product.sku}><span className="a-product-rank">{String(index + 1).padStart(2, "0")}</span><span><strong>{product.name}</strong><small>{product.sku} · {fmt.format(product.units)} net units</small></span><div className="a-product-bar"><i style={{ width: `${Math.max(0, product.netSales / Math.max(1, data.products[0].netSales)) * 100}%` }} /></div><strong>{monetary(product.netSales)}</strong></div>)}</div></section>}
        <section className="a-card"><div className="a-card-header"><div><h3>From history to your next move</h3><p className="a-muted">A transparent path. No fabricated inputs or automatic changes.</p></div></div><div className="a-data-flow" aria-label="CSV or owner entry becomes a recorded baseline, a statistical forecast, and a separate what-if scenario">{[["Bring your data", "CSV, Excel or owner records"], ["Preserve the facts", "Validated, private baseline"], ["Look ahead", "Backtested sales forecast"], ["Explore a change", "Separate what-if history"]].map(([title, caption], index) => <div key={title}><span className="a-flow-step">{index + 1}</span><strong>{title}</strong><small>{caption}</small>{index < 3 && <Icon name="arrow" />}</div>)}</div></section>
        <section className="a-card a-provenance"><div><span className="a-card-icon"><Icon name="shield" /></span><h3>Every number has a source.</h3><p>{data.sources[0]?.name} · {data.currency} · {data.days.length} recorded dates. {data.sources.filter((source) => source.kind !== "import").length} owner entries. Unknown traffic and costs remain unknown.</p></div><span className="a-badge">GA4 · PLANNED, NOT CONNECTED</span></section>
        </details>
      </>}
      {tab === "overview" && <details className="a-more-details a-optional-traffic"><summary>Website visits & conversion (optional)</summary><TrafficWorkspace key={businessId} businessId={businessId} data={data} start={range.start} end={range.end} onUpdated={setData} onSessionExpired={onSessionExpired} /></details>}
      <details className="a-more-details a-data-needs"><summary>What other data do I need?</summary><div className="a-data-needs-grid">
        <div><h3>Costs → profit</h3><p>Add the cost of goods and operating expenses for the same dates as your sales. Leave unknown amounts blank.</p></div>
        <div><h3>Website sessions → conversion</h3><p>Use Import website visits inside My sales → Website visits &amp; conversion for a daily traffic CSV from the same business and sales channel. Conversion comes from traffic's purchasing sessions, not sales order counts. Google account sync is still planned.</p></div>
        <div><h3>Business changes → better context</h3><p>Keep a dated record of promotions, ad spend, price changes and stockouts. These are useful future forecasting inputs, not currently collected automatically.</p></div>
      </div><p className="a-muted">Use the paired Google sales and traffic samples in one separate sample business. Do not mix them with the unrelated UCI retail workbook. <a href="https://developers.google.com/analytics/bigquery/web-ecommerce-demo-dataset" target="_blank" rel="noreferrer">Google's official sample dataset ↗</a></p></details>
      <details className="a-definitions"><summary>Behind the numbers · formulas, assumptions & source notes</summary><div className="a-definitions-grid">
        <div><h3>Published ecommerce definitions</h3><p>Gross sales = Σ(quantity × unit selling price). Net sales = gross − discounts − sales reversals. AOV = (gross − discounts) ÷ distinct orders, excluding post-order adjustments.</p><a href="https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/sales-report" target="_blank" rel="noreferrer">Shopify sales definitions ↗</a></div>
        <div><h3>Margins and conversion</h3><p>Gross profit = net sales − COGS. Gross margin = gross profit ÷ positive net sales × 100. Operating profit = gross profit − operating expenses (excluding COGS). Conversion = purchasing sessions ÷ total sessions × 100. Unknown inputs stay unknown.</p></div>
        <div><h3>Historical data, not a promise</h3><p>Missing dates are not filled with zero. Forecasts compare last-observation, trailing-seven-observation and weekday-average models using rolling chronological validation. Sparse data and structural changes limit reliability. Scenario history never trains the original baseline.</p></div>
        <div><h3>UCI dataset attribution</h3><p>When using Online Retail: Chen, D. (2015), UCI Machine Learning Repository, CC BY 4.0. Prices are GBP; historic UK retail performance is not your business's performance.</p><a href="https://doi.org/10.24432/C5BW33" target="_blank" rel="noreferrer">Dataset source & licence ↗</a></div>
      </div>{data.warnings.map((warning) => <p className="a-muted" key={warning}>{warning}</p>)}</details>
    </>}
  </section>;
}
