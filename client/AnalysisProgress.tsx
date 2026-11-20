import { useEffect, useState } from "react";
import { activeAnalysis, type AnalysisJob } from "../shared/analysis";
import { researchAgents, researchAgentLabels, researchLimits, type ResearchStep } from "../shared/research";
import { understandingTimeoutMs } from "../shared/understanding";
import { Icon } from "./Icon";
import "./analysis-progress.css";

const phaseLabels = {
  connecting: "Connecting to your business agent...",
  scanning: "Gathering your permitted public website evidence...",
  analysing: "Writing your business briefing...",
  validating: "Checking sources and saving your briefing...",
};
const statusLabels = {
  running: "In progress", completed: "Completed", limited: "Limited evidence", failed: "Could not finish",
  pending: "Not started", waiting: "More checks pending",
};
function stepLabel(step: ResearchStep) {
  if (step.key === "discovery-plan") return "Planning a relevant market search";
  if (step.key.startsWith("discovery-search-")) return "Searching for relevant brands";
  if (step.key === "discovery") return "Selecting brand candidates to verify";
  if (step.key.startsWith("competitor-site-")) return "Reviewing potential competitors' websites";
  if (step.key.startsWith("competitor-brand-")) return "Checking which brands are relevant";
  return {
    store: "Understanding your storefront",
    competitor: "Comparing verified brand evidence",
    customer: "Checking saved customer review evidence",
    pricing: "Checking prices and product matches",
    opportunity: "Identifying supported experiments",
    growth: "Prioritising your next steps",
  }[step.agent];
}
function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function AnalysisProgress({ job, phase, reusingScan, showDetails, onCancel }: {
  job: AnalysisJob | null; phase: AnalysisJob["phase"]; reusingScan: boolean;
  showDetails: boolean; onCancel: () => void;
}) {
  const [openedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const research = job?.research;
  const steps = research?.steps ?? [];
  const ordered = [...steps].sort((a, b) => Number(b.status === "running") - Number(a.status === "running")
    || Date.parse(b.completedAt ?? b.startedAt) - Date.parse(a.completedAt ?? a.startedAt));
  const running = ordered.filter((step) => step.status === "running");
  const hasFailedChecks = steps.some((step) => step.status === "failed");
  const queued = job?.status === "queued";
  const headline = queued ? "Waiting to start..." : running.length ? stepLabel(running[0])
    : steps.length ? steps.some((step) => step.key === "growth" && step.status !== "running")
      ? "Preparing your saved results..." : "Coordinating the next research step..."
    : phaseLabels[phase];
  const findings = steps.flatMap((step) => step.findings);
  const sources = new Set(steps.flatMap((step) => [
    ...step.findings.flatMap((finding) => finding.sources.map((source) => source.url)),
    ...(step.profile?.sources.map((source) => source.url) ?? []),
  ]));
  const since = job ? Date.parse(job.createdAt) : openedAt;
  const quiet = !!job && now - Date.parse(job.updatedAt) >= 45_000;
  return <section className="analysis-activity" aria-label="Live agent activity">
    <div className="analysis-activity-heading">
      <span className="analysis-beacon" aria-hidden="true"><Icon name="spark" /></span>
      <div><p className="section-eyebrow">LIVE AGENT ACTIVITY</p>
        <span className="analysis-elapsed" aria-live="off">{duration(now - since)} since {job ? "requested" : "connecting"}</span></div>
    </div>
    <div className="agent-progress">
      <p role="status" aria-atomic="true">{headline}</p>
      {job && activeAnalysis(job) && <button className="text-button" type="button" onClick={onCancel}>Cancel analysis</button>}
    </div>
    <p className="analysis-activity-note">{queued ? "Your request is saved. Research has not started yet."
      : "Your findings will appear as the research progresses."}</p>
    {quiet && <p className="analysis-quiet">No recent update. You can keep waiting or cancel the analysis.</p>}
    {!!steps.length && research && <>
      <dl className="analysis-counts" aria-label="Recorded research activity">
        <div><dt>Sources</dt><dd>{sources.size}</dd></div>
        <div><dt>Findings</dt><dd>{findings.length}</dd></div>
      </dl>
      <ol className="analysis-stages" aria-label="Research specialists">
        {researchAgents.filter((agent) => research.enabled || steps.some((step) => step.agent === agent)).map((agent) => {
          const own = steps.filter((step) => step.agent === agent);
          const final = own.find((step) => step.key === agent);
          const status = own.some((step) => step.status === "running") ? "running"
            : final ? final.status : own.length ? "waiting" : "pending";
          return <li key={agent} data-status={status}>
            <span className="analysis-stage-mark" aria-hidden="true">{status === "completed" ? <Icon name="check" /> : <span />}</span>
            <div><strong>{researchAgentLabels[agent]}</strong><span>{statusLabels[status]}</span></div>
          </li>;
        })}
      </ol>
      {hasFailedChecks && <p className="analysis-check-failure" role="status">Some information couldn't be checked. Please review the available findings before deciding.</p>}
    </>}
    {!steps.length && !queued && <div className="analysis-starting"><Icon name="shield" /><p>{reusingScan
      ? "Using your saved website information." : "Checking your website's permitted public pages."}</p></div>}
    {job && <p className="analysis-background"><Icon name="history" />Your analysis continues if you leave this page.</p>}
    {showDetails && <details className="agent-sources agent-progress-details"><summary>Analysis details</summary>
      <p>{reusingScan ? "Using saved website information." : "Reading public website information."} This can take up to {(job ? researchLimits.milliseconds : understandingTimeoutMs) / 60_000} minutes once started.
        {" "}Optional profile changes still need your approval. Supported website products may be saved to your catalogue.</p>
    </details>}
  </section>;
}
