import { useEffect, useState, type ReactNode } from "react";
import { Activity } from "lucide-react";
import "./analysis-progress.css";

export function WorkflowActivity({ title, message, startedAt, updatedAt, guidance, stages = [], counts = [], children }: {
  title: string; message: string; startedAt?: string; updatedAt?: string; guidance: string;
  stages?: { label: string; state: "pending" | "running" | "completed" }[];
  counts?: { label: string; value: number | string }[]; children?: ReactNode;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!startedAt && !updatedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt, updatedAt]);
  const elapsed = startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)) : null;
  const quiet = updatedAt && now - Date.parse(updatedAt) >= 45_000;
  return <section className="analysis-activity workflow-activity" aria-label={`${title} activity`}>
    <div className="analysis-activity-heading">
      <span className="analysis-beacon" aria-hidden="true"><Activity /></span>
      <div><p className="section-eyebrow">{title}</p>
        {elapsed !== null && <span className="analysis-elapsed">{Math.floor(elapsed / 60)}m {elapsed % 60}s elapsed - Not an estimate</span>}
      </div>
    </div>
    <div className="agent-progress"><p role="status">{message}</p></div>
    {quiet && <p className="analysis-quiet">No new recorded update for a while. The current step may still be working; this is not a completion estimate. Check saved status if the connection fails.</p>}
    {!!counts.length && <dl className="analysis-counts" aria-live="polite" aria-atomic="true">{counts.map((count) =>
      <div key={count.label}><dt>{count.label}</dt><dd>{count.value}</dd></div>)}</dl>}
    {!!stages.length && <ol className="analysis-stages">{stages.map((stage) =>
      <li key={stage.label} data-status={stage.state} aria-current={stage.state === "running" ? "step" : undefined}>
        <span className="analysis-stage-mark" aria-hidden="true">{stage.state === "completed" ? <span className="workflow-complete" /> : <span />}</span>
        <div><strong>{stage.label}</strong><span>{stage.state === "completed" ? "Recorded" : stage.state === "running" ? "In progress" : "Not started"}</span></div>
      </li>)}</ol>}
    {children}
    <p className="analysis-background">{guidance}</p>
  </section>;
}
