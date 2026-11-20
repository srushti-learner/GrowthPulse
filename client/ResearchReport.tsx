import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { competitorDimensions, competitorDimensionLabels, type ResearchReport as Report } from "../shared/research";
import type { BriefingPreview, Understanding } from "../shared/understanding";
import { SupportingEvidence, type BriefingEvidence } from "./BusinessBriefing";
import { Icon } from "./Icon";
import { ResearchOverview, type ResearchView } from "./ResearchDashboard";
import { MarketIntelligence } from "./MarketIntelligence";
import { describeLimitation } from "./research-messages";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { EvidenceExcerpt } from "./SourceDetails";

function MarketResearch({ report, businessName, topics = [...competitorDimensions], showSuggestions = true }: {
  report: Report; businessName: string; topics?: typeof competitorDimensions[number][]; showSuggestions?: boolean;
}) {
  const brands = report.steps.flatMap((step) => step.profile ? [step.profile] : []);
  const sites = report.steps.filter((step) => /^competitor-site-\d+$/.test(step.key));
  const captured = sites.filter((step) => step.status === "completed" || step.status === "limited");
  const findings = report.steps.filter((step) => step.agent === "competitor").flatMap((step) => step.findings)
    .filter((finding) => showSuggestions || finding.kind !== "suggestion");
  const takeaway = findings.find((finding) => finding.kind === "observation") ?? findings.find((finding) => finding.kind === "hypothesis");
  const nextMove = findings.find((finding) => finding.kind === "suggestion");
  const additional = findings.filter((finding) => finding !== takeaway && finding !== nextMove);
  const limitations = [...new Set(report.steps.filter((step) => step.agent === "competitor" && !/^competitor-(site|brand)-\d+$/.test(step.key))
    .flatMap((step) => step.limitations).map(describeLimitation))];
  const planningFailed = report.steps.some((step) => step.key === "discovery-plan" && step.status === "failed");
  const searchStarted = report.steps.some((step) => step.search);
  const selectionFailed = report.steps.some((step) => step.key === "discovery" && (step.status === "failed"
    || (step.diagnostic?.code === "candidate_validation" && !report.usage.competitorScans)));
  const evidenceId = useId();
  const sourceTrigger = useRef<HTMLButtonElement | null>(null);
  const sourcePanel = useRef<HTMLElement | null>(null);
  const [dimension, setDimension] = useState<typeof competitorDimensions[number]>(topics[0] ?? "products");
  const activeDimension = topics.includes(dimension) && brands.some((brand) => brand.facts.some((fact) => fact.dimension === dimension))
    ? dimension : topics.find((topic) => brands.some((brand) => brand.facts.some((fact) => fact.dimension === topic))) ?? topics[0] ?? "products";
  const [selected, setSelected] = useState<{ url: string; dimension: typeof competitorDimensions[number] } | null>(null);
  useEffect(() => { if (selected) sourcePanel.current?.focus(); }, [selected]);
  const selectedBrand = brands.find((brand) => brand.url === selected?.url);
  const selectedFact = selectedBrand?.facts.find((fact) => fact.dimension === selected?.dimension);
  const selectedSource = selectedBrand?.sources.find((source) => source.id === selectedFact?.sourceId);
  return <section className="market-research" aria-label="Competing brand comparison">
    {topics.length === competitorDimensions.length && (!!brands.length || !!findings.length) &&
      <section className="market-brief" aria-label="Competitive takeaway">
        <div className="market-brief-heading"><p className="section-eyebrow">{businessName} / Competitive brief</p>
          <span>{brands.length ? `${brands.length} related ${brands.length === 1 ? "brand" : "brands"}` : "Limited evidence"}</span></div>
        <div className={`market-brief-grid${nextMove && (takeaway || brands.length) ? " has-action" : ""}`}>
          {(takeaway || !!brands.length) && <article className="market-takeaway">
            <p className="market-kicker"><Icon name="spark" />{takeaway?.kind === "hypothesis" ? "A direction to validate" : takeaway ? brands.length ? "What stands out" : "Saved research finding" : "What we can compare"}</p>
            <h5>{takeaway?.title ?? "Start with the product promise"}</h5>
            <p>{takeaway?.detail ?? "See what each verified brand says it offers. The captured evidence does not yet support a stronger strategic conclusion."}</p>
            {takeaway && <SupportingEvidence sources={takeaway.sources} />}
          </article>}
          {nextMove && <article className="market-next-move" aria-label="Suggested next move">
            <p className="market-kicker"><Icon name="arrow" />Suggested next move</p>
            <h5>{nextMove.title}</h5><p>{nextMove.detail}</p>
            <SupportingEvidence sources={nextMove.sources} />
          </article>}
        </div>
        <p className="market-sample-note">{!brands.length ? "No verified brand profiles yet." : brands.length < 3 ? "Early view: a narrow sample, not the whole market." : "A sample of related brands, not the whole market."}
          {" "}Public claims, not independently verified performance.</p>
      </section>}
    {!brands.length && <div className="market-empty"><Icon name="chart" /><p>{!report.enabled ? "This saved analysis covered your store only. New analyses include competitor research automatically."
      : planningFailed && !searchStarted ? "Competitor search could not start because its search plan could not be validated against captured website evidence."
      : report.status === "running" ? "Searching and checking brand websites..."
      : selectionFailed ? "Competitor candidate selection could not finish. Brand websites were not verified, so comparisons are unavailable. This is not evidence that your business has no competitors."
      : captured.length ? "Sites were captured, but no brand passed verification in this saved run. That does not establish that your business has no competitors."
      : sites.length ? "Candidate websites could not be captured in this saved run. That does not establish that your business has no competitors."
      : "No qualifying independent brand was verified. Marketplace listings are not a substitute for competitor research."}</p>
      <p className="field-note">{findings.length ? "Brand-by-brand comparisons require verified website profiles." : "There is not enough verified evidence for a competitive conclusion yet."}</p>
    </div>}
    {!!brands.length && <section className="market-evidence-map" aria-label="Focused brand comparison">
        <div className="market-visual-heading"><Icon name="overview" /><div>
          <h5>How the brands compare</h5><p>One topic at a time. Compare published claims, not brand scores.</p>
        </div></div>
        <div className="market-topics" role="group" aria-label="Comparison topic">{topics.map((topic) =>
          <button type="button" key={topic} aria-pressed={activeDimension === topic}
            disabled={!brands.some((brand) => brand.facts.some((fact) => fact.dimension === topic))}
            onClick={() => { setDimension(topic); setSelected(null); }}>{competitorDimensionLabels[topic]}</button>)}</div>
        <div className="market-battlecards">{brands.map((brand) => {
          const fact = brand.facts.find((fact) => fact.dimension === activeDimension);
          const source = brand.sources.find((source) => source.id === fact?.sourceId);
          return <article className="market-brand" key={brand.url} aria-label={`${brand.name} comparison`}>
            <div className="market-brand-heading"><span className="market-brand-mark" aria-hidden="true">
              {brand.name.split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join("").toUpperCase()}
            </span><div><h5><a href={brand.url} target="_blank" rel="noreferrer">{brand.name}</a></h5>
              <span className={`market-market-tag${brand.marketVerified ? " is-confirmed" : ""}`}>
                {brand.marketVerified ? "Market overlap confirmed" : "Market overlap unconfirmed"}
              </span></div></div>
            <p className="market-card-topic">{competitorDimensionLabels[activeDimension]}</p>
            {fact ? <blockquote className="market-product-fact"><EvidenceExcerpt quote={fact.text} /></blockquote> : <p className="market-missing-cell">Not captured</p>}
            {fact && source && <button className="market-source-button" type="button"
              onClick={(event) => {
                sourceTrigger.current = event.currentTarget;
                setSelected((current) => current?.url === brand.url && current.dimension === activeDimension ? null : { url: brand.url, dimension: activeDimension });
              }}
              aria-label={`${brand.name}: ${competitorDimensionLabels[activeDimension]} - view evidence`}
              aria-controls={selected?.url === brand.url && selected.dimension === activeDimension ? evidenceId : undefined}
              aria-expanded={selected?.url === brand.url && selected.dimension === activeDimension}>
              View source<Icon name="diagonal" /></button>}
          </article>;
        })}</div>
        {selectedBrand && selectedFact && selectedSource && <section id={evidenceId} ref={sourcePanel} tabIndex={-1} className="market-selected-fact" aria-label="Selected comparison evidence">
          <div className="market-source-heading"><p className="section-eyebrow">{selectedBrand.name} / {competitorDimensionLabels[selectedFact.dimension]}</p>
            <button type="button" className="text-button" onClick={() => { setSelected(null); sourceTrigger.current?.focus(); }}>Close source</button></div>
          <blockquote><EvidenceExcerpt quote={selectedFact.text} /></blockquote>
          <a href={selectedSource.url} target="_blank" rel="noreferrer">Open captured page<Icon name="diagonal" /></a>
          <p className="field-note">Captured <time dateTime={selectedSource.capturedAt}>{new Date(selectedSource.capturedAt).toLocaleString()}</time></p>
        </section>}
      </section>}
    {topics.length === competitorDimensions.length && !!additional.length && <details className="agent-sources market-more-findings"><summary>More research findings ({additional.length})</summary>
        {additional.map((finding, index) => <article className="research-finding" key={index}>
          <p className="section-eyebrow">{finding.kind}</p><h5>{finding.title}</h5><p>{finding.detail}</p>
          <SupportingEvidence sources={finding.sources} />
        </article>)}
      </details>}
    {!!brands.length && <details className="agent-sources market-full-comparison"><summary>Full comparison</summary>
        <div className="market-comparison-scroll" role="region" aria-label="Brand comparison table" tabIndex={0}>
          <table className="market-comparison"><caption>Published brand comparison</caption>
            <thead><tr><th scope="col">Compare</th>{brands.map((brand) => <th key={brand.url} scope="col">{brand.name}</th>)}</tr></thead>
            <tbody>{topics.map((topic) => <tr key={topic}>
              <th scope="row">{competitorDimensionLabels[topic]}</th>{brands.map((brand) => {
                const fact = brand.facts.find((fact) => fact.dimension === topic);
                return <td key={brand.url}>{fact ? <EvidenceExcerpt quote={fact.text} />
                  : <span className="field-note">Not established from captured pages.</span>}</td>;
              })}
            </tr>)}</tbody>
          </table>
        </div>
      </details>}
    {(!!sites.length || !!limitations.length) && <details className="agent-sources market-research-notes"><summary>Research scope and limitations</summary>
      <p>Public website evidence only. This is not a market-share study or a ranking of brand performance.</p>
      {!!sites.length && <><p>Sites attempted: {sites.length}. Sites captured: {captured.length}. Brands verified: {brands.length}.</p>
        <ul className="market-capture-list">{sites.map((site, index) => {
          const assessment = report.steps.find((step) => step.key === site.key.replace("competitor-site-", "competitor-brand-"));
          const outcome = assessment?.profile ? "Verified brand" : site.status === "failed" ? "Capture failed"
            : site.status === "running" ? "Reading website" : assessment?.status === "running" ? "Checking brand"
            : assessment?.status === "failed" ? "Verification failed"
            : assessment || report.status !== "running" ? "Not verified" : "Awaiting verification";
          const reason = site.status === "failed" ? site.limitations[0] : assessment?.limitations[0];
          return <li className="market-capture" key={site.key}>
            <div className="market-capture-heading">{site.capture
              ? <a href={site.capture.url} target="_blank" rel="noreferrer">{new URL(site.capture.url).hostname.replace(/^www\./, "")}</a>
              : <strong>Candidate {index + 1}</strong>}<span>{outcome}</span></div>
            <p className="field-note">{site.capture ? `${site.capture.pages} ${site.capture.pages === 1 ? "page" : "pages"} captured` : "Page count was not recorded."}</p>
            {reason && <p>{describeLimitation(reason)}</p>}
          </li>;
        })}</ul></>}
      {!!limitations.length && <ul>{limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>}
    </details>}
  </section>;
}

export function ResearchReport({ report, businessName, briefing, evidence, previousBriefing, renderResearchOptions, initialView = "overview" }: {
  report: Report; businessName: string; briefing?: BriefingPreview | null;
  evidence?: NonNullable<Understanding["briefing"]>; briefingKey: string;
  previousBriefing?: Understanding | null;
  renderResearchOptions?: (forMarketComparison: boolean) => ReactNode;
  initialView?: ResearchView;
}) {
  const [view, setView] = useState<ResearchView>(initialView);
  useEffect(() => { setView(initialView); }, [initialView]);
  const storeFindings = report.steps.filter((step) => step.agent === "store").flatMap((step) => step.findings);
  const summary = storeFindings.find((finding) => finding.title === "Your public storefront");
  const insights = storeFindings.filter((finding) => finding !== summary);
  const savedSummary: BriefingPreview | undefined = storeFindings.length ? {
    ...(summary ? { summary: { text: summary.detail } } : {}),
    insights: insights.map((finding) => ({
      area: finding.title === "offering" ? "offering" : finding.title === "positioning" ? "positioning"
        : finding.title === "buying experience" ? "buying_experience" : undefined,
      text: finding.detail,
    })),
  } : undefined;
  const savedEvidence: BriefingEvidence | undefined = storeFindings.length ? {
    ...(summary ? { summary: { sources: summary.sources } } : {}), insights: insights.map((finding) => ({ sources: finding.sources })),
  } : undefined;
  const storeStep = report.steps.find((step) => step.key === "store");
  const provisionalBriefing = storeStep?.status === "failed" ? undefined : briefing;
  const currentBriefing = evidence ?? provisionalBriefing ?? savedSummary;
  const retained = !currentBriefing && previousBriefing?.briefing ? previousBriefing : null;
  const storeBriefing = currentBriefing ?? retained?.briefing;
  const storeEvidence = evidence ?? (provisionalBriefing ? undefined : savedEvidence) ?? retained?.briefing ?? undefined;
  const hasMarketResearch = report.steps.some((step) => step.key === "discovery-plan" || step.profile);
  return <section className="research-report" aria-label="Saved research findings">
    <Tabs value={view} onValueChange={(value) => { if (value === "overview" || value === "intelligence") setView(value); }}>
      <TabsList className="research-view-tabs" aria-label="Business research views">
        <TabsTrigger value="overview">At a glance</TabsTrigger>
        <TabsTrigger value="intelligence">Market intelligence</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" forceMount hidden={view !== "overview"}>
        <ResearchOverview report={report} businessName={businessName} briefing={storeBriefing} evidence={storeEvidence}
          retainedAt={retained?.createdAt} onNavigate={setView} />
      </TabsContent>
      <TabsContent value="intelligence" forceMount hidden={view !== "intelligence"}>
        <MarketIntelligence report={report} businessName={businessName} renderComparison={(saved, topics) =>
          <MarketResearch key={topics?.join(":") ?? "competitors"} report={saved} businessName={businessName} topics={topics} showSuggestions={false} />} />
      </TabsContent>
    </Tabs>
    {renderResearchOptions?.(view === "intelligence" && !hasMarketResearch)}
  </section>;
}
