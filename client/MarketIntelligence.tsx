import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Globe2, MessageSquare, Package, Search, TrendingUp, Wallet } from "lucide-react";
import type { competitorDimensions, ResearchFinding, ResearchReport } from "../shared/research";
import { MarketplaceCustomerVoice, useCustomerVoiceSummary } from "./MarketplaceCustomerVoice";
import { SupportingEvidence } from "./BusinessBriefing";
import { describeStepLimitations } from "./research-messages";
import { Badge } from "./components/ui/badge";
import { BlurFade } from "./components/ui/blur-fade";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./components/ui/sheet";

const areas = [
  { id: "competitors", label: "Competitors", description: "Related brands, positioning and published claims.", icon: Globe2 },
  { id: "customer", label: "Customer voice", description: "Review evidence, not brand marketing.", icon: MessageSquare },
  { id: "trends", label: "Market trends", description: "Changes in the market over time.", icon: TrendingUp },
  { id: "pricing", label: "Pricing", description: "Captured offers and exact-product checks.", icon: Wallet },
  { id: "products", label: "Product landscape", description: "What verified brands say they offer.", icon: Package },
  { id: "gaps", label: "Market gaps", description: "Research hypotheses that still need validation.", icon: Search },
] as const;
type Area = typeof areas[number]["id"];
type Topic = typeof competitorDimensions[number];

function findingLabel(finding: ResearchFinding) {
  return finding.kind === "hypothesis" ? "Hypothesis / needs validation"
    : finding.kind === "suggestion" ? "AI suggestion" : "Captured observation";
}

function Finding({ finding }: { finding: ResearchFinding }) {
  return <Sheet><SheetTrigger asChild><Button variant="outline" className="market-finding-trigger">Read evidence<ArrowRight /></Button></SheetTrigger>
    <SheetContent className="research-drawer">
      <SheetHeader><p className="section-eyebrow">{findingLabel(finding)}</p>
        <SheetTitle>{finding.title}</SheetTitle>
        <SheetDescription>Inspect the source, quotation and capture date. Public claims are not independently verified performance.</SheetDescription>
      </SheetHeader>
      <div className="research-drawer-body"><p>{finding.detail}</p><SupportingEvidence sources={finding.sources} /></div>
    </SheetContent>
  </Sheet>;
}

export function MarketIntelligence({ report, businessName, renderComparison }: {
  report: ResearchReport; businessName: string;
  renderComparison: (report: ResearchReport, topics?: Topic[]) => ReactNode;
}) {
  const [area, setArea] = useState<Area | "overview">("overview");
  const [limit, setLimit] = useState(6);
  const heading = useRef<HTMLHeadingElement>(null);
  const changed = useRef(false);
  const customerVoiceSummary = useCustomerVoiceSummary();
  useEffect(() => { if (changed.current) { heading.current?.focus(); changed.current = false; } }, [area]);
  function navigate(value: Area | "overview") { changed.current = true; setArea(value); setLimit(6); }
  const accepted: ResearchReport = { ...report, steps: report.steps.map((step) =>
    step.status === "completed" || step.status === "limited" ? step : { ...step, findings: [], profile: undefined }) };
  const brands = accepted.steps.flatMap((step) => step.profile ? [step.profile] : []);
  const externalHosts = new Set(brands.flatMap((brand) =>
    [brand.url, ...brand.sources.map((source) => source.url)].map((url) => new URL(url).hostname.replace(/^www\./, ""))));
  const marketReport: ResearchReport = { ...accepted, steps: accepted.steps.map((step) => ({ ...step,
    findings: step.findings.filter((finding) => finding.kind !== "suggestion"
      && finding.sources.some((source) => externalHosts.has(new URL(source.url).hostname.replace(/^www\./, "")))),
  })) };
  const findingsFor = (agents: string[], kind?: ResearchFinding["kind"]) => {
    const findings = marketReport.steps.filter((step) => agents.includes(step.agent)).flatMap((step) => step.findings)
      .filter((finding) => finding.kind !== "suggestion" && (!kind || finding.kind === kind));
    return [...new Map(findings.map((finding) => [`${finding.title}:${finding.detail}`, finding])).values()];
  };
  const external = findingsFor(["competitor", "pricing"]);
  const gaps = findingsFor(["competitor", "opportunity"], "hypothesis");
  const marketFindings = [...new Map(accepted.steps
    .filter((step) => ["competitor", "pricing", "opportunity"].includes(step.agent))
    .flatMap((step) => step.findings)
    .filter((finding) => finding.sources.some((source) => externalHosts.has(new URL(source.url).hostname.replace(/^www\./, ""))))
    .map((finding) => [`${finding.title}:${finding.detail}`, finding])).values()];
  const takeaway = external.find((finding) => finding.kind === "observation")
    ?? marketFindings.find((finding) => finding.kind === "suggestion") ?? marketFindings[0];
  const additionalFindings = marketFindings.filter((finding) => finding.title !== takeaway?.title || finding.detail !== takeaway?.detail);
  const prices = brands.filter((brand) => brand.facts.some((fact) => fact.dimension === "pricing")).length;
  const products = brands.filter((brand) => brand.facts.some((fact) => fact.dimension === "products")).length;
  const researching = report.enabled && report.status === "running";
  const competitorSteps = report.steps.filter((step) => step.agent === "competitor");
  const noBrandsDescription = researching
    ? "Market research is in progress. Comparisons will appear as their evidence is verified."
    : !report.enabled
      ? "Start a website analysis to gather competitor information for your market view."
      : competitorSteps.some((step) => step.key.startsWith("competitor-brand-"))
        ? "Potential competitors were found, but their published product information couldn't be verified well enough for a comparison."
        : competitorSteps.some((step) => step.key.startsWith("competitor-site-") && step.status === "failed")
          ? "Competitor websites couldn't be read, so a comparison isn't available yet."
          : competitorSteps.some((step) => step.key.startsWith("discovery") && step.status === "failed")
            ? "The competitor search couldn't be completed. Your saved business information is unchanged."
            : "No verified brand profiles are available in this saved sample.";
  const available: Record<Area, string> = {
    competitors: researching && !brands.length ? "Checking competitor websites" : `${brands.length} verified ${brands.length === 1 ? "brand" : "brands"}`,
    customer: customerVoiceSummary, trends: "Trend data not configured",
    pricing: researching && !prices ? "Research in progress" : `${prices} ${prices === 1 ? "brand" : "brands"} with published pricing`,
    products: researching && !products ? "Research in progress" : `${products} ${products === 1 ? "brand" : "brands"} with product claims`,
    gaps: researching && !gaps.length ? "Research in progress" : `${gaps.length} ${gaps.length === 1 ? "hypothesis" : "hypotheses"} to validate`,
  };
  const selected = areas.find((item) => item.id === area);
  const findings = area === "pricing" ? findingsFor(["pricing"]) : area === "gaps" ? gaps : [];
  const limitations = [...new Set(accepted.steps.filter((step) =>
    area === "pricing" ? step.agent === "pricing" : area === "gaps" ? step.agent === "opportunity" : false)
    .flatMap(describeStepLimitations))];
  return <section className="market-intelligence" aria-label={`Market intelligence for ${businessName}`}>
    <div className="dashboard-intro"><div>
      {area !== "overview" && <Button variant="ghost" onClick={() => navigate("overview")}><ArrowLeft />Market overview</Button>}
      <p className="section-eyebrow">UNDERSTAND THE MARKET</p>
      <h3 ref={heading} tabIndex={-1}>{selected?.label ?? "Your market, without the noise."}</h3>
      <p>{selected?.description ?? "Outside evidence here. Decisions and action plans in My growth plan."}</p>
    </div><Badge variant="outline">{area === "customer" ? customerVoiceSummary : !report.enabled ? "No market research saved" : researching ? "Research in progress" : report.status === "partial" ? "Partial research saved" : "Research saved"}</Badge></div>
    {area === "overview" ? <BlurFade duration={0.25} blur="2px">
      <Card className="market-summary"><CardHeader><CardDescription><Globe2 />{takeaway ? findingLabel(takeaway) : "YOUR MARKET RESEARCH"}</CardDescription>
        <CardTitle>{takeaway?.title ?? (brands.length ? "Brands to explore." : researching ? "Market research is still running." : !report.enabled ? "Start building your market view." : "No market findings saved yet.")}</CardTitle></CardHeader>
        <CardContent>{takeaway ? <><p>{takeaway.detail}</p><Finding finding={takeaway} /></>
          : brands.length ? brands.map((brand) => <article key={brand.url}>
            <h4>{brand.name}</h4><p>{brand.relevance}</p><SupportingEvidence sources={brand.sources} />
          </article>) : <><p>{researching ? "Your findings will appear as research progresses."
            : !report.enabled ? noBrandsDescription : "New findings will appear here when saved."}</p>
            {report.enabled && <details className="agent-sources"><summary>Research details</summary>
              <p>{noBrandsDescription}{!researching && " This does not mean your business has no competitors."}</p>
            </details>}</>}
          {!takeaway && !researching && (brands.length
            ? <Button variant="outline" onClick={() => navigate("competitors")}>Explore captured brands<ArrowRight /></Button>
            : <Button variant="outline" asChild><a href="#overview?view=business">Manage website analysis<ArrowRight /></a></Button>)}
        </CardContent>
      </Card>
      {!!additionalFindings.length && <div className="market-signals">{additionalFindings.slice(0, limit).map((finding) =>
        <Card key={`${finding.title}:${finding.detail}`}><CardHeader>
          <CardDescription>{findingLabel(finding)}</CardDescription><CardTitle>{finding.title}</CardTitle>
        </CardHeader><CardContent><p>{finding.detail}</p><Finding finding={finding} /></CardContent></Card>)}
      </div>}
      {additionalFindings.length > limit && <Button variant="outline" onClick={() => setLimit((value) => value + 6)}>Show more findings</Button>}
      <nav className="market-area-grid" aria-label="Explore market research">{areas.map((item) => {
        const AreaIcon = item.icon;
        return <Button variant="outline" key={item.id} className="market-area-link" onClick={() => navigate(item.id)}>
          <AreaIcon /><span><strong>{item.label}</strong><small>{available[item.id]}</small></span><ArrowRight />
        </Button>;
      })}</nav>
    </BlurFade> : <>
      {area === "competitors" && renderComparison(marketReport)}
      {area === "products" && <>
        {renderComparison(marketReport, ["products", "positioning"])}
      </>}
      {area === "pricing" && <>
        <p className="dashboard-notice">These are dated published claims, not a cheapest-to-most-expensive ranking. Match the exact product, pack weight, ingredients and delivered price before changing yours. Quantities, currency, tax, shipping and promotions may differ.</p>
        {renderComparison(marketReport, ["pricing", "offers"])}
      </>}
      {area === "customer" && <MarketplaceCustomerVoice />}
      {area === "trends" && <Card><CardContent className="market-data-gap">
        <Badge variant="outline">Trend data not configured</Badge>
        <h4>No trend dataset or continuous monitoring is connected.</h4>
        <p>A website snapshot cannot establish rising demand, seasonal change or a new market trend. Market Radar alerts and price-change tracking are not running.</p>
        <p>Use dated sales records in My progress to review your own changes. Market-wide trends need comparable observations over time; a single saved sample is not enough.</p>
        <Button asChild variant="outline"><a href="#progress">Review my recorded progress<ArrowRight /></a></Button>
      </CardContent></Card>}
      {area === "gaps" && <p className="dashboard-notice">Possible gaps are research hypotheses, not proven unmet demand. Evaluate a supported hypothesis in My growth plan before adding work to your plan.</p>}
      {!!findings.length && <div className="market-signals">{findings.slice(0, limit).map((finding) =>
        <Card key={`${finding.title}:${finding.detail}`}><CardHeader>
          <CardDescription>{finding.kind === "hypothesis" ? "Hypothesis / needs validation" : "Captured observation"}</CardDescription>
          <CardTitle className="dashboard-clamped">{finding.title}</CardTitle>
        </CardHeader><CardContent><p className="dashboard-clamped">{finding.detail}</p><Finding finding={finding} /></CardContent></Card>)}
      </div>}
      {findings.length > limit && <Button variant="outline" onClick={() => setLimit((value) => value + 6)}>Show more findings</Button>}
      {area === "gaps" && !findings.length && <Card><CardContent className="market-data-gap"><h4>No accepted market-gap hypothesis yet.</h4>
        <p>{researching ? "Research is still running. Accepted hypotheses will appear when saved."
          : "Missing products in a small captured sample do not establish an unmet customer need. No market gap has been invented."}</p>
      </CardContent></Card>}
      {!!limitations.length && <details className="agent-sources"><summary>Evidence gaps and research scope</summary>
        <ul>{limitations.map((text) => <li key={text}>{text}</li>)}</ul>
      </details>}
    </>}
    <div className="market-footer">
      <Button variant="ghost" asChild><a href="#growth">Choose my next move in My growth plan<ArrowRight /></a></Button>
    </div>
  </section>;
}
