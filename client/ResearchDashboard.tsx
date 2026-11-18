import { ArrowRight, BookOpen, Lightbulb, Search, Sparkles } from "lucide-react";
import { type ResearchAgent, type ResearchReport } from "../shared/research";
import type { BriefingPreview } from "../shared/understanding";
import { SupportingEvidence, type BriefingEvidence } from "./BusinessBriefing";
import { Badge } from "./components/ui/badge";
import { BlurFade } from "./components/ui/blur-fade";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./components/ui/sheet";

export type ResearchView = "overview" | "intelligence";
type Sources = NonNullable<BriefingEvidence["summary"]>["sources"];
type Recommendation = { key: string; agent: ResearchAgent; title: string; detail: string; sources: Sources };
type Props = {
  report?: ResearchReport;
  briefing?: BriefingPreview | null;
  evidence?: BriefingEvidence;
  retainedAt?: string;
};

function recommendations({ report, briefing, evidence }: Props): Recommendation[] {
  const items: Recommendation[] = report?.steps.flatMap((step) => step.findings.filter((finding) => finding.kind === "suggestion")
    .map((finding) => ({ key: `${step.key}:${finding.title}:${finding.detail}`, agent: step.agent, ...finding }))) ?? [];
  if (evidence) briefing?.nextSteps?.forEach((step, index) => {
    if (step.action) items.push({ key: `briefing:${index}:${step.action}`, agent: "store", title: step.action, detail: step.reason ?? "", sources: [] });
  });
  return [...new Map(items.map((item) => [`${item.title.trim().toLowerCase()}:${item.detail.trim().toLowerCase()}`, item])).values()];
}

function Detail({ title, detail, sources, label = "Read finding", kind }: {
  title: string; detail?: string; sources: Sources; label?: string; kind: string;
}) {
  return <Sheet><SheetTrigger asChild><Button variant="outline" className="dashboard-detail-trigger">{label}<ArrowRight /></Button></SheetTrigger>
    <SheetContent className="research-drawer">
      <SheetHeader><p className="section-eyebrow">{kind}</p><SheetTitle>{title}</SheetTitle>
        <SheetDescription>Based on captured public information. Review the evidence before acting.</SheetDescription></SheetHeader>
      <div className="research-drawer-body">{detail && <p>{detail}</p>}
        {sources.length ? <SupportingEvidence sources={sources} /> : <p className="field-note">A suggested check, not an established fact or a change already made.</p>}
      </div>
    </SheetContent>
  </Sheet>;
}

export function ResearchOverview(props: Props & { report: ResearchReport; businessName: string; onNavigate: (view: ResearchView) => void }) {
  const { report, briefing, evidence, retainedAt, businessName, onNavigate } = props;
  const findings = report.steps.flatMap((step) => step.findings);
  const observation = findings.find((finding) => finding.kind === "observation");
  const insight = evidence ? briefing?.insights?.find((item) => item.text) : undefined;
  const insightIndex = insight ? briefing?.insights?.indexOf(insight) : undefined;
  const title = insight?.text ?? observation?.title ?? (evidence ? briefing?.summary?.text : undefined);
  const detail = insight ? insight.whyItMatters : observation?.detail;
  const sources = insightIndex !== undefined ? evidence?.insights?.[insightIndex]?.sources ?? []
    : observation?.sources ?? evidence?.summary?.sources ?? [];
  const next = recommendations(props)[0];
  const brands = report.steps.filter((step) => step.profile).length;
  return <BlurFade duration={0.3} blur="3px" className="research-overview" role="region" aria-label={`Overview for ${businessName}`}>
    <div className="dashboard-intro"><div><p className="section-eyebrow">YOUR BUSINESS AT A GLANCE</p>
      <h3>What matters now.</h3></div>
      <Badge variant="outline">{report.status === "running" ? "Research in progress" : report.status === "partial" ? "Partial research saved" : "Research saved"}</Badge>
    </div>
    {retainedAt && <p className="dashboard-notice" role="status">Showing the last successful Store briefing, saved on <time dateTime={retainedAt}>{new Date(retainedAt).toLocaleString()}</time>. The latest attempt has not replaced it.</p>}
    <div className="dashboard-section-cards">
      <Card className="dashboard-takeaway"><CardHeader><CardDescription><Sparkles />WHAT STANDS OUT</CardDescription>
        <CardTitle>{title ? <span className="dashboard-clamped">{title}</span> : report.status === "running" ? "Your first supported finding will appear here." : "Not enough evidence for a conclusion yet."}</CardTitle></CardHeader>
        <CardContent>{detail && <p className="dashboard-clamped">{detail}</p>}
          {title ? <Detail title={title} detail={detail} sources={sources} kind="Website observation" />
            : <p>Open Market intelligence to see what was captured and what could not be established.</p>}
        </CardContent>
      </Card>
      <Card className="dashboard-next-move"><CardHeader><CardDescription><Lightbulb />ONE NEXT MOVE</CardDescription>
        <CardTitle><span className="dashboard-clamped">{next?.title ?? "Gather evidence before choosing a move."}</span></CardTitle></CardHeader>
        <CardContent>{next ? <><p className="dashboard-clamped">{next.detail}</p><Detail title={next.title} detail={next.detail} sources={next.sources} kind="Suggested next move" label="Explore this move" /></>
          : <p>No accepted recommendation is available yet. Missing evidence is not proof of a business problem.</p>}
          <p className="field-note">A recommendation, not an action already taken.</p>
        </CardContent>
      </Card>
    </div>
    <div className="dashboard-paths">
      <Button variant="ghost" asChild><a href="#growth"><Lightbulb /><span>Build your growth plan<small>Review recommendations and decide what to do next</small></span><ArrowRight /></a></Button>
      <Button variant="ghost" onClick={() => onNavigate("intelligence")}><Search /><span>Explore market intelligence<small>{brands} verified {brands === 1 ? "brand" : "brands"} in this saved sample</small></span><ArrowRight /></Button>
    </div>
    <p className="field-note"><BookOpen className="inline size-3.5" /> Public evidence, not business-performance analytics. No new analysis runs when you browse.</p>
  </BlurFade>;
}
