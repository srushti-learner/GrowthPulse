import { useEffect, useId, useRef, useState } from "react";
import type { BriefingPreview, Understanding } from "../shared/understanding";
import { Icon } from "./Icon";
import { EvidenceExcerpt, sourcePage } from "./SourceDetails";
import type { ResearchSource } from "../shared/research";
import { marketplaceRelationLabels } from "../shared/marketplace";

type Sources = (Understanding["suggestions"][number]["sources"][number] & Partial<Pick<ResearchSource, "capturedAt" | "customerReview">>)[];
export type BriefingEvidence = { summary?: { sources: Sources }; insights?: { sources: Sources }[] };
type Section = "snapshot" | "findings" | "unknowns" | "next";
type Card = { id: string; section: Section; title: string; text?: string; detail?: string; sources?: Sources };
const sections: { id: Section; label: string }[] = [
  { id: "snapshot", label: "Business" }, { id: "findings", label: "Findings" },
  { id: "unknowns", label: "Unknowns" }, { id: "next", label: "Next moves" },
];
const areaLabels = { offering: "What you offer", positioning: "How the brand presents itself", buying_experience: "The public buying experience" };
const cardLabels = { snapshot: "BUSINESS SNAPSHOT", findings: "WEBSITE OBSERVATION", unknowns: "AN OPEN QUESTION", next: "YOUR NEXT USEFUL STEP" };

export function SupportingEvidence({ sources }: { sources: Sources }) {
  if (!sources.length) return null;
  return <details className="agent-sources"><summary>View supporting evidence</summary>{sources.map((source, index) => {
    const page = sourcePage(source.url);
    return <blockquote key={index}>{source.customerReview ? <p>{source.quote}</p> : <EvidenceExcerpt quote={source.quote} />}
      {source.customerReview && <p className="field-note">
        {source.customerReview.productName} / {marketplaceRelationLabels[source.customerReview.relation]} /{" "}
        {source.customerReview.method === "owner_export" ? "Owner-supplied export, not independently fetched or verified" : "Captured public review excerpt"}.
        {" "}{source.customerReview.reviewDate ? `Review dated ${source.customerReview.reviewDate}.` : "Review publication date unknown."}
        {" "}A selected, dated sample, not representative current sentiment.
      </p>}
      {page ? <a href={page.href} target="_blank" rel="noreferrer">View source · {page.hostname}</a> : <p className="field-note">Source page unavailable</p>}
      {source.capturedAt && <p className="field-note">Captured <time dateTime={source.capturedAt}>{new Date(source.capturedAt).toLocaleString()}</time></p>}
    </blockquote>;
  })}</details>;
}

export function BusinessBriefing({ businessName, briefing, evidence, streaming = !evidence }: {
  businessName: string; briefing: BriefingPreview; evidence?: BriefingEvidence; streaming?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const focusOnChange = useRef(false);
  const id = useId();
  const cards: Card[] = [];
  if (briefing.summary?.text) cards.push({
    id: "summary", section: "snapshot", title: `What I understand about ${businessName}`,
    text: briefing.summary.text, sources: evidence?.summary?.sources,
  });
  briefing.insights?.forEach((insight, index) => {
    if (insight.text || insight.whyItMatters) cards.push({
      id: `insight-${index}`, section: "findings", title: insight.area ? areaLabels[insight.area] : "Business observation",
      text: insight.text || insight.whyItMatters, detail: insight.text ? insight.whyItMatters : undefined,
      sources: evidence?.insights?.[index]?.sources,
    });
  });
  briefing.unknowns?.forEach((unknown, index) => {
    if (unknown.question || unknown.whyItMatters) cards.push({
      id: `unknown-${index}`, section: "unknowns", title: "What I still don't know",
      text: unknown.question || unknown.whyItMatters, detail: unknown.question ? unknown.whyItMatters : undefined,
    });
  });
  briefing.nextSteps?.forEach((step, index) => {
    if (step.action || step.reason) cards.push({
      id: `next-${index}`, section: "next", title: index === 0 ? "One useful next move" : "Another check to consider",
      text: step.action || step.reason, detail: step.action ? step.reason : undefined,
    });
  });
  const position = Math.max(0, cards.findIndex((card) => card.id === selected));
  const current = cards[position];
  useEffect(() => {
    if (current && selected !== current.id) setSelected(current.id);
    if (focusOnChange.current) { heading.current?.focus(); focusOnChange.current = false; }
  }, [current?.id, selected]);

  function select(card: Card) {
    if (card.id === current?.id) { heading.current?.focus(); return; }
    focusOnChange.current = true;
    setSelected(card.id);
  }

  return <section className="agent-briefing" aria-label="Business briefing">
    <div className="briefing-deck-heading">
      {streaming && <p className="field-note">Your briefing is being written. More cards will appear shortly.</p>}
      <nav className="briefing-sections" aria-label="Briefing sections">
        {sections.map((section) => {
          const first = cards.find((card) => card.section === section.id);
          const count = cards.filter((card) => card.section === section.id).length;
          return <button type="button" key={section.id} disabled={!first} aria-pressed={current?.section === section.id}
            aria-controls={current ? `${id}-card` : undefined} onClick={() => { if (first) select(first); }}>
            {section.label}{count > 0 && <span aria-hidden="true">{count}</span>}
          </button>;
        })}
      </nav>
    </div>
    {current ? <>
      <div className="briefing-position">
        <p role="status" aria-atomic="true">Card {position + 1} of {cards.length}{streaming && " available"}</p>
        <progress aria-label="Reading position" value={position + 1} max={cards.length} />
      </div>
      <article id={`${id}-card`} key={current.id} className={`briefing-card briefing-card-${current.section}`} aria-labelledby={`${id}-heading`}>
        <p className="section-eyebrow">{cardLabels[current.section]}</p>
        <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>{current.title}</h3>
        <p className="briefing-card-text">{current.text}</p>
        {current.detail && <details className="briefing-card-detail"><summary>Why it matters</summary><p>{current.detail}</p></details>}
        {current.sources && <SupportingEvidence sources={current.sources} />}
      </article>
      <div className="briefing-navigation" aria-label="Finding navigation">
        <button type="button" className="secondary-button" disabled={position === 0} onClick={() => select(cards[position - 1])}>Previous</button>
        <button type="button" className="primary-link" disabled={position === cards.length - 1} onClick={() => select(cards[position + 1])}>Next card <Icon name="arrow" /></button>
      </div>
    </> : <p className="field-note">{streaming ? "Waiting for the first finding..." : "No briefing cards were saved."}</p>}
  </section>;
}
