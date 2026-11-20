import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Globe2, MessageSquare, Package, Search, TrendingUp, Wallet } from "lucide-react";
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

function Finding({ finding }: { finding: ResearchFinding }) {
  return <Sheet><SheetTrigger asChild><Button variant="outline" className="market-finding-trigger">Read evidence<ArrowRight /></Button></SheetTrigger>
    <SheetContent className="research-drawer">
      <SheetHeader><p className="section-eyebrow">{finding.kind === "hypothesis" ? "Hypothesis / not established" : "Captured observation"}</p>
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
  const takeaway = external.find((finding) => finding.kind === "observation");
  const prices = brands.filter((brand) => brand.facts.some((fact) => fact.dimension === "pricing")).length;
  const products = brands.filter((brand) => brand.facts.some((fact) => fact.dimension === "products")).length;
  const available: Record<Area, string> = {
    competitors: `${brands.length} verified ${brands.length === 1 ? "brand" : "brands"}`,
    customer: customerVoiceSummary, trends: "Trend data not configured",
    pricing: `${prices} ${prices === 1 ? "brand" : "brands"} with published pricing`,
    products: `${products} ${products === 1 ? "brand" : "brands"} with product claims`,
    gaps: `${gaps.length} ${gaps.length === 1 ? "hypothesis" : "hypotheses"} to validate`,
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
    </div><Badge variant="outline">{area === "customer" ? customerVoiceSummary : report.status === "running" ? "Research in progress" : !report.enabled ? "No market research saved" : report.status === "partial" ? "Partial research saved" : "Research saved"}</Badge></div>
    {area === "overview" ? <BlurFade duration={0.25} blur="2px">
      <Card className="market-summary"><CardHeader><CardDescription><Globe2 />WHAT THE SAVED SAMPLE SHOWS</CardDescription>
        <CardTitle>{takeaway?.title ?? (report.status === "running" ? "Market research is still running." : "Not enough external evidence for a market conclusion yet.")}</CardTitle></CardHeader>
        <CardContent>{takeaway ? <><p className="dashboard-clamped">{takeaway.detail}</p><Finding finding={takeaway} /></>
          : <p>{brands.length ? `${brands.length} verified brand profiles are available to explore, but no accepted market observation supports a broader conclusion.`
            : "No verified brand profiles are available in this saved sample. This does not mean your business has no competitors."}</p>}
          {!takeaway && report.status !== "running" && (brands.length
            ? <Button variant="outline" onClick={() => navigate("competitors")}>Explore captured brands<ArrowRight /></Button>
            : <Button variant="outline" asChild><a href="#overview?view=business">Manage website analysis<ArrowRight /></a></Button>)}
          <p className="field-note">A captured sample, not the whole market or a measure of demand.</p>
        </CardContent>
      </Card>
      <nav className="market-area-grid" aria-label="Explore market research">{areas.map((item) => {
        const AreaIcon = item.icon;
        return <Button variant="outline" key={item.id} className="market-area-link" onClick={() => navigate(item.id)}>
          <AreaIcon /><span><strong>{item.label}</strong><small>{available[item.id]}</small></span><ArrowRight />
        </Button>;
      })}</nav>
    </BlurFade> : <>
      {area === "competitors" && renderComparison(marketReport)}
      {area === "products" && <>
        <p className="field-note">Published product ranges and positioning, not sales rankings, measured demand or proven catalogue gaps.</p>
        {renderComparison(marketReport, ["products", "positioning"])}
      </>}
      {area === "pricing" && <>
        <p className="dashboard-notice">These are dated published claims, not a cheapest-to-most-expensive ranking. Quantities, currency, tax, shipping and promotions may differ.</p>
        {renderComparison(marketReport, ["pricing", "offers"])}
      </>}
      {area === "customer" && <MarketplaceCustomerVoice />}
      {area === "trends" && <Card><CardContent className="market-data-gap">
        <Badge variant="outline">Trend data not configured</Badge>
        <h4>No trend dataset or continuous monitoring is connected.</h4>
        <p>A website snapshot cannot establish rising demand, seasonal change or a new market trend. Market Radar alerts and price-change tracking are not running.</p>
        <p className="field-note">Marketplace review samples are available in Customer voice, but do not establish trends. Trend analysis requires dated external sources or a licensed time series; change alerts also require repeated captures.</p>
      </CardContent></Card>}
      {area === "gaps" && <p className="dashboard-notice">Possible gaps are research hypotheses, not proven unmet demand. Evaluate a supported hypothesis in Growth intelligence before adding work to your plan.</p>}
      {!!findings.length && <div className="market-signals">{findings.slice(0, limit).map((finding) =>
        <Card key={`${finding.title}:${finding.detail}`}><CardHeader>
          <CardDescription>{finding.kind === "hypothesis" ? "Hypothesis / needs validation" : "Captured observation"}</CardDescription>
          <CardTitle className="dashboard-clamped">{finding.title}</CardTitle>
        </CardHeader><CardContent><p className="dashboard-clamped">{finding.detail}</p><Finding finding={finding} /></CardContent></Card>)}
      </div>}
      {findings.length > limit && <Button variant="outline" onClick={() => setLimit((value) => value + 6)}>Show more findings</Button>}
      {area === "gaps" && !findings.length && <Card><CardContent className="market-data-gap"><h4>No accepted market-gap hypothesis yet.</h4>
        <p>{report.status === "running" ? "Research is still running. Accepted hypotheses will appear when saved."
          : "Missing products in a small captured sample do not establish an unmet customer need. No market gap has been invented."}</p>
      </CardContent></Card>}
      {!!limitations.length && <details className="agent-sources"><summary>Evidence gaps and research scope</summary>
        <ul>{limitations.map((text) => <li key={text}>{text}</li>)}</ul>
      </details>}
    </>}
    <div className="market-footer"><p className="field-note"><BookOpen className="inline size-3.5" /> Browsing saved evidence starts no new research.</p>
      <Button variant="ghost" asChild><a href="#growth">Decide what to do in Growth intelligence<ArrowRight /></a></Button>
    </div>
  </section>;
}
