import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, CircleHelp, Sparkles } from "lucide-react";
import type { Product } from "../shared/products";
import { productResponseSchema } from "../shared/products";
import {
  productDimensionLabels, productIntelligenceResponseSchema, productReadiness,
  type ProductEvidence, type ProductIntelligenceResponse, type SavedProductAnalysis,
} from "../shared/product-intelligence";
import { growthPlanResponseSchema } from "../shared/growth";
import { api, ApiFailure, errorMessage } from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { BlurFade } from "./components/ui/blur-fade";
import { EvidenceExcerpt, SourceReference } from "./SourceDetails";
import { WorkflowActivity } from "./WorkflowActivity";

const productStages = [
  { key: "preparing", label: "Prepare evidence" }, { key: "analysing", label: "Analyse and draft" },
  { key: "validating", label: "Check findings" }, { key: "saving", label: "Save analysis" },
] as const;
const productMessages = {
  preparing: "Preparing this product's saved catalogue excerpts.",
  analysing: "Reviewing your product and drafting recommendations.",
  validating: "Checking the findings against your product information.",
  saving: "Saving the accepted analysis for you to review.",
};

const areas = [
  { key: "analysis", label: "Product analysis" }, { key: "optimizer", label: "Listing optimizer" },
  { key: "seo", label: "SEO readiness" }, { key: "opportunities", label: "Product opportunities" },
  { key: "performance", label: "Performance" },
] as const;
type Area = typeof areas[number]["key"];
function Evidence({ evidence, references }: { evidence: ProductEvidence[]; references: string[] }) {
  const selected = evidence.filter((item) => references.includes(item.id));
  if (!selected.length) return null;
  return <details className="agent-sources product-citations"><summary>View sources ({selected.length})</summary>
    {selected.map((item) => <article key={item.id}><p className="field-note">{item.sourceName} · {item.source === "manual" ? "Catalogue record" : item.source === "csv" ? "CSV record" : "Website-sourced record"}</p>
      <blockquote><EvidenceExcerpt quote={item.quote} /></blockquote>
      <SourceReference reference={item.reference} source={item.source} />
      <p className="field-note">Recorded <time dateTime={item.capturedAt}>{new Date(item.capturedAt).toLocaleString()}</time></p>
    </article>)}
  </details>;
}
export function ProductIntelligence({ businessId, product, products, thumbnail, onBack, onProductSaved, onAnalysed, onSessionExpired }: {
  businessId: string; product: Product; products: Product[]; thumbnail: ReactNode; onBack: () => void;
  onProductSaved: (product: Product) => void; onAnalysed: (analysis: SavedProductAnalysis) => void; onSessionExpired: () => void;
}) {
  const [area, setArea] = useState<Area>("analysis");
  const [data, setData] = useState<ProductIntelligenceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [startingAnalysis, setStartingAnalysis] = useState(false);
  const [approved, setApproved] = useState(false);
  const [reload, setReload] = useState(0);
  const [rewrite, setRewrite] = useState({ title: "", description: "", seoTitle: "", metaDescription: "" });
  const [planned, setPlanned] = useState<number[]>([]);
  const callbacks = useRef({ onAnalysed, onSessionExpired, onProductSaved });
  callbacks.current = { onAnalysed, onSessionExpired, onProductSaved };
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusArea = useRef(false);
  const mutationVersion = useRef(0);
  const endpoint = `/api/businesses/${businessId}/products/${product.id}`;
  useEffect(() => { setData(null); }, [endpoint, product]);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true); setError(""); setBusy(false); setStartingAnalysis(false); setApproved(false);
    async function load() {
      const version = mutationVersion.current;
      try {
        const snapshot = await api(`${endpoint}/intelligence`, productIntelligenceResponseSchema, { signal: active.signal });
        if (active.signal.aborted || version !== mutationVersion.current) return;
        setData(snapshot);
        if (snapshot.analysis && !snapshot.stale) callbacks.current.onAnalysed(snapshot.analysis);
        if (snapshot.running) timer = setTimeout(() => { void load(); }, 1500);
      } catch (error) {
        if (active.signal.aborted) return;
        if (error instanceof ApiFailure && error.status === 401) callbacks.current.onSessionExpired();
        else setError(errorMessage(error));
      } finally { if (!active.signal.aborted) setLoading(false); }
    }
    void load();
    return () => { active.abort(); clearTimeout(timer); };
  }, [endpoint, product, reload]);
  const analysis = data?.analysis;
  useEffect(() => {
    if (analysis) setRewrite(analysis.result.rewrite);
    setApproved(false); setPlanned([]);
  }, [analysis?.id]);
  useEffect(() => { if (focusArea.current) heading.current?.focus(); }, [area]);
  function navigate(next: Area) { focusArea.current = true; setArea(next); }
  async function mutate(action: (signal: AbortSignal) => Promise<void>) {
    if (busy || !controller.current || controller.current.signal.aborted) return;
    const signal = controller.current.signal;
    mutationVersion.current++;
    setBusy(true); setError(""); setNotice("");
    try { await action(signal); }
    catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiFailure && error.status === 401) callbacks.current.onSessionExpired();
      else setError(errorMessage(error));
    } finally { if (!signal.aborted) { mutationVersion.current++; setBusy(false); } }
  }
  async function analyse() {
    const active = controller.current;
    let poll = false;
    await mutate(async (signal) => {
      setStartingAnalysis(true);
      let snapshot: ProductIntelligenceResponse;
      try {
        snapshot = await api(`${endpoint}/intelligence`, productIntelligenceResponseSchema,
          { method: "POST", headers: { Prefer: "respond-async" }, body: JSON.stringify({ consent: true }), signal }, 60_000);
      } catch (error) {
        if ((error instanceof Error || error instanceof DOMException) && error.name === "TimeoutError") {
          throw new Error("The browser stopped waiting for product analysis. The server may still finish and save it. Reload saved status before starting another analysis.");
        }
        throw error;
      }
      if (signal.aborted) return;
      mutationVersion.current++;
      setData(snapshot);
      poll = snapshot.running;
      if (snapshot.analysis && !snapshot.stale) callbacks.current.onAnalysed(snapshot.analysis);
      setNotice(snapshot.running ? "" : "Product analysis saved. Suggestions are drafts; your catalogue and website have not changed.");
    });
    if (active && !active.signal.aborted) {
      setStartingAnalysis(false);
      if (poll) setReload((value) => value + 1);
    }
  }
  async function saveListing() {
    if (!analysis || !approved || data?.stale) return;
    await mutate(async (signal) => {
      const { product: saved } = await api(`${endpoint}/approve-listing`, productResponseSchema, {
        method: "POST", signal, body: JSON.stringify({ analysisId: analysis.id, title: rewrite.title, description: rewrite.description }),
      });
      if (signal.aborted) return;
      callbacks.current.onProductSaved(saved); setApproved(false);
      setNotice("Approved title and description saved to your local catalogue only. Imported source listings and the live website are unchanged.");
    });
  }
  async function plan(index: number) {
    if (!analysis || data?.stale) return;
    await mutate(async (signal) => {
      await api(`${endpoint}/growth-plan`, growthPlanResponseSchema, { method: "POST", signal, body: JSON.stringify({ analysisId: analysis.id, index }) });
      if (signal.aborted) return;
      setPlanned((items) => [...new Set([...items, index])]);
      setNotice("Added to your growth plan for owner prioritization. No change or experiment has been launched.");
    });
  }
  const checks = productReadiness(product), present = checks.filter((check) => check.present).length;
  const normalizedDescription = product.description.trim().toLowerCase().replace(/\s+/g, " ");
  const duplicates = normalizedDescription ? products.filter((item) => item.id !== product.id && item.description.trim().toLowerCase().replace(/\s+/g, " ") === normalizedDescription) : [];
  return <section className="product-intelligence" aria-label={`${product.name} product workspace`}>
    <Button className="product-back" variant="ghost" onClick={onBack}><ArrowLeft />All products</Button>
    <div className="product-workspace-heading"><div className="product-identity">{thumbnail}<div>
      <p className="section-eyebrow">YOUR PRODUCT / SAVED CATALOGUE</p><h2>{product.name}</h2>
      <p className="field-note">{product.sku ? `SKU ${product.sku}` : "SKU not recorded"} · {product.listings.length} source {product.listings.length === 1 ? "listing" : "listings"}</p>
    </div></div><Badge variant="outline">{loading ? "Loading analysis" : data?.running || busy ? "Working" : analysis ? data?.stale ? "Analysis needs refresh" : "Analysis saved" : "Not analysed"}</Badge></div>
    <nav className="product-area-nav" aria-label="Product workspace">{areas.map((item) =>
      <Button key={item.key} variant={area === item.key ? "secondary" : "ghost"} aria-current={area === item.key ? "page" : undefined} onClick={() => navigate(item.key)}>{item.label}</Button>)}</nav>
    <h3 ref={heading} tabIndex={-1}>{areas.find((item) => item.key === area)!.label}</h3>
    {error && <p className="form-error" role="alert">{error} <button type="button" className="text-button" disabled={busy} onClick={() => setReload((value) => value + 1)}>Reload saved status</button></p>}
    {notice && <p className="catalogue-notice" role="status">{notice}</p>}
    {data?.error && !error && <p role="alert" className="form-error">{data.error}</p>}
    {data?.stale && <p className="field-note product-stale">Product evidence has changed. This is an older analysis; review a fresh analysis before applying its drafts or planning its suggestions.</p>}
    {(startingAnalysis || data?.running) && <WorkflowActivity title="Product analysis"
      message={data?.progress ? productMessages[data.progress.stage] : startingAnalysis
        ? "Starting your product analysis..."
        : "Loading your analysis progress..."}
      startedAt={data?.progress?.startedAt} updatedAt={data?.progress?.updatedAt}
      stages={productStages.map((stage, index) => {
        const current = productStages.findIndex((item) => item.key === data?.progress?.stage);
        return { label: stage.label, state: index < current ? "completed" : index === current ? "running" : "pending" };
      })}
      counts={data?.progress?.evidenceCount != null ? [{ label: "Saved evidence excerpts", value: data.progress.evidenceCount }] : []}
      guidance={data?.running ? "Your analysis continues if you leave this page." : "Keep this page open while your analysis starts."} />}
    {!data?.running && (area !== "performance" && (!analysis || data?.stale)) && <Card className="product-analysis-callout"><CardHeader>
      <CardTitle><Sparkles />Understand what to improve</CardTitle><CardDescription>A product-specific diagnosis, factual listing draft and prioritized recommendations from saved catalogue evidence. No new website scan.</CardDescription>
    </CardHeader><CardContent>
      {loading ? <p role="status">Loading saved product intelligence...</p>
        : data && !data.configured ? <p>Product AI analysis is not configured on this server. Catalogue checks and existing saved results remain available.</p>
        : data && <><p className="field-note">Starting analysis sends this product&apos;s saved catalogue excerpts to Anthropic. AI charges may apply. Nothing will be published.</p>
          <Button disabled={busy} onClick={() => void analyse()}><Sparkles />{busy ? "Analysing product..." : data.error ? "Retry product analysis" : "Analyse this product"}</Button></>}
    </CardContent></Card>}
    <BlurFade key={area} duration={0.2}>
      {area === "analysis" && <div className="product-analysis-content">
        {analysis && <Card><CardHeader><p className="section-eyebrow">AI DIAGNOSIS / OWNER REVIEW</p><CardTitle>{analysis.result.summary.text}</CardTitle>
          <CardDescription>Saved {new Date(analysis.createdAt).toLocaleString()}. Based on catalogue excerpts, not a live-page audit or measured sales.</CardDescription>
        </CardHeader><CardContent><Evidence evidence={analysis.evidence} references={analysis.result.summary.references} />
          <div className="product-dimensions">{analysis.result.dimensions.map((item) => <details key={item.dimension}>
            <summary>{productDimensionLabels[item.dimension]}<Badge variant="outline">{item.status === "supported" ? "Observation" : item.status === "needs_review" ? "Review suggested" : "Not assessed"}</Badge></summary>
            <p>{item.diagnosis}</p><Evidence evidence={analysis.evidence} references={item.references} />
          </details>)}</div>
          <Button variant="outline" onClick={() => navigate("opportunities")}>Review prioritized improvements<ArrowRight /></Button>
        </CardContent></Card>}
        <Card><CardHeader><CardTitle>{present} of {checks.length} information fields recorded</CardTitle>
          <CardDescription>A transparent catalogue checklist, not an AI quality score. Missing information may exist on the website; some fields may not apply to this product.</CardDescription>
        </CardHeader><CardContent><ul className="product-checklist">{checks.map((check) => <li key={check.key}>{check.present ? <Check aria-label="Recorded" /> : <CircleHelp aria-label="Not recorded" />}
          <span>{check.label}</span><span>{check.present ? "Recorded" : "Review"}</span></li>)}</ul></CardContent></Card>
      </div>}
      {area === "optimizer" && <Card><CardHeader><CardTitle>A clearer listing, still your decision</CardTitle>
        <CardDescription>Compare the reviewed catalogue with an AI draft. Check every claim before approving. Only title and description can be saved locally.</CardDescription></CardHeader><CardContent>
        <div className="product-rewrite-grid"><section><p className="section-eyebrow">CURRENT CATALOGUE</p><h4>{product.name}</h4>
          <p className="product-original-description">{product.description || "No description in the reviewed catalogue."}</p></section>
          <section><p className="section-eyebrow">AI DRAFT / EDIT BEFORE SAVING</p>
            {analysis ? <><label>Suggested product title<input maxLength={300} value={rewrite.title} disabled={busy || data?.stale} onChange={(event) => { setRewrite((value) => ({ ...value, title: event.target.value })); setApproved(false); }} /></label>
              <label>Suggested description<textarea rows={8} maxLength={2000} value={rewrite.description} disabled={busy || data?.stale} onChange={(event) => { setRewrite((value) => ({ ...value, description: event.target.value })); setApproved(false); }} /></label>
              <Evidence evidence={analysis.evidence} references={analysis.result.rewrite.references} /></>
              : <p>Run a product analysis above to create a grounded draft. No claims or product details will be invented to fill gaps.</p>}
          </section></div>
        {analysis && <><label className="product-approval"><input type="checkbox" checked={approved} disabled={busy || data?.stale} onChange={(event) => setApproved(event.target.checked)} />I have checked the facts and approve this title and description for my local catalogue.</label>
          <Button disabled={busy || data?.stale || !approved || !rewrite.title.trim()} onClick={() => void saveListing()}>Save approved local listing</Button>
          <p className="field-note">This does not update your website or overwrite imported listings. No publishing integration is connected.</p></>}
      </CardContent></Card>}
      {area === "seo" && <Card><CardHeader><CardTitle>Discoverability starts with clear product information</CardTitle>
        <CardDescription>These are catalogue checks and suggested copy, not a ranking, indexing or technical SEO audit.</CardDescription></CardHeader><CardContent>
          <ul className="product-checklist"><li><Check /><span>Product name recorded</span></li>
            <li>{product.description.trim() ? <Check /> : <CircleHelp />}<span>{product.description.trim() ? "Description recorded" : "Description not recorded in the reviewed catalogue"}</span></li>
            <li>{duplicates.length || !normalizedDescription ? <CircleHelp /> : <Check />}<span>{duplicates.length ? `Same catalogue description also used by: ${duplicates.map((item) => item.name).join(", ")}` : normalizedDescription ? "No exact duplicate description among saved catalogue products" : "Description duplication cannot be checked without a description"}</span></li></ul>
          {analysis && <div className="product-seo-drafts"><h4>Suggested search snippet</h4>
            <label>SEO title draft<textarea rows={2} maxLength={70} value={rewrite.seoTitle} onChange={(event) => setRewrite((value) => ({ ...value, seoTitle: event.target.value }))} /></label>
            <label>Meta description draft<textarea rows={3} maxLength={170} value={rewrite.metaDescription} onChange={(event) => setRewrite((value) => ({ ...value, metaDescription: event.target.value }))} /></label>
            <p className="field-note">Draft text for manual review and copying. Not a measurement of existing page metadata, and not published by GrowthPulse.</p>
            <Evidence evidence={analysis.evidence} references={analysis.result.rewrite.references} /></div>}
          <details className="agent-sources"><summary>What still needs a live-page check</summary><p>Actual title tags, meta descriptions, image alt text, indexing, internal links and current structured-data validity have not been assessed. A saved product record or image URL cannot establish these.</p></details>
      </CardContent></Card>}
      {area === "opportunities" && <div className="product-recommendations">
        <p className="field-note">Product-specific proposals for owner validation, not proven customer demand or promised sales. Add selected ideas to Growth intelligence to prioritize and plan them.</p>
        {analysis ? [...analysis.result.recommendations.entries()].sort(([, a], [, b]) => ["first", "next", "later"].indexOf(a.priority) - ["first", "next", "later"].indexOf(b.priority)).map(([index, item]) =>
          <Card key={index}><CardHeader><Badge variant="outline">{item.priority === "first" ? "Start here" : item.priority === "next" ? "Consider next" : "Explore later"}</Badge>
            <CardTitle>{item.title}</CardTitle><CardDescription>{item.detail}</CardDescription></CardHeader><CardContent>
            <Evidence evidence={analysis.evidence} references={item.references} />
            <Button variant="outline" disabled={busy || data?.stale || planned.includes(index)} onClick={() => void plan(index)}>{planned.includes(index) ? "Added to growth plan" : "Add to growth plan"}<ArrowRight /></Button>
          </CardContent></Card>) : <p>No product-specific AI recommendations saved yet. Analyse this product to identify supported improvements.</p>}
        <a className="text-button" href="#growth">Open Growth intelligence<ArrowRight /></a>
      </div>}
      {area === "performance" && <Card><CardHeader><Badge variant="outline">Not connected</Badge><CardTitle>Measure results, not guesses</CardTitle>
        <CardDescription>No store transactions or product analytics are connected.</CardDescription></CardHeader><CardContent>
        <p>Revenue, units sold, page views, conversion, add-to-cart and returns need authorized commerce or analytics data. Public pages and catalogue completeness cannot establish product performance.</p>
        <p className="field-note">Shopify, WooCommerce and analytics connections are not available in this version. No product sales metrics are fabricated.</p>
      </CardContent></Card>}
    </BlurFade>
  </section>;
}
