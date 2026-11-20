import { useEffect, useRef, useState, type FormEvent } from "react";
import { businessesSchema, type Business } from "../shared/contracts";
import { emptyProduct, importResponseSchema, importResultSchema, productInputSchema, productResponseSchema, productsResponseSchema, scannedProductsResponseSchema, type ImportDecision, type ImportDraft, type Product, type ProductInput } from "../shared/products";
import { scansResponseSchema, type ScanSummary, type ScanResult } from "../shared/website";
import { understandingResponseSchema } from "../shared/understanding";
import { api, ApiFailure, errorMessage } from "./api";
import { Icon } from "./Icon";
import { ProductIntelligence } from "./ProductIntelligence";
import { productAnalysisSummariesSchema, productReadiness, type ProductAnalysisSummary } from "../shared/product-intelligence";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { BlurFade } from "./components/ui/blur-fade";
import { ProductVariants, readableAvailability, SourceReference } from "./SourceDetails";
import { GrowthActionWork } from "./GrowthActionWork";

function ProductThumbnail({ name, src }: { name: string; src?: string }) {
  const [failedSource, setFailedSource] = useState<string>();
  return <div className="product-thumbnail">
    {src && src !== failedSource
      ? <img src={src} alt={name} width={112} height={112} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedSource(src)} />
      : <div className="product-image-placeholder" role="img" aria-label={`Image unavailable for ${name}`}><Icon name="box" /><span>Image unavailable</span></div>}
  </div>;
}

export function ProductsWorkspace({ onSessionExpired, selectedBusinessId, onBusinessSelected, businessManaged = false }: {
  onSessionExpired: () => void; selectedBusinessId?: string; onBusinessSelected?: (id: string) => void;
  businessManaged?: boolean;
}) {
  const [context, setContext] = useState(() => new URLSearchParams(window.location.hash.split("?")[1] ?? ""));
  const [reviewMode, setReviewMode] = useState<"action" | "independent">("action");
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [analyses, setAnalyses] = useState<ProductAnalysisSummary[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "attention" | "analysed">("all");
  const [scans, setScans] = useState<ScanSummary[]>([]);
  const [scanId, setScanId] = useState("");
  const [form, setForm] = useState<ProductInput>(emptyProduct);
  const [editingId, setEditingId] = useState("");
  const [sourceName, setSourceName] = useState("CSV catalogue");
  const [csv, setCsv] = useState("");
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [catalogueResult, setCatalogueResult] = useState<ScanResult["catalogue"]>();
  const [revision, setRevision] = useState(0);
  const [reload, setReload] = useState(0);
  const requestedSelection = useRef({ id: selectedBusinessId, onSelected: onBusinessSelected });
  requestedSelection.current = { id: selectedBusinessId, onSelected: onBusinessSelected };
  const tools = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function followProductLink() {
      if (window.location.hash.split("?")[0] !== "#products") return;
      const next = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
      const requestedBusiness = next.get("business");
      if (requestedBusiness && !businesses.some((item) => item.id === requestedBusiness)) return;
      if (next.get("action") !== context.get("action") || next.get("business") !== context.get("business")) setReviewMode("action");
      setContext(next);
      if (requestedBusiness && requestedBusiness !== businessId) {
        setBusinessId(requestedBusiness); requestedSelection.current.onSelected?.(requestedBusiness);
      } else if (next.get("import") !== context.get("import")) setRevision((value) => value + 1);
      else setSelectedProductId(next.get("product") ?? "");
    }
    window.addEventListener("hashchange", followProductLink);
    return () => window.removeEventListener("hashchange", followProductLink);
  }, [businesses, businessId, context]);
  function report(error: unknown) {
    if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
    else setError(errorMessage(error));
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api("/api/businesses", businessesSchema, { signal: controller.signal }).then(({ businesses }) => {
      if (controller.signal.aborted) return;
      setBusinesses(businesses);
      const selected = businessManaged && requestedSelection.current.id !== undefined
        ? businesses.find((item) => item.id === requestedSelection.current.id)
        : businesses.find((item) => item.id === context.get("business"))
          ?? businesses.find((item) => item.id === requestedSelection.current.id) ?? businesses[0];
      setBusinessId(selected?.id ?? "");
      if (selected) requestedSelection.current.onSelected?.(selected.id);
    }).catch((error: unknown) => { if (!controller.signal.aborted) report(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [onSessionExpired, reload]);
  useEffect(() => {
    if (selectedBusinessId !== undefined && selectedBusinessId !== businessId) {
      setBusinessId(businesses.find((item) => item.id === selectedBusinessId)?.id ?? "");
    }
  }, [selectedBusinessId]);
  useEffect(() => {
    const controller = new AbortController();
    setProducts([]); setAnalyses([]); setScans([]); setDraft(null); setChoices({}); setScanId("");
    setSelectedProductId(businessId === context.get("business") ? context.get("product") ?? "" : "");
    setSearch(""); setFilter("all");
    if (tools.current) tools.current.open = false;
    setForm(emptyProduct); setEditingId(""); setError(""); setNotice(""); setCatalogueResult(undefined);
    if (!businessId) { setReading(false); return; }
    setReading(true);
    void Promise.all([
      api(`/api/businesses/${businessId}/products`, productsResponseSchema, { signal: controller.signal }),
      api(`/api/businesses/${businessId}/scans`, scansResponseSchema, { signal: controller.signal }),
    ]).then(async ([catalogue, history]) => {
      if (controller.signal.aborted) return;
      setProducts(catalogue.products); setScans(history.scans); setScanId(history.scans[0]?.id ?? "");
      const importId = businessId === context.get("business") ? context.get("import") : null;
      if (!importId) {
        const saved = await api(`/api/businesses/${businessId}/understanding`, understandingResponseSchema, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setCatalogueResult(saved.understanding?.catalogue ?? saved.lastSuccessfulUnderstanding?.catalogue);
        const pending = [saved.understanding, saved.lastSuccessfulUnderstanding]
          .find((item) => item?.productImportId || item?.catalogue?.skipped);
        if (pending) {
          const synced = await api(`/api/businesses/${businessId}/scans/${pending.scanId}/catalogue`, scannedProductsResponseSchema, {
            method: "POST", body: "{}", signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setProducts(synced.products);
          setCatalogueResult(synced.catalogue ?? undefined);
          const summary = synced.products.length ? "Your website catalogue is ready." : "No usable products could be added from this saved scan.";
          setNotice(synced.catalogue?.skipped
            ? `${summary} ${synced.catalogue.skipped} source records need attention; review saved website records below or add a missing product manually.`
            : synced.catalogue ? "Your website catalogue is ready. No import confirmation is needed."
              : "No supported product records were found in the saved scan. Add a missing product manually.");
        }
      }
      if (importId) {
        const { draft } = await api(`/api/businesses/${businessId}/product-imports/${encodeURIComponent(importId)}`, importResponseSchema, { signal: controller.signal });
        if (!controller.signal.aborted) {
          if (draft.committed) setNotice("This draft was already imported. Your saved catalogue is shown below.");
          else review(draft);
        }
      }
      const savedAnalyses = await api(`/api/businesses/${businessId}/product-intelligence`, productAnalysisSummariesSchema, { signal: controller.signal });
      if (!controller.signal.aborted) setAnalyses(savedAnalyses.analyses);
    }).catch((error: unknown) => { if (!controller.signal.aborted) report(error); })
      .finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [businessId, revision, onSessionExpired]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (error) { report(error); } finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = productInputSchema.safeParse(form);
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" ")); return; }
    await run(async () => {
      const { product } = await api(`/api/businesses/${businessId}/products${editingId ? `/${editingId}` : ""}`, productResponseSchema, { method: editingId ? "PUT" : "POST", body: JSON.stringify(parsed.data) });
      setProducts((current) => [...current.filter((item) => item.id !== product.id), product]);
      setAnalyses((current) => current.filter((item) => item.productId !== product.id));
      setEditingId(""); setForm(emptyProduct); setDraft(null);
      setNotice("Product saved locally. Imported listings were not changed.");
    });
  }
  function review(next: ImportDraft) {
    setDraft(next);
    setChoices(Object.fromEntries(next.rows.map((row) => {
      const match = next.matches.find((item) => item.row === row.row);
      return [row.row, !row.data || row.errors.length ? "skip" : match?.productId ? `id:${match.productId}` : match?.kind === "review" ? "review" : "new"];
    })));
  }
  async function preview(source: "csv" | "website") {
    setDraft(null);
    await run(async () => {
      const { draft } = await api(`/api/businesses/${businessId}/product-imports/${source}`, importResponseSchema, {
        method: "POST", body: JSON.stringify(source === "csv" ? { sourceName, csv } : { scanId }),
      });
      review(draft);
    });
  }
  async function refreshPreview() {
    if (!draft) return;
    await run(async () => {
      const { draft: refreshed } = await api(`/api/businesses/${businessId}/product-imports/${draft.id}/refresh`, importResponseSchema, { method: "POST", body: JSON.stringify({}) });
      const next = new URLSearchParams({ business: businessId, import: refreshed.id });
      window.history.replaceState(null, "", `#products?${next}`);
      setContext(next);
      review(refreshed);
      setNotice("Preview refreshed from saved evidence. Image URLs and validation are updated; import decisions have been reset. No new scan or AI call was made.");
    });
  }
  async function commit() {
    if (!draft) return;
    const decisions: ImportDecision[] = [];
    for (const row of draft.rows) {
      const choice = choices[row.row];
      if (choice === "review" || !choice) { setError(`${row.data?.name || "This source record"}: explicitly choose a catalogue product, create a separate product, or skip.`); return; }
      decisions.push(choice.startsWith("id:") ? { row: row.row, action: "link", productId: choice.slice(3) } : choice === "new" ? { row: row.row, action: "new" } : { row: row.row, action: "skip" });
    }
    await run(async () => {
      const { result } = await api(`/api/businesses/${businessId}/product-imports/${draft.id}/commit`, importResultSchema, { method: "POST", body: JSON.stringify({ decisions }) });
      setDraft(null);
      setNotice(`Import saved: ${result.imported} listings, ${result.created} new products, ${result.updated} refreshed listings, ${result.skipped} skipped rows.`);
      const [catalogue, summaries] = await Promise.all([
        api(`/api/businesses/${businessId}/products`, productsResponseSchema),
        api(`/api/businesses/${businessId}/product-intelligence`, productAnalysisSummariesSchema),
      ]);
      setProducts(catalogue.products); setAnalyses(summaries.analyses);
    });
  }
  const disabled = busy || reading;
  const reviewRows = draft?.rows.filter((row) => row.data && !row.errors.length) ?? [];
  const skippedRows = draft?.rows.filter((row) => !row.data || row.errors.length) ?? [];
  const selectedProduct = products.find((product) => product.id === selectedProductId);
  const actionId = context.get("business") === businessId ? context.get("action") : null;
  const actionReview = !!actionId && reviewMode === "action";
  const needsAttention = (product: Product) => productReadiness(product).some((check) => !check.present);
  const nextReview = products.find(needsAttention);
  const visibleProducts = products.filter((product) => (filter === "all" || filter === "attention" && needsAttention(product)
    || filter === "analysed" && analyses.some((item) => item.productId === product.id))
    && [product.name, product.sku, product.gtin, product.description].some((value) => value.toLowerCase().includes(search.trim().toLowerCase())));
  function productImage(product: Product) {
    return [...product.listings].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).find((listing) => listing.data.imageUrl)?.data.imageUrl;
  }
  function openProduct(id: string) {
    setSelectedProductId(id);
    const next = new URLSearchParams(context);
    next.set("business", businessId); next.set("product", id); next.delete("import");
    window.history.replaceState(null, "", `#products?${next}`);
    setContext(next);
  }
  function closeProduct() {
    setSelectedProductId("");
    const next = new URLSearchParams(context); next.delete("product"); next.set("business", businessId);
    window.history.replaceState(null, "", `#products?${next}`); setContext(next);
  }
  if (loading) return <p className="loading-message">Loading your product workspace...</p>;
  return <section className="products-workspace">
    {error && <p role="alert" className="form-error">{error} <button type="button" className="text-button" disabled={busy} onClick={() => businesses.length ? setRevision((value) => value + 1) : setReload((value) => value + 1)}>Reload catalogue</button></p>}
    {notice && <p role="status" className="catalogue-notice">{notice}</p>}
    {!businessManaged && <div className="business-toolbar"><label>Business<select value={businessId} disabled={disabled} onChange={(event) => {
      const id = event.target.value, next = new URLSearchParams({ business: id });
      window.history.replaceState(null, "", `#products?${next}`); setContext(next);
      setBusinessId(id); onBusinessSelected?.(id); setCsv("");
    }}><option value="" disabled>Choose a business</option>{businesses.map((business) => <option key={business.id} value={business.id}>{business.name}</option>)}</select></label></div>}
    {!businessId ? <p>Create a <a href="#overview?view=setup&new=1" className="text-button">business profile</a> before adding products.</p> : <>
      {reading && <p className="loading-message">Loading catalogue and saved scans...</p>}
      {actionId && <div className="journey-actions" role="group" aria-label="Product review mode">
        <Button variant={actionReview ? "default" : "outline"} aria-pressed={actionReview} onClick={() => setReviewMode("action")}>Work on this growth action</Button>
        <Button variant={!actionReview ? "default" : "outline"} aria-pressed={!actionReview} onClick={() => setReviewMode("independent")}>Review products independently</Button>
      </div>}
      {actionReview && <GrowthActionWork key={`${businessId}:${actionId}`} businessId={businessId} actionId={actionId!} onSessionExpired={onSessionExpired} />}
      {!selectedProduct && <BlurFade className="product-catalogue-intro"><p className="section-eyebrow">PRODUCT INTELLIGENCE</p>
        <h2>Make every listing clearer.</h2><p>Products found in saved website scans appear here automatically, with their own product workspace. Add anything the scan missed manually.</p>
        <dl className="product-catalogue-metrics" aria-label="Saved product overview" aria-busy={reading}>
          <div><dt>Saved products</dt><dd>{reading ? "..." : products.length}</dd></div>
          <div><dt>Current analyses</dt><dd>{reading ? "..." : new Set(analyses.map((item) => item.productId)).size}</dd></div>
          <div><dt>Information to review</dt><dd>{reading ? "..." : products.filter(needsAttention).length}</dd></div>
        </dl>
        {!!products.length && <p className="field-note">These are saved catalogue entries, which may include pack sizes or variants—not necessarily distinct product families. Keep each SKU and source listing separate until you confirm their relationship.</p>}
        {nextReview && <Button variant="outline" onClick={() => openProduct(nextReview.id)}>
          Review {nextReview.name}&apos;s recorded information<Icon name="arrow" />
        </Button>}
      </BlurFade>}
      {!selectedProduct && <Button variant="outline" disabled={disabled} onClick={() => {
        setEditingId(""); setForm(emptyProduct); setDraft(null);
        if (tools.current) tools.current.open = true;
        tools.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
      }}>Add a product manually<Icon name="plus" /></Button>}
      {!!catalogueResult?.issues.length && <details className="agent-sources"><summary>Website products needing attention ({catalogueResult.skipped})</summary>
        <ul>{catalogueResult.issues.map((issue, index) => <li key={index}><strong>{issue.name}</strong>: {issue.message}</li>)}</ul>
      </details>}
      {!selectedProduct && <details className="agent-sources product-tools" ref={tools}><summary>Manual entry and optional bulk tools</summary><div className="business-columns">
        <form className="workspace-form profile-card" onSubmit={(event) => void save(event)}>
          <div className="card-heading"><p className="section-eyebrow">YOUR CATALOGUE</p><h2>{editingId ? "Edit product" : "Add a product"}</h2><p>Manage your own product details. Imported listings stay separate.</p></div>
          <fieldset disabled={disabled}><legend className="sr-only">Manual product</legend>
            {(["name", "sku", "gtin", "price", "currency", "availability", "variants"] as const).map((field) => <label key={field}>{({ name: "Product name", sku: "SKU (optional)", gtin: "GTIN (optional)", price: "Manual price (optional)", currency: "Currency", availability: "Availability", variants: "Variants (optional)" })[field]}<input name={field} required={field === "name"} maxLength={field === "variants" ? 1000 : field === "name" ? 300 : field === "availability" ? 200 : 100} value={form[field]} placeholder={field === "price" ? "1299.00" : field === "currency" ? "INR" : field === "variants" ? "size: M | color: blue" : undefined} onChange={(event) => setForm((value) => ({ ...value, [field]: event.target.value }))} /></label>)}
            <label>Description<textarea name="description" rows={3} maxLength={2000} value={form.description} onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))} /></label>
            <p className="field-note">Leave unknown prices blank; zero is a real price. Currency is required with a price. GTIN includes its check digit. Availability is source text, for example in_stock or unknown.</p>
            <div className="profile-actions"><button className="primary-link" type="submit">{busy ? "Working..." : editingId ? "Save product" : "Add product"}</button>{editingId && <button className="secondary-button" type="button" onClick={() => { setEditingId(""); setForm(emptyProduct); }}>Cancel edit</button>}</div>
          </fieldset>
        </form>
        <aside className="profile-card workspace-form"><div className="card-heading"><h2>Optional CSV upload</h2><p>Add many products from a spreadsheet. Website products are added automatically when you save a scan; CSV uploads still use a review step.</p></div>
          <fieldset disabled={disabled}><legend className="sr-only">CSV and website imports</legend>
            <label>CSV source name<input name="sourceName" value={sourceName} maxLength={80} onChange={(event) => { setSourceName(event.target.value); setDraft(null); }} /></label>
            <p className="field-note">Keep the same source name and listing_id (or SKU/GTIN) to refresh an existing listing. Each variant should have its own stable listing ID.</p>
            <label>CSV file (UTF-8, max 48 KiB)<input type="file" accept=".csv,text/csv" onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void run(async () => {
                if (file.size > 49_152) throw new Error("CSV must be at most 48 KiB.");
                let text: string;
                try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
                catch (error) { if (!(error instanceof TypeError)) throw error; throw new Error("CSV must be valid UTF-8."); }
                setCsv(text); setDraft(null);
              });
            }} /></label>
            <label>CSV content<textarea name="csv" rows={7} maxLength={49_152} value={csv} placeholder={'listing_id,name,sku,price,currency,availability,variants\ntee-blue,Blue tee,TEE-BLUE,499.00,INR,in_stock,size: M'} onChange={(event) => { setCsv(event.target.value); setDraft(null); }} /></label>
            <details className="agent-sources"><summary>CSV format</summary><p className="field-note">Headers: listing_id, name, description, sku, gtin, price, currency, availability, variants. Up to 100 data rows. Quoted commas and newlines are supported.</p></details>
            <button type="button" className="primary-link" disabled={!csv.trim() || !sourceName.trim()} onClick={() => void preview("csv")}>Preview CSV</button>
            <hr />
            <label>Saved website scan<select name="productScan" value={scanId} onChange={(event) => { setScanId(event.target.value); setDraft(null); }}><option value="">Choose a saved scan</option>{scans.map((scan) => <option key={scan.id} value={scan.id}>{new Date(scan.completedAt).toLocaleString()} · {scan.pageCount} pages · {scan.requestedUrl}</option>)}</select></label>
            <button className="primary-link" type="button" disabled={!scanId} onClick={() => void preview("website")}>Preview website products</button><a href="#website" className="text-button">Open website scanner</a>
          </fieldset>
        </aside>
      </div></details>}
      {draft && !selectedProduct && <section className="profile-card import-review" aria-labelledby="import-review-heading"><div className="card-heading"><h2 id="import-review-heading">{draft.source === "website" ? "Products found on your website" : "Review import"}</h2><p>{draft.source} · {draft.sourceName} · {draft.rows.length} source records. Nothing is imported until you confirm.</p>
        {draft.source === "website" && <p>These are saved discoveries from captured product data, not a complete website inventory. Review the products below before adding them to your catalogue.</p>}</div>
        {draft.source === "website" && <div className="import-refresh"><button type="button" className="secondary-button" disabled={disabled} onClick={() => void refreshPreview()}>Refresh from saved scan</button><p className="field-note">Refresh without a new scan or AI charge. Your import choices will reset.</p></div>}
        <dl className="import-summary" aria-label="Import readiness">
          <div><dt>Ready for review</dt><dd>{reviewRows.length}</dd></div>
          <div><dt>Skipped records</dt><dd>{skippedRows.length}</dd></div>
        </dl>
        {!!skippedRows.length && <p className="field-note">{reviewRows.length ? "You can still import the usable records. " : "No importable records in this draft. "}
          Some source records have missing or invalid fields and will be skipped. {draft.source === "website" && "These are source-record counts, not counts of missing products; a page can publish multiple records for one product. "}Expand their details below to see why.</p>}
        <div className="import-rows">{reviewRows.map((row) => {
          const match = draft.matches.find((item) => item.row === row.row)!;
          return <article className="import-row" key={row.row}>
            <div className="product-identity"><ProductThumbnail name={row.data?.name || "Product"} src={row.data?.imageUrl} /><h3>{row.data?.name}</h3></div>
            {row.data && <p>{row.data.price ? `${row.data.price} ${row.data.currency}` : row.data.offers.length > 1 ? `${row.data.offers.length} separate offers` : "Price not provided"}</p>}
            <details className="agent-sources import-source-details"><summary>Product source details</summary>
              <p className="field-note"><SourceReference source={draft.source} reference={row.reference} /> · {new Date(row.capturedAt).toLocaleString()}</p>
              {row.data && <p className="field-note">{row.data.sku && `SKU ${row.data.sku} · `}{row.data.gtin && `GTIN ${row.data.gtin} · `}{readableAvailability(row.data.availability)}</p>}
              {row.data?.variants && <ProductVariants value={row.data.variants} />}
              {!!row.data?.offers.length && <ul>{row.data.offers.map((offer, index) => <li key={index}>{offer.price || "Price unknown"} {offer.currency} · {readableAvailability(offer.availability) || "Not recorded"}</li>)}</ul>}
              {row.notes.map((note) => <p className="field-note" key={note}>{note}</p>)}
            </details>
            <label>Import action for {row.data?.name}<select disabled={disabled} value={choices[row.row] ?? "review"} onChange={(event) => setChoices((value) => ({ ...value, [row.row]: event.target.value }))}>
              <option value="review" disabled>Choose explicitly: uncertain match</option><option value="skip">Skip this row</option>
              {match.kind !== "repeat" && <option value="new">Create a separate catalogue product</option>}
              {products.filter((product) => match.kind !== "repeat" || product.id === match.productId).map((product) => <option key={product.id} value={`id:${product.id}`}>Link to {product.name} {product.sku && `(${product.sku})`}</option>)}
            </select></label>
            <p className="field-note">{match.kind === "repeat" ? "Existing source listing: refresh this listing, preserving the catalogue product." : match.kind === "identifier" ? "Exact identifier match suggested. Review before confirming." : match.kind === "review" ? "Similar names or conflicting identifiers need your decision." : "No existing identifier match. A new product is proposed."}</p>
          </article>;
        })}</div>
        {!!skippedRows.length && <details className="import-skipped"><summary>Skipped records ({skippedRows.length}) — view reasons</summary>
          <p className="field-note">{draft.source === "website"
            ? "These source records failed validation, but that does not necessarily mean their products are missing. Check the usable records above first. If a product has no usable record, correct the website's published Product JSON-LD and scan again, or use manual entry or CSV. Valid fields are kept below."
            : "Fix these rows in your CSV and preview again to include them."} No product names, identifiers or prices are guessed.</p>
          {skippedRows.map((row) => {
            const fields = row.data ?? row.preview;
            const pageRecords = draft.source === "website"
              ? reviewRows.filter((ready) => ready.reference === row.reference && ready.capturedAt === row.capturedAt)
              : [];
            return <article className="import-row" key={row.row}>
            <div className="product-identity"><ProductThumbnail name={fields?.name || "Source record"} src={fields?.imageUrl} /><div><h3>{fields?.name || (row.errors.some((message) => message.startsWith("name:")) ? "Product name missing" : "Source record needs attention")}</h3><p className="field-note">Needs attention · will be skipped</p></div></div>
            <p className="field-note"><SourceReference source={draft.source} reference={row.reference} /> · {new Date(row.capturedAt).toLocaleString()}</p>
            {!!pageRecords.length && <p className="field-note import-page-context">Usable records from this same captured page: {pageRecords.map((ready) => ready.data!.name).join("; ")}. Review those above before adding a product manually. This incomplete entry has not been merged or assigned another record's identifier.</p>}
            {fields && <p className="field-note">Validated fields: {fields.sku && `SKU ${fields.sku} · `}{fields.gtin && `GTIN ${fields.gtin} · `}{fields.price && `${fields.price} ${fields.currency || "(currency missing)"} · `}{fields.availability && fields.availability !== "unknown" && `${readableAvailability(fields.availability)} · `}{fields.description || "No description supplied."}</p>}
            <p className="field-note"><strong>Fields requiring attention</strong></p>
            <ul className="field-note">{[...new Set(row.errors)].map((message) => <li key={message}>{message}</li>)}</ul>
            {row.notes.map((note) => <p className="field-note" key={note}>{note}</p>)}
            <p className="field-note">Skipped — this record will not be imported.</p>
          </article>; })}
        </details>}
        <div className="profile-actions"><button className="primary-link" disabled={disabled || !reviewRows.length} onClick={() => void commit()}>Confirm import</button><button className="secondary-button" disabled={disabled} onClick={() => setDraft(null)}>Cancel import</button></div>
      </section>}
      {selectedProduct && actionReview ? <section className="profile-card"><h3>{selectedProduct.name}</h3><p>{selectedProduct.description || "No saved description."}</p>
        <Button variant="outline" onClick={() => setReviewMode("independent")}>Review this product independently</Button>
        <Button variant="ghost" onClick={closeProduct}>Back to catalogue</Button></section>
      : selectedProduct ? <ProductIntelligence key={`${businessId}:${selectedProduct.id}`} businessId={businessId} product={selectedProduct} products={products}
        thumbnail={<ProductThumbnail name={selectedProduct.name} src={productImage(selectedProduct)} />}
        onBack={closeProduct}
        onProductSaved={(product) => { setProducts((current) => current.map((item) => item.id === product.id ? product : item)); setAnalyses((current) => current.filter((item) => item.productId !== product.id)); }}
        onAnalysed={(analysis) => setAnalyses((current) => current.some((item) => item.productId === analysis.productId && item.fingerprint === analysis.fingerprint) ? current
          : [...current.filter((item) => item.productId !== analysis.productId), { productId: analysis.productId, fingerprint: analysis.fingerprint, createdAt: analysis.createdAt }])}
        onSessionExpired={onSessionExpired} />
      : <section className="catalogue-list" aria-labelledby="catalogue-heading"><h2 id="catalogue-heading">Your catalogue ({products.length}/200)</h2>
        {!!products.length && <div className="product-catalogue-controls"><label>Search products<input name="productSearch" type="search" value={search} placeholder="Name, SKU or description" onChange={(event) => setSearch(event.target.value)} /></label>
          <div className="product-catalogue-filters" role="group" aria-label="Filter products">{([
            ["all", "All products"], ["attention", "Needs review"], ["analysed", "Analysed"],
          ] as const).map(([key, label]) => <Button key={key} variant={filter === key ? "secondary" : "outline"} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</Button>)}</div></div>}
        {!reading && !error && !products.length && <p className="field-note">{draft?.source === "website"
        ? "Website discoveries are awaiting review above. Confirm an import to add them to your catalogue."
        : "No saved catalogue products yet. Scan your website to add supported products automatically, or choose Add a product manually."}</p>}
        {!!products.length && !visibleProducts.length && <p className="field-note">No products match this search and filter.</p>}
        <div className="product-catalogue-grid">{visibleProducts.map((product) => {
          const imageUrl = productImage(product);
          const priced = [...product.listings].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
            .find((listing) => listing.data.price);
          const hasOffers = product.listings.some((listing) => listing.data.offers.length);
          const recorded = productReadiness(product).filter((check) => check.present).length;
          return <article className="profile-card catalogue-product" key={product.id}>
          <div className="catalogue-product-heading"><div className="product-identity"><ProductThumbnail name={product.name} src={imageUrl} /><div><h3>{product.name}</h3>{(product.sku || product.gtin) && <p className="field-note">{[product.sku && `SKU ${product.sku}`, product.gtin && `GTIN ${product.gtin}`].filter(Boolean).join(" · ")}</p>}</div></div><button className="secondary-button" disabled={disabled} onClick={() => {
            const manual = product.listings.find((listing) => listing.source === "manual");
            setEditingId(product.id); setForm({ ...(manual?.data ?? emptyProduct), name: product.name, description: product.description, sku: product.sku, gtin: product.gtin });
            setDraft(null);
            if (tools.current) tools.current.open = true;
            document.querySelector<HTMLInputElement>('.products-workspace input[name="name"]')?.focus();
          }}>Edit product</button></div>
          <div className="product-card-summary"><Badge variant="outline">{analyses.some((item) => item.productId === product.id) ? "Analysis saved" : "Not analysed"}</Badge>
            <p>{priced ? `${priced.data.price} ${priced.data.currency} · ${priced.sourceName}` : hasOffers ? "Separate source offers recorded" : "Price not recorded"}</p>
            <p className="field-note">{recorded}/6 information fields recorded · {needsAttention(product) ? "Review information" : "Fields recorded"}</p>
            <Button variant="outline" disabled={disabled} onClick={() => openProduct(product.id)}>Open product workspace<Icon name="arrow" /></Button></div>
          <details className="catalogue-source-archive"><summary>Saved listing details ({product.listings.length})</summary>
          {product.description && <p className="catalogue-description">{product.description}</p>}
          <div className="catalogue-listings">{product.listings.map((listing) => <details key={listing.id}><summary>{listing.sourceName} · {listing.data.price ? `${listing.data.price} ${listing.data.currency}` : "Price not provided"}</summary>
            <p className="field-note"><SourceReference source={listing.source} reference={listing.reference} /><br />Observed {new Date(listing.capturedAt).toLocaleString()}</p>
            <p>{listing.data.name}</p><p className="field-note">SKU {listing.data.sku || "unknown"} · GTIN {listing.data.gtin || "unknown"}</p>
            <p>{listing.data.price ? `${listing.data.price} ${listing.data.currency}` : "Price unknown"} · {readableAvailability(listing.data.availability) || "Not recorded"}</p>
            {listing.data.variants && <ProductVariants value={listing.data.variants} />}
            {listing.data.description && <p className="field-note">{listing.data.description}</p>}
            {listing.data.offers.length > 1 && <ul>{listing.data.offers.map((offer, index) => <li key={index}>{offer.price || "Price unknown"} {offer.currency} · {readableAvailability(offer.availability) || "Not recorded"}</li>)}</ul>}
          </details>)}</div></details>
        </article>; })}</div>
      </section>}
    </>}
  </section>;
}
