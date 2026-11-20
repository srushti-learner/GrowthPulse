import { useRef } from "react";
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
  return <blockquote className="feedback-quote">
    <p>{review.text}</p>
    <p className="field-note">{review.rating === null ? "Rating not supplied" : `${review.rating} / 5`} / {review.date || "Review date unknown"}</p>
    <a href={listing.url} target="_blank" rel="noreferrer">{listing.title || listing.marketplace}</a>
    <details className="feedback-quote-source"><summary>About this review source</summary>
      <p className="field-note">{listing.marketplace} / {marketplaceRelationLabels[listing.relation]} / {listing.method === "owner_export" ? "Owner-supplied export, not independently fetched" : "Captured public page"} / Captured <time dateTime={listing.capturedAt}>{new Date(listing.capturedAt).toLocaleString()}</time></p>
    </details>
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
  const sourceReview = useRef<HTMLDetailsElement>(null);
  if (!research) return <p>No marketplace sample loaded. Open Market Intelligence for a selected business to view saved customer feedback.</p>;
  const { product, products, productsLoading, productsError, reloadProducts, data, loading, error, selectProduct } = research;
  const saved = data?.report;
  const listings = confirmedListings(saved);
  const count = listings.reduce((sum, item) => sum + item.reviews.length, 0);
  const awaitingConfirmation = saved?.listings.filter((item) => item.status === "captured" && item.relation === "unconfirmed")
    .reduce((sum, item) => sum + item.reviews.length, 0) ?? 0;
  function reviewSources() {
    if (!sourceReview.current) return;
    sourceReview.current.open = true;
    sourceReview.current.querySelector("summary")?.focus();
    sourceReview.current.scrollIntoView?.({ block: "nearest" });
  }
  return <section className="marketplace-customer-voice" aria-label="Saved marketplace customer feedback">
    <header className="feedback-intro">
      <h4>What are customers telling you?</h4>
      <p>Spot recurring praise and problems in customer reviews, then decide what to improve.</p>
    </header>
    {productsLoading && <p role="status">Loading your saved products...</p>}
    {productsError && <p role="alert" className="form-error">{productsError} <Button variant="outline" onClick={reloadProducts}>Reload products</Button></p>}
    {!productsLoading && !productsError && !product && <p>Add a reviewed product to your <a href="#products">catalogue</a> to find permitted customer feedback.</p>}
    {product && <>
      <label>Product feedback<select value={product.id} onChange={(event) => selectProduct(event.target.value)}>
        {products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {data?.stale ? <p className="dashboard-notice">Your catalogue product changed. Previous sources are available below, but are not presented as current customer feedback. Find fresh feedback before using them.</p> : !loading && <>
        {!saved && !error && !data?.error && !data?.running && <section className="feedback-empty" aria-label="Customer feedback availability">
          <h4>No customer feedback saved yet</h4>
          <p>Find reviews for {product.name}, or add listing links or an authorized review CSV in Research options and details below.</p>
        </section>}
        {saved && <>
          {!!count && <div className="feedback-sample">
            <h4>{saved.analysedAt ? "Customer takeaways" : "Customer review sample"}</h4>
            <p className="field-note">{count} confirmed review excerpts. A limited sample, not representative sentiment, market demand or order counts.</p>
            {(data?.running || data?.error || error) && <p className="dashboard-notice">Showing the last saved sample. See the research status below.</p>}
          </div>}
          {!count && <section className="feedback-empty" aria-label="Customer feedback availability">
            <h4>{awaitingConfirmation ? "Reviews found. Check the products first." : "No customer review text available yet"}</h4>
            <p>{awaitingConfirmation
              ? `${awaitingConfirmation} captured review excerpts are waiting for listing confirmation. Check whether each source is your product or a comparable product before using its feedback.`
              : "Star ratings, published review counts and product descriptions are not review text. No customer takeaways can be drawn from them."}</p>
            {!awaitingConfirmation && <p>Try another listing or an authorized review CSV below. Confirming a match does not collect missing review text.</p>}
            {!!awaitingConfirmation && <Button variant="outline" onClick={reviewSources}>Review product matches</Button>}
          </section>}
          {(["own_product", "alternatives"] as const).map((scope) => {
            const scoped = listings.filter((item) => scope === "alternatives" ? item.relation === "alternative" : item.relation !== "alternative");
            const reviews = scoped.flatMap((item) => item.reviews.map((review) => ({ item, review })));
            if (!reviews.length) return null;
            const dates = reviews.flatMap(({ review }) => review.date ? [review.date] : []).sort();
            const themes = saved.themes.filter((theme) => theme.scope === scope && theme.reviewIds.length >= 2
              && theme.reviewIds.every((id) => reviews.some(({ review }) => review.id === id)));
            const preview = (themes.length
              ? reviews.filter(({ review }) => themes.some((theme) => theme.reviewIds.includes(review.id)))
              : reviews).slice(0, 2);
            return <section key={scope} aria-label={scope === "own_product" ? "Your product feedback" : "Comparable product feedback"}>
              <h4>{scope === "own_product" ? "Your product" : "Comparable products"}</h4>
              <p className="field-note">{reviews.length} sampled {reviews.length === 1 ? "excerpt" : "excerpts"} from {scoped.filter((item) => item.reviews.length).length} confirmed {scoped.filter((item) => item.reviews.length).length === 1 ? "listing" : "listings"}.{scope === "alternatives" && " These are not reviews of your product."}</p>
              {!saved.analysedAt && <p>Read the customer quotes below. These are not an AI sentiment summary; analyse confirmed reviews to look for recurring feedback.</p>}
              {saved.analysedAt && !themes.length && <p>No recurring theme was accepted for this sample.</p>}
              {!!themes.length && <p className="field-note">Themes analysed <time dateTime={saved.analysedAt ?? saved.createdAt}>{new Date(saved.analysedAt ?? saved.createdAt).toLocaleString()}</time>. Possible recurring feedback, not proven customer needs.</p>}
              {themes.map((theme) => <article className="feedback-takeaway" key={`${scope}:${theme.title}`}>
                <h5>{theme.title}</h5><p>{theme.sentiment === "negative" ? "Customer concern" : theme.sentiment === "positive" ? "Customer praise" : "Mixed feedback"} / {theme.reviewIds.length} supporting excerpts</p>
                <p><strong>Possible next step to validate:</strong> {theme.experiment}</p>
                <details className="agent-sources"><summary>Read supporting feedback ({theme.reviewIds.length})</summary>
                  {reviews.filter(({ review }) => theme.reviewIds.includes(review.id)).map(({ item, review }) =>
                    <ReviewExcerpt key={review.id} listing={item} review={review} />)}
                </details>
              </article>)}
              <h5>What customers said</h5>
              {preview.map(({ item, review }) => <ReviewExcerpt key={review.id} listing={item} review={review} />)}
              <details className="agent-sources"><summary>Read sampled reviews ({reviews.length})</summary>
                <p className="field-note">{dates.length ? `Dated reviews: ${dates[0]} to ${dates[dates.length - 1]}.` : "Review dates are unknown."} {reviews.length - dates.length} undated {reviews.length - dates.length === 1 ? "excerpt" : "excerpts"}. Capture dates are shown with each source.</p>
                {reviews.map(({ item, review }) => <ReviewExcerpt key={review.id} listing={item} review={review} />)}
              </details>
            </section>;
          })}
          {!!count && !!awaitingConfirmation && <p className="field-note">{awaitingConfirmation} other review excerpts need product confirmation. <Button variant="outline" onClick={reviewSources}>Review product matches</Button></p>}
          <p className="field-note">Sample saved <time dateTime={saved.createdAt}>{new Date(saved.createdAt).toLocaleString()}</time>.</p>
        </>}
      </>}
      <MarketplaceProduct key={product.id} customerVoice sourceReviewRef={sourceReview} />
    </>}
  </section>;
}
