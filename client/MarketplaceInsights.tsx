import { useEffect, useRef, useState } from "react";
import {
  marketplaceRelationLabels, marketplaceRelations, type MarketplaceListing, type MarketplaceResponse,
} from "../shared/marketplace";
import { errorMessage } from "./api";
import { SupportingEvidence } from "./BusinessBriefing";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { useMarketplaceResearch } from "./MarketplaceResearchContext";
import { WorkflowActivity } from "./WorkflowActivity";
import "./marketplace.css";

export function MarketplaceInsights({ businessId }: { businessId: string }) {
  const research = useMarketplaceResearch();
  if (!research) throw new Error("Marketplace Insights requires its research provider");
  const { products, product, productsLoading: loading, productsError: error, reloadProducts, selectProduct } = research;
  return <section className="profile-card marketplace-insights" aria-label="Marketplace insights">
    <p className="section-eyebrow">MARKETPLACE INSIGHTS</p>
    <h2>Your product in the marketplace.</h2>
    {loading && <p role="status">Loading your saved products...</p>}
    {error && <p role="alert" className="form-error">{error} <Button variant="outline" onClick={reloadProducts}>Reload products</Button></p>}
    {!loading && !error && !products.length && <p>Add a reviewed product first. <a href={`#products?business=${businessId}`}>Open your catalogue</a>. A website is not required.</p>}
    {!!products.length && <label>Product to research<select value={product?.id ?? ""} onChange={(event) => selectProduct(event.target.value)}>
      {products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>}
    {product && <MarketplaceProduct key={`${businessId}:${product.id}`} />}
  </section>;
}

function FeedbackProgress({ data, customerVoice }: { data: MarketplaceResponse; customerVoice: boolean }) {
  const saved = data.report;
  const stage = data.progress?.stage;
  const captured = saved?.listings.filter((item) => item.status === "captured") ?? [];
  const hasReviews = captured.some((item) => item.reviews.length);
  const unconfirmed = captured.some((item) => item.relation === "unconfirmed");
  const active = data.running ? stage === "analysing" ? 3 : stage === "collecting" ? 1 : 0
    : data.error ? -1 : !saved || data.stale || !saved.listings.length ? 0 : saved.analysedAt ? 4 : !hasReviews ? 1 : unconfirmed ? 2 : 3;
  const message = data.running
    ? stage === "collecting" ? `Collecting review evidence: ${data.progress!.completed} of ${data.progress!.total} listings checked.`
      : stage === "analysing" ? "Analysing confirmed review excerpts."
      : stage === "discovering" ? "Finding product listings on Amazon India and Flipkart."
      : `${customerVoice ? "Customer feedback" : "Marketplace"} research is running. Reconnecting to saved progress.`
    : data.error ? "The last attempt did not finish. Previous saved evidence remains available."
    : data.stale ? "Product details changed. Find fresh feedback before using previous matches."
    : !saved ? "Ready to look for customer feedback for this product."
    : saved.analysedAt ? "Review analysis saved. Read the supporting excerpts below."
    : !captured.length ? "No usable listing evidence was collected. Check the source failures below."
    : !hasReviews ? "Listings were captured, but individual review text is still missing."
    : unconfirmed ? "Check the captured product, variant and seller before using its reviews."
    : "Sources checked. Review the evidence gaps or analyse a sufficient confirmed sample.";
  if (data.running) return <WorkflowActivity title={customerVoice ? "Customer feedback research" : "Marketplace research"} message={message}
    startedAt={data.progress?.startedAt} updatedAt={data.progress?.updatedAt}
    counts={stage === "collecting" ? [{ label: "Listings checked", value: `${data.progress!.completed} of ${data.progress!.total}` }]
      : stage === "analysing" ? [{ label: "Confirmed review excerpts", value: captured.filter((item) =>
        !["unconfirmed", "excluded"].includes(item.relation)).reduce((count, item) => count + item.reviews.length, 0) }] : []}
    guidance="You can leave and return; no new work starts when you reopen it. Previously saved sources remain available below. Blocked pages stay unknown; marketing copy is never a substitute for review text.">
    <div className="feedback-progress"><ol>{["Find listings", "Collect reviews", "Confirm matches", "Analyse feedback"].map((label, index) =>
      <li key={label} data-state={index === active ? "current" : index < active ? "done" : "pending"}
        aria-current={index === active ? "step" : undefined}>{label}{index === active ? " - In progress" : index === 2 && active < 3 ? " - Owner review required" : ""}</li>)}</ol></div>
  </WorkflowActivity>;
  return <section className="feedback-progress" aria-label="Customer feedback progress">
    <ol>{["Find listings", "Collect reviews", "Confirm matches", "Analyse feedback"].map((label, index) =>
      <li key={label} data-state={index < active ? "done" : index === active ? "current" : "pending"}
        aria-current={index === active ? "step" : undefined}>{label}</li>)}</ol>
    <p role="status">{message}</p>
  </section>;
}

export function MarketplaceProduct({ customerVoice = false }: { customerVoice?: boolean }) {
  const research = useMarketplaceResearch();
  if (!research) throw new Error("Marketplace product requires its research provider");
  const { data, loading, busy, error, reloadStatus, mutate: submit } = research;
  const [fileError, setFileError] = useState("");
  const [urls, setUrls] = useState("");
  const [csv, setCsv] = useState("");
  const requestKey = useRef(crypto.randomUUID());
  const fileVersion = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  async function mutate(path: string, body: object, method: "POST" | "PATCH" = "POST") {
    setFileError("");
    if (await submit(path, body, method) && mounted.current) {
      requestKey.current = crypto.randomUUID();
    }
  }
  const saved = data?.report;
  const locked = loading || busy || !!data?.running;
  const confirmed = saved?.listings.filter((item) => item.status === "captured" && !["unconfirmed", "excluded"].includes(item.relation)) ?? [];
  const reviewCount = confirmed.reduce((sum, item) => sum + item.reviews.length, 0);
  const captured = saved?.listings.filter((item) => item.status === "captured") ?? [];
  const capturedReviewCount = captured.reduce((sum, item) => sum + item.reviews.length, 0);
  function match(item: MarketplaceListing, relation: MarketplaceListing["relation"]) {
    if (saved) void mutate("/match", { reportId: saved.id, listingId: item.id, relation }, "PATCH");
  }
  return <div className="marketplace-product">
    {loading && <p role="status">{customerVoice ? "Loading saved customer feedback..." : "Loading saved marketplace research..."}</p>}
    {data && (customerVoice || data.running) && <FeedbackProgress data={data} customerVoice={customerVoice} />}
    {busy && !data?.running && <p role="status">Submitting your request. Waiting for the server to confirm saved status; no extra AI call is started by checking status.</p>}
    {(fileError || error || data?.error) && <p role="alert" className="form-error">{fileError || error || data?.error} <Button variant="outline" disabled={busy} onClick={() => { setFileError(""); reloadStatus(); }}>Reload saved status</Button></p>}
    {data?.error && !data.running && <p className="field-note">The last research attempt failed. Use an explicit research or review-analysis action to try again. Reload saved status only refreshes this saved message.</p>}
    {data?.stale && <p className="dashboard-notice">Your catalogue product changed. These are previous marketplace results; research again before confirming matches or analysing reviews.</p>}
    <div className="marketplace-research-controls">
      {customerVoice && <p className="field-note">Finding feedback sends product details to Anthropic and Tavily; analysing confirmed reviews sends excerpts to Anthropic. Provider charges may apply. Nothing is published. Opening this page starts no paid work.</p>}
      <Button disabled={locked || !data || !urls.trim() && (!data.configured || !data.discoveryConfigured)} onClick={() => void mutate("", {
        consent: true, requestKey: requestKey.current, urls: urls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), refresh: !!saved,
      })}>{data?.running ? "Researching..." : customerVoice ? saved || data?.error ? "Find fresh customer feedback" : "Find customer feedback" : data?.error ? "Retry marketplace research" : saved ? "Research again" : "Research marketplaces"}</Button>
      {data && (!data.configured || !data.discoveryConfigured) && <p className="field-note">Automatic discovery is not configured on this server. You can still supply listing URLs or import an authorized CSV. AI review analysis requires the server's AI connection.</p>}
      <details className="agent-sources"><summary>Research options and details</summary>
        <p>Research your own product and comparable Amazon India / Flipkart listings. Confirm matches before analysing customer feedback.</p>
        <p className="field-note">Starting research sends product details to Anthropic and Tavily. Provider charges may apply. Nothing will be published.</p>
        <p className="field-note">Reopening saved results starts no paid research. No catalogue edits, publishing, order estimates or automatic monitoring.</p>
        <h3>Add listing links or import reviews</h3>
        <p>Optional fallbacks when discovery finds the wrong item or a public page cannot be read. Supplying a URL does not bypass marketplace access restrictions.</p>
        <label>Product listing URLs (up to six, one per line)<textarea rows={3} value={urls} maxLength={12_294} disabled={locked} onChange={(event) => { setUrls(event.target.value); requestKey.current = crypto.randomUUID(); }} /></label>
        <label>Authorized review CSV<input type="file" accept=".csv,text/csv" disabled={locked} onChange={(event) => {
          const version = ++fileVersion.current;
          const file = event.target.files?.[0]; setCsv(""); setFileError("");
          if (!file) return;
          if (file.size > 49_152) { setFileError("Use a CSV of at most 48 KiB, 50 rows and six listings."); return; }
          void file.text().then((text) => { if (mounted.current && version === fileVersion.current) setCsv(text); })
            .catch((error: unknown) => { if (mounted.current && version === fileVersion.current) setFileError(errorMessage(error)); });
        }} /></label>
        <p className="field-note">Headers: product_url,title,review. Optional: description,rating,review_date,price,currency,gtin,variants,seller. Dates: YYYY-MM-DD; ratings: 0-5. Repeat consistent listing fields for each review. Exclude customer names and contact details.</p>
        <p className="field-note">By choosing Import authorized data, you confirm you have permission to supply and process the uploaded reviews.</p>
        <Button variant="outline" disabled={locked || !csv} onClick={() => void mutate("/import", { consent: true, csv })}>Import authorized data</Button>
        <p className="field-note">An import replaces this product's marketplace research only. It never changes your catalogue, website or sales actuals.</p>
      </details>
    </div>
    {saved && <div className="marketplace-results">
      <p className="field-note">Saved <time dateTime={saved.createdAt}>{new Date(saved.createdAt).toLocaleString()}</time>. {saved.listings.filter((item) => item.status === "captured").length} captured listings; {reviewCount} distinct review excerpts in confirmed listings. Review counts are not orders.</p>
      {customerVoice && <>
        {!!saved.listings.length && !captured.length && <p className="dashboard-notice">No listing supplied usable product evidence. Read each source failure below; add a different listing link or import an authorized review export. Repeating the same blocked request may not help.</p>}
        {!!captured.length && !capturedReviewCount && <p className="dashboard-notice">Product listings were captured, but no individual review text was available. Ratings and brand descriptions cannot supply customer insights. Try another listing or an authorized review export.</p>}
        {capturedReviewCount > reviewCount && <p>Review excerpts are waiting for listing confirmation. Confirm the relevant product matches below; unmatched feedback is not used in insights.</p>}
      </>}
      {!saved.listings.length && <p>No matching marketplace listing was verified. This does not mean your product is absent from Amazon or Flipkart. Add a direct listing link in Research options and details, or import an authorized review export.</p>}
      <details className="marketplace-source-review" open={!customerVoice || !saved.analysedAt}>
      <summary>Review sources and confirm matches ({saved.listings.length})</summary>
      <div className="marketplace-listings">{saved.listings.map((item) => <article className="marketplace-listing" key={item.id}>
        <div><Badge variant="outline">{item.marketplace}</Badge> <Badge variant="outline">{item.method === "owner_export" ? "Owner-supplied export" : item.status === "captured" ? "Captured public page" : "Evidence unavailable"}</Badge></div>
        <h3>{item.title || "Marketplace listing"}</h3>
        <a href={item.url} target="_blank" rel="noreferrer">Open listing</a>
        {customerVoice && <p className="field-note">{item.reviews.length} sampled review excerpts / Captured <time dateTime={item.capturedAt}>{new Date(item.capturedAt).toLocaleString()}</time></p>}
        {item.status === "captured" && <>
          {item.description && <p className="dashboard-clamped">{customerVoice && <strong>Published listing description, not customer feedback: </strong>}{item.description}</p>}
          <dl><div><dt>Recorded offer</dt><dd>{item.price ? `${item.price} ${item.currency}` : "Not captured"}</dd></div>
            <div><dt>Published rating</dt><dd>{item.rating === null ? "Not captured" : `${item.rating} / 5`}</dd></div>
            <div><dt>Published review count</dt><dd>{item.reviewCount ?? "Not captured"}</dd></div>
            <div><dt>Variant / pack</dt><dd>{item.variants || "Confirm on listing"}</dd></div>
            <div><dt>Seller</dt><dd>{item.seller || "Not captured; confirm on listing"}</dd></div></dl>
          {item.identifierMatch && <p className="field-note">The recorded GTIN matches your catalogue. Confirm the variant, pack size and seller; ownership is not established by this match.</p>}
          <fieldset disabled={locked || data?.stale}><legend>How does this listing relate to your product?</legend>
            <div className="marketplace-match-actions">{marketplaceRelations.filter((relation) => relation !== "unconfirmed").map((relation) =>
              <Button key={relation} variant={item.relation === relation ? "default" : "outline"} aria-pressed={item.relation === relation}
                onClick={() => match(item, relation)}>{marketplaceRelationLabels[relation]}</Button>)}</div>
            <p className="field-note">{marketplaceRelationLabels[item.relation]}. Confirm identity and who sells it—not just a similar name.</p>
          </fieldset>
          <SupportingEvidence sources={item.sources} />
          {!customerVoice && !!item.reviews.length && <details className="agent-sources"><summary>Captured review excerpts ({item.reviews.length})</summary>
            {item.reviews.map((value) => <blockquote key={value.id}><p>{value.text}</p><p className="field-note">{value.rating === null ? "Rating not supplied" : `${value.rating} / 5`}{value.date ? ` / ${value.date}` : " / Review date unknown"}</p></blockquote>)}
          </details>}
        </>}
        <p className="field-note">{item.limitation}</p>
      </article>)}</div>
      </details>
      <section aria-label="Customer feedback themes">
        <h3>Review analysis</h3>
        <p>Only confirmed listings and distinct captured review excerpts are analysed. These are possible themes, not representative market demand.</p>
        <p className="field-note">Starting review analysis sends selected review excerpts to Anthropic. AI charges may apply. Nothing will be published.</p>
        <Button variant="outline" disabled={locked || !data?.configured || data.stale || reviewCount < 2 || !!saved.analysedAt}
          onClick={() => void mutate("/analyse", { reportId: saved.id, consent: true })}>Analyse confirmed reviews</Button>
        {reviewCount < 2 && <p className="field-note">Confirm relevant listings with at least two distinct review excerpts to analyse recurring feedback. Aggregate ratings alone are not review text.</p>}
        {saved.analysedAt && !saved.themes.length && <p>No recurring theme was accepted from this sample. No customer gap has been invented.</p>}
        {customerVoice && !data?.configured && <p className="field-note">AI review analysis is not configured on this server. Confirmed excerpts remain available to read.</p>}
        {!customerVoice && <p className="field-note">Open Customer voice to read confirmed feedback and saved themes for the selected product.</p>}
      </section>
      <details className="agent-sources"><summary>Research scope and evidence gaps</summary><ul>{saved.limitations.map((text) => <li key={text}>{text}</li>)}</ul></details>
    </div>}
  </div>;
}
