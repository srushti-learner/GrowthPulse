import { useEffect, useState } from "react";
import { z } from "zod";
import { Icon } from "./Icon";
import { WorkflowPreview } from "./WorkflowPreview";

const sections = [
  { id: "overview", label: "Overview", icon: "overview", description: "Your business, with a clearer direction." },
  { id: "website", label: "Website", icon: "globe", description: "Understand your website's customer experience.", checkpoint: 4 },
  { id: "products", label: "Products", icon: "box", description: "Bring your product information together.", checkpoint: 5 },
  { id: "whatsapp", label: "WhatsApp Insights", icon: "chat", description: "Discover what your customers are asking.", checkpoint: 7 },
  { id: "opportunities", label: "Opportunities", icon: "spark", description: "Turn business evidence into a next step.", checkpoint: 8 },
  { id: "simulator", label: "Growth Simulator", icon: "chart", description: "Explore possibilities, with transparent assumptions.", checkpoint: 9 },
  { id: "improvements", label: "Improvements", icon: "sliders", description: "Review changes before anything is applied.", checkpoint: 10 },
  { id: "activity", label: "Activity History", icon: "history", description: "See what changed and why.", checkpoint: 2 },
] as const;

const healthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("growthpulse-api"),
});
type Connection = { state: "checking" } | { state: "connected" } | { state: "error"; message: string };

function sectionFromHash() {
  return sections.find((section) => section.id === window.location.hash.slice(1)) ?? sections[0];
}

export function App() {
  const [activeSection, setActiveSection] = useState(sectionFromHash);
  const [connection, setConnection] = useState<Connection>({ state: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const onHashChange = () => {
      const section = sections.find((item) => item.id === window.location.hash.slice(1));
      if (section) setActiveSection(section);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let active = true;
    setConnection({ state: "checking" });

    async function checkHealth() {
      try {
        const response = await fetch("/api/health", { signal: controller.signal });
        if (!response.ok) throw new Error(`API health check failed (HTTP ${response.status}).`);
        healthSchema.parse(await response.json());
        if (active) setConnection({ state: "connected" });
      } catch (error) {
        if (active) {
          setConnection({
            state: "error",
            message: controller.signal.aborted
              ? "The API health check timed out."
              : error instanceof Error ? error.message : "Unable to connect to the API.",
          });
        }
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void checkHealth();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <aside className="sidebar">
        <a href="#overview" className="brand" aria-label="GrowthPulse overview">
          <span className="brand-mark"><Icon name="pulse" /></span>
          GrowthPulse
        </a>
        <div className="workspace-identity"><span className="workspace-avatar">G</span><span>My workspace<small>Local development</small></span><span className="identity-chevron" aria-hidden="true">&#8964;</span></div>
        <p className="nav-caption">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`} aria-current={activeSection.id === section.id ? "page" : undefined}>
              <Icon name={section.icon} />
              {section.label}
              {section.id === "overview" && <span className="active-nav-dot" />}
            </a>
          ))}
        </nav>
        <div className="sidebar-note">
          <Icon name="shield" />
          <p>Your business.<br /><span>Your final call.</span></p>
          <span>Nothing changes without you.</span>
        </div>
        <div className="sidebar-bottom"><Icon name="code" /><span>Development build</span><span>v0.1</span></div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="breadcrumbs"><Icon name={activeSection.icon} /><span>Workspace</span><span className="breadcrumb-divider">/</span><span className="breadcrumb">{activeSection.label}</span></span>
          <span className="phase-label"><span /> PHASE 01 <span className="phase-divider">/</span> Foundation</span>
        </header>
        <main id="main-content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <p className="section-eyebrow">LESS NOISE. MORE DIRECTION.</p>
              <h1>{activeSection.id === "overview" ? <>Big picture.<br /><span>Better next move.</span></> : activeSection.label}</h1>
              <p className="page-description">{activeSection.id === "overview" ? "One place to understand your business. And what to do next." : activeSection.description}</p>
            </div>
            {activeSection.id === "overview" && <a className="primary-link" href="#workflow-preview">Explore the workflow <Icon name="diagonal" /></a>}
          </div>
          {activeSection.id === "overview" ? (
            <>
              <WorkflowPreview />
              <div className="below-workflow">
                <section className="next-card">
                  <span className="next-icon"><Icon name="plus" /></span>
                  <div><p className="section-eyebrow">UP NEXT / CHECKPOINT 02</p><h2>A home for your business.</h2><p>Business profiles, database persistence, and ownership come next. No account or business data is saved yet.</p></div>
                  <span className="planned-tag">Planned</span>
                </section>
                <section className="principle-card"><Icon name="shield" /><h2>Intelligence, not autopilot.</h2><p>Evidence behind the idea.<br />Your approval before the change.</p></section>
              </div>
            </>
          ) : (
            <section className="empty-state" aria-labelledby="upcoming-heading">
              <span className="empty-symbol"><Icon name={activeSection.icon} /></span>
              <p className="section-eyebrow">PLANNED FOR CHECKPOINT {"checkpoint" in activeSection ? String(activeSection.checkpoint).padStart(2, "0") : ""}</p>
              <h2 id="upcoming-heading">The next piece of the picture.</h2>
              <p>This module is not implemented yet. Phase 1 establishes navigation and the connection to the backend; no business data has been imported or analyzed.</p>
              <a href="#overview" className="primary-link">Back to overview <Icon name="arrow" /></a>
            </section>
          )}
          <section className="status-card" aria-labelledby="status-heading">
            <div className="status-copy">
              <span className={`status-dot ${connection.state}`} aria-hidden="true" />
              <div><h2 id="status-heading">The foundation is {connection.state === "connected" ? "connected." : connection.state === "checking" ? "connecting." : "offline."}</h2>
                <p role="status">{connection.state === "checking" ? "Checking the Express API..." : connection.state === "connected" ? "Connected to the Express API. No database or AI services are connected yet." : connection.message}</p>
              </div>
            </div>
            <button type="button" onClick={() => setAttempt((value) => value + 1)} disabled={connection.state === "checking"}>Check again <Icon name="arrow" /></button>
          </section>
          <footer><span>GROWTHPULSE <span className="footer-divider">/</span> BUILT ON EVIDENCE.</span><span>A little clarity goes a long way.</span></footer>
        </main>
      </div>
    </div>
  );
}
