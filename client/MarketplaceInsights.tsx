import { useEffect, useRef, useState } from "react";
import {
  marketplaceRelationLabels, marketplaceRelations, type MarketplaceListing,
} from "../shared/marketplace";
import { errorMessage } from "./api";
import { SupportingEvidence } from "./BusinessBriefing";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { useMarketplaceResearch } from "./MarketplaceResearchContext";
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

function MarketplaceProduct() {
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
  function match(item: MarketplaceListing, relation: MarketplaceListing["relation"]) {
    if (saved) void mutate("/match", { reportId: saved.id, listingId: item.id, relation }, "PATCH");
  }
  return <div className="marketplace-product">
    {loading && <p role="status">Loading saved marketplace research...</p>}
    {data?.running && <p role="status">Marketplace research is running. You can leave this page and return; no new work starts when you reopen it.</p>}
    {(fileError || error || data?.error) && <p role="alert" className="form-error">{fileError || error || data?.error} <Button variant="outline" disabled={busy} onClick={() => { setFileError(""); reloadStatus(); }}>Reload saved status</Button></p>}
    {data?.error && !data.running && <p className="field-note">The last research attempt failed. Select Retry marketplace research to start a new attempt. Reload saved status only refreshes this saved message.</p>}
    {data?.stale && <p className="dashboard-notice">Your catalogue product changed. These are previous marketplace results; research again before confirming matches or analysing reviews.</p>}
    <div className="marketplace-research-controls">
      <Button disabled={locked || !data || !urls.trim() && (!data.configured || !data.discoveryConfigured)} onClick={() => void mutate("", {
        consent: true, requestKey: requestKey.current, urls: urls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), refresh: !!saved,
      })}>{data?.running ? "Researching..." : data?.error ? "Retry marketplace research" : saved ? "Research again" : "Research marketplaces"}</Button>
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
      {!saved.listings.length && <p>No matching marketplace listing was verified. This does not mean your product is absent from Amazon or Flipkart.</p>}
      <div className="marketplace-listings">{saved.listings.map((item) => <article className="marketplace-listing" key={item.id}>
        <div><Badge variant="outline">{item.marketplace}</Badge> <Badge variant="outline">{item.method === "owner_export" ? "Owner-supplied export" : item.status === "captured" ? "Captured public page" : "Evidence unavailable"}</Badge></div>
        <h3>{item.title || "Marketplace listing"}</h3>
        <a href={item.url} target="_blank" rel="noreferrer">Open listing</a>
        {item.status === "captured" && <>
          {item.description && <p className="dashboard-clamped">{item.description}</p>}
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
          {!!item.reviews.length && <details className="agent-sources"><summary>Captured review excerpts ({item.reviews.length})</summary>
            {item.reviews.map((value) => <blockquote key={value.id}><p>{value.text}</p><p className="field-note">{value.rating === null ? "Rating not supplied" : `${value.rating} / 5`}{value.date ? ` / ${value.date}` : " / Review date unknown"}</p></blockquote>)}
          </details>}
        </>}
        <p className="field-note">{item.limitation}</p>
      </article>)}</div>
      <section aria-label="Customer feedback themes">
        <h3>Review analysis</h3>
        <p>Only confirmed listings and distinct captured review excerpts are analysed. These are possible themes, not representative market demand.</p>
        <p className="field-note">Starting review analysis sends selected review excerpts to Anthropic. AI charges may apply. Nothing will be published.</p>
        <Button variant="outline" disabled={locked || !data?.configured || data.stale || reviewCount < 2 || !!saved.analysedAt}
          onClick={() => void mutate("/analyse", { reportId: saved.id, consent: true })}>Analyse confirmed reviews</Button>
        {reviewCount < 2 && <p className="field-note">Confirm relevant listings with at least two distinct review excerpts to analyse recurring feedback. Aggregate ratings alone are not review text.</p>}
        {saved.analysedAt && !saved.themes.length && <p>No recurring theme was accepted from this sample. No customer gap has been invented.</p>}
        <p className="field-note">Open Customer voice below to read confirmed feedback and saved themes for the selected product.</p>
      </section>
      <details className="agent-sources"><summary>Research scope and evidence gaps</summary><ul>{saved.limitations.map((text) => <li key={text}>{text}</li>)}</ul></details>
    </div>}
  </div>;
}
