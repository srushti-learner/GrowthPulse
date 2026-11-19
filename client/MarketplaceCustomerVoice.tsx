import { marketplaceRelationLabels, type MarketplaceListing, type MarketplaceReport } from "../shared/marketplace";
import { useMarketplaceResearch } from "./MarketplaceResearchContext";
import { Button } from "./components/ui/button";
import { MarketplaceProduct } from "./MarketplaceInsights";
import "./marketplace.css";

function confirmedListings(report: MarketplaceReport | null | undefined) {
  return report?.listings.filter((item) => item.status === "captured"
    && (item.relation === "my_listing" || item.relation === "other_seller" || item.relation === "alternative")) ?? [];
}

function ReviewExcerpt({ listing, review }: { listing: MarketplaceListing; review: MarketplaceListing["reviews"][number] }) {
  return <blockquote>
    <p>{review.text}</p>
    <p className="field-note">{review.rating === null ? "Rating not supplied" : `${review.rating} / 5`} / {review.date || "Review date unknown"}</p>
    <a href={listing.url} target="_blank" rel="noreferrer">{listing.title || listing.marketplace}</a>
    <p className="field-note">{listing.marketplace} / {marketplaceRelationLabels[listing.relation]} / {listing.method === "owner_export" ? "Owner-supplied export, not independently fetched" : "Captured public page"} / Captured <time dateTime={listing.capturedAt}>{new Date(listing.capturedAt).toLocaleString()}</time></p>
  </blockquote>;
}

export function useCustomerVoiceSummary() {
  const research = useMarketplaceResearch();
  if (!research) return "No marketplace sample loaded";
  if (research.productsLoading || research.loading) return "Loading saved feedback";
  if (research.productsError || research.error) return "Feedback could not be loaded";
  if (!research.product) return "Add a product";
  if (research.data?.running) return research.data.progress?.stage === "analysing" ? "Analysing customer feedback" : "Collecting customer feedback";
  if (research.data?.stale) return "Previous product evidence";
  if (research.data?.error) return "Feedback research needs attention";
  const count = confirmedListings(research.data?.report).reduce((sum, item) => sum + item.reviews.length, 0);
  if (count) return `${count} sampled review ${count === 1 ? "excerpt" : "excerpts"}`;
  if (research.data?.report?.listings.some((item) => item.status === "captured" && item.relation === "unconfirmed" && item.reviews.length))
    return "Confirm listing matches";
  return research.data?.report ? "No confirmed review text" : "No feedback saved";
}

export function MarketplaceCustomerVoice() {
  const research = useMarketplaceResearch();
  if (!research) return <p>No marketplace sample loaded. Open Market Intelligence for a selected business to view saved customer feedback.</p>;
  const { product, products, productsLoading, productsError, reloadProducts, data, loading, error, selectProduct } = research;
  const saved = data?.report;
  const listings = confirmedListings(saved);
  const count = listings.reduce((sum, item) => sum + item.reviews.length, 0);
  const insightsFirst = !!saved?.analysedAt && !data?.stale && !data?.running && !data?.error && !error;
  return <section className="marketplace-customer-voice" aria-label="Saved marketplace customer feedback">
    <h4>Hear from people, not product pages</h4>
    <p>Find and review sampled Amazon India / Flipkart customer feedback. Your product and comparable products are kept separate; brand claims are not customer reviews.</p>
    {productsLoading && <p role="status">Loading your saved products...</p>}
    {productsError && <p role="alert" className="form-error">{productsError} <Button variant="outline" onClick={reloadProducts}>Reload products</Button></p>}
    {!productsLoading && !productsError && !product && <p>Add a reviewed product to your <a href="#products">catalogue</a> to find permitted customer feedback.</p>}
    {product && <>
      <label>Product feedback<select value={product.id} onChange={(event) => selectProduct(event.target.value)}>
        {products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {!insightsFirst && <MarketplaceProduct key={product.id} customerVoice />}
      {data?.stale ? <p className="dashboard-notice">Your catalogue product changed. Previous sources are shown above, but are not presented as current customer feedback. Research again before using them.</p> : !loading && <>
        {!saved && !error && !data?.error && !data?.running && <p>No marketplace feedback saved for {product.name}. Choose Find customer feedback, or add listing links or an authorized review CSV in Research options and details.</p>}
        {saved && <>
          <p className="field-note">Saved <time dateTime={saved.createdAt}>{new Date(saved.createdAt).toLocaleString()}</time>. {count} distinct review excerpts in confirmed listings. This is a limited sample, not representative sentiment, market demand or order counts.</p>
          {!count && <p>{saved.listings.some((item) => item.status === "captured" && item.relation === "unconfirmed" && item.reviews.length)
            ? "Review excerpts are waiting for listing confirmation. Confirm whether each source above is your product or a comparable product."
            : "No review text is available from confirmed listings. Search snippets and aggregate ratings are not individual customer feedback. Public access restrictions may limit capture; an authorized review CSV is a fallback."}</p>}
          {(["own_product", "alternatives"] as const).map((scope) => {
            const scoped = listings.filter((item) => scope === "alternatives" ? item.relation === "alternative" : item.relation !== "alternative");
            const reviews = scoped.flatMap((item) => item.reviews.map((review) => ({ item, review })));
            if (!reviews.length) return null;
            const dates = reviews.flatMap(({ review }) => review.date ? [review.date] : []).sort();
            const themes = saved.themes.filter((theme) => theme.scope === scope && theme.reviewIds.length >= 2
              && theme.reviewIds.every((id) => reviews.some(({ review }) => review.id === id)));
            return <section key={scope} aria-label={scope === "own_product" ? "Your product feedback" : "Comparable product feedback"}>
              <h4>{scope === "own_product" ? "Your product" : "Comparable products"}</h4>
              <p>{reviews.length} sampled {reviews.length === 1 ? "excerpt" : "excerpts"} from {scoped.filter((item) => item.reviews.length).length} confirmed {scoped.filter((item) => item.reviews.length).length === 1 ? "listing" : "listings"}.</p>
              <p className="field-note">{dates.length ? `Dated reviews: ${dates[0]} to ${dates[dates.length - 1]}.` : "Review dates are unknown."} {reviews.length - dates.length} undated {reviews.length - dates.length === 1 ? "excerpt" : "excerpts"}. Capture dates are shown with each source.</p>
              {!saved.analysedAt && <p>These are review excerpts, not an AI sentiment summary. Choose Analyse confirmed reviews above to identify possible recurring themes.</p>}
              {saved.analysedAt && !themes.length && <p>No recurring theme was accepted for this sample.</p>}
              {!!themes.length && <p className="field-note">Themes analysed <time dateTime={saved.analysedAt ?? saved.createdAt}>{new Date(saved.analysedAt ?? saved.createdAt).toLocaleString()}</time>. Possible recurring feedback, not proven customer needs.</p>}
              {themes.map((theme) => <article className="marketplace-listing" key={`${scope}:${theme.title}`}>
                <h5>{theme.title}</h5><p>{theme.sentiment} feedback / {theme.reviewIds.length} supporting excerpts</p>
                <p><strong>Experiment to validate:</strong> {theme.experiment}</p>
                <details className="agent-sources"><summary>Read supporting feedback</summary>
                  {reviews.filter(({ review }) => theme.reviewIds.includes(review.id)).map(({ item, review }) =>
                    <ReviewExcerpt key={review.id} listing={item} review={review} />)}
                </details>
              </article>)}
              <details className="agent-sources"><summary>Read sampled reviews ({reviews.length})</summary>
                {reviews.map(({ item, review }) => <ReviewExcerpt key={review.id} listing={item} review={review} />)}
              </details>
            </section>;
          })}
          <details className="agent-sources"><summary>Feedback evidence gaps</summary>
            <ul>{saved.limitations.map((text) => <li key={text}>{text}</li>)}</ul>
            {listings.filter((item) => item.limitation).map((item) => <p key={item.id}>{item.marketplace}: {item.limitation}</p>)}
          </details>
        </>}
        {insightsFirst && <details className="agent-sources"><summary>Review sources or collect fresh feedback</summary>
          <MarketplaceProduct key={product.id} customerVoice />
        </details>}
      </>}
    </>}
    <p className="field-note">Browsing saved feedback starts no searches or AI calls. A single review sample does not establish a market trend.</p>
  </section>;
}
