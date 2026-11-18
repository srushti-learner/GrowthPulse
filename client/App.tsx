import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { Icon } from "./Icon";
import { WorkflowPreview } from "./WorkflowPreview";
import { healthSchema, sessionSchema, type User } from "../shared/contracts";
import { api, ApiFailure, errorMessage } from "./api";
import { AuthForm } from "./AuthForm";
import { BusinessWorkspace } from "./BusinessWorkspace";
import { WebsiteWorkspace } from "./WebsiteWorkspace";
import { ProductsWorkspace } from "./ProductsWorkspace";
import { FirstVisit } from "./FirstVisit";
import { GrowthJourney } from "./GrowthJourney";
const AnalyticsWorkspace = lazy(() => import("./AnalyticsWorkspace").then((module) => ({ default: module.AnalyticsWorkspace })));
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar,
} from "./components/ui/sidebar";

const sections = [
  { id: "overview", label: "My growth journey", icon: "overview", description: "Your business, your progress, and one useful next step." },
  { id: "business", label: "My business", icon: "box", description: "Start with what you know. Review what your agent discovers." },
  { id: "website", label: "Website", icon: "globe", description: "Understand your website's customer experience.", checkpoint: 4 },
  { id: "products", label: "Products", icon: "box", description: "Your working catalogue. Review a product, improve its details, and keep the evidence in view.", checkpoint: 5 },
  { id: "whatsapp", label: "WhatsApp Insights", icon: "chat", description: "Discover what your customers are asking.", checkpoint: 7 },
  { id: "growth", label: "My growth plan", icon: "spark", description: "Turn saved evidence into a decision. Choose your next move, then work on your plan." },
  { id: "actions", label: "My actions", icon: "sliders", description: "Work through your chosen actions, review the next steps, and record your progress." },
  { id: "intelligence", label: "Market intelligence", icon: "chart", description: "Explore the evidence behind your next move." },
  { id: "simulator", label: "Growth Simulator", icon: "chart", description: "Your sales history. Your assumptions. A separate what-if, for every sales channel." },
  { id: "progress", label: "My progress", icon: "check", description: "Review your saved actions. Separate work completed from results measured." },
  { id: "improvements", label: "Improvements", icon: "sliders", description: "Review changes before anything is applied.", checkpoint: 10 },
  { id: "activity", label: "Activity History", icon: "history", description: "See what changed and why.", checkpoint: 2 },
] as const;

type Connection = { state: "checking" } | { state: "connected" } | { state: "error"; message: string };
type Session = { state: "loading" } | { state: "anonymous" } | { state: "authenticated"; user: User } | { state: "error"; message: string };

function WorkspaceNavigation({ active, businessId }: { active: typeof sections[number]["id"]; businessId?: string }) {
  const { setOpenMobile } = useSidebar();
  const planned = new Set(["whatsapp", "improvements"]);
  function links(ids: string[]) {
    return <SidebarMenu>{ids.map((id) => {
      const section = sections.find((item) => item.id === id)!;
      return <SidebarMenuItem key={id}><SidebarMenuButton asChild isActive={active === id}>
        <a href={`#${id}${businessId ? `?business=${encodeURIComponent(businessId)}` : ""}`} aria-current={active === id ? "page" : undefined} onClick={() => setOpenMobile(false)}>
          <Icon name={section.icon} /><span>{section.label}</span>
        </a>
      </SidebarMenuButton></SidebarMenuItem>;
    })}</SidebarMenu>;
  }
  return <nav className="dashboard-navigation" aria-label="Main navigation">
    <p className="nav-caption">YOUR GROWTH JOURNEY</p>{links(["overview", "business", "intelligence", "growth", "actions", "progress"])}
    <p className="nav-caption">EVIDENCE & TOOLS</p>{links(["products", "website", "simulator", "activity"])}
    <details className="planned-navigation" open={planned.has(active)}><summary>Planned tools</summary>{links(["whatsapp", "improvements"])}</details>
  </nav>;
}

function sectionFromHash() {
  const hash = window.location.hash.replace(/^#opportunities(?=\?|$)/, "#growth");
  return sections.find((section) => section.id === hash.slice(1).split("?")[0]) ?? sections[0];
}

export function App() {
  const [activeSection, setActiveSection] = useState(sectionFromHash);
  const [connection, setConnection] = useState<Connection>({ state: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [startBriefing, setStartBriefing] = useState(false);
  const [onboardingJourney, setOnboardingJourney] = useState(false);
  const [useSavedOverview, setUseSavedOverview] = useState(false);
  const [journeyRevision, setJourneyRevision] = useState(0);
  const onPlanSaved = useCallback(() => setJourneyRevision((value) => value + 1), []);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | undefined>(() => {
    const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    return query.get("new") === "1" ? "" : query.get("business") ?? undefined;
  });
  const showJourney = session.state === "authenticated"
    && (activeSection.id !== "overview" || (!onboardingJourney && useSavedOverview));
  const onSessionExpired = useCallback(() => {
    setSession({ state: "anonymous" }); setOnboardingJourney(false); setStartBriefing(false); setSelectedBusinessId(undefined); setUseSavedOverview(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSession({ state: "loading" });
    void api("/api/auth/me", sessionSchema, { signal: controller.signal }).then(({ user }) => {
      if (!controller.signal.aborted) setSession({ state: "authenticated", user });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setSession(error instanceof ApiFailure && error.status === 401 ? { state: "anonymous" } : { state: "error", message: errorMessage(error) });
    });
    return () => controller.abort();
  }, [sessionAttempt]);

  async function logout() {
    setLogoutPending(true);
    setLogoutError("");
    try {
      await api("/api/auth/logout", z.undefined(), { method: "POST" });
      setSession({ state: "anonymous" });
      setOnboardingJourney(false); setStartBriefing(false); setSelectedBusinessId(undefined);
      setUseSavedOverview(false);
    } catch (error) { setLogoutError(errorMessage(error)); }
    finally { setLogoutPending(false); }
  }

  useEffect(() => {
    const onHashChange = () => {
      if (/^#opportunities(?:\?|$)/.test(window.location.hash)) {
        window.history.replaceState(null, "", window.location.hash.replace("#opportunities", "#growth"));
      }
      const section = sections.find((item) => item.id === window.location.hash.slice(1).split("?")[0]);
      if (section) {
        const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
        if (query.get("new") === "1") setSelectedBusinessId("");
        else if (query.has("business")) setSelectedBusinessId(query.get("business") ?? "");
        setActiveSection(section);
        if (section.id !== "overview") { setOnboardingJourney(false); setStartBriefing(false); }
      }
    };
    window.addEventListener("hashchange", onHashChange);
    onHashChange();
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
    <SidebarProvider className="app-shell dashboard-shell">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Sidebar variant="inset" className="gp-sidebar">
        <SidebarHeader>
        <a href="#overview" className="brand" aria-label="GrowthPulse overview">
          <span className="brand-mark"><Icon name="pulse" /></span>
          GrowthPulse
        </a>
        <div className="workspace-identity"><span className="workspace-avatar">{session.state === "authenticated" ? session.user.name.slice(0, 1).toUpperCase() : "G"}</span><span>{session.state === "authenticated" ? session.user.name : "My workspace"}<small>Business workspace</small></span></div>
        </SidebarHeader>
        <SidebarContent><WorkspaceNavigation active={activeSection.id} businessId={selectedBusinessId} /></SidebarContent>
        <SidebarFooter>
        <div className="session-actions">{session.state === "authenticated"
          ? <button className="secondary-button" type="button" disabled={logoutPending} onClick={() => void logout()}>{logoutPending ? "Logging out..." : "Log out"}</button>
          : <a className="secondary-button" href="#business">Log in / Sign up</a>}</div>
        <div className="sidebar-note">
          <Icon name="shield" />
          <p>Your business. Your final call.</p>
          <span>No changes without your approval.</span>
        </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="workspace">
        <header className="topbar">
          <div className="topbar-navigation"><SidebarTrigger /><span className="breadcrumbs"><span>Workspace</span><span className="breadcrumb-divider">/</span><span className="breadcrumb">{activeSection.label}</span></span></div>
          <span className="workspace-promise"><Icon name="shield" />You stay in control</span>
        </header>
        <main id="main-content" tabIndex={-1}>
          {logoutError && <p className="form-error" role="alert">{logoutError}</p>}
          <div className="page-heading">
            <div>
              <p className="section-eyebrow">LESS NOISE. MORE DIRECTION.</p>
              <h1>{activeSection.id === "overview" ? session.state === "authenticated" && !onboardingJourney ? "Your business. Your next chapter." : <>Big picture.<br /><span>Better next move.</span></> : activeSection.label}</h1>
              <p className="page-description">{activeSection.id === "overview" ? "One place to understand your business. And what to do next." : activeSection.description}</p>
            </div>
          </div>
          {showJourney && <GrowthJourney section={activeSection.id} selectedBusinessId={selectedBusinessId}
            onBusinessSelected={setSelectedBusinessId} onSessionExpired={onSessionExpired} revision={journeyRevision} />}
          {activeSection.id === "overview" ? (
            <>
              {session.state === "loading" ? <p className="loading-message">Checking your session...</p>
                : session.state === "error" ? <p role="alert" className="form-error">{session.message} <button className="text-button" onClick={() => setSessionAttempt((value) => value + 1)}>Retry session</button></p>
                  : session.state === "authenticated" && !onboardingJourney && useSavedOverview
                    ? null
                    : <FirstVisit key={session.state === "authenticated" ? session.user.id : "public"}
                    authenticated={session.state === "authenticated"} startBriefing={startBriefing}
                    onNoPreview={() => setUseSavedOverview(true)}
                    onAuthenticated={(user, continueBriefing) => { setStartBriefing(continueBriefing); setOnboardingJourney(continueBriefing); setSession({ state: "authenticated", user }); }}
                    onStarted={() => setStartBriefing(false)} onSessionExpired={onSessionExpired} />}
              {session.state === "anonymous" && <details id="workflow-preview" className="workflow-explainer"><summary>Explore the wider workflow (illustrative preview)</summary><WorkflowPreview /></details>}
            </>
          ) : activeSection.id === "website" ? (
            session.state === "loading" ? <p className="loading-message">Checking your session...</p>
              : session.state === "error" ? <p role="alert" className="form-error">{session.message} <button className="text-button" onClick={() => setSessionAttempt((value) => value + 1)}>Retry session</button></p>
                : <WebsiteWorkspace key={`${session.state === "authenticated" ? session.user.id : "public"}:${selectedBusinessId ?? ""}`}
                  authenticated={session.state === "authenticated"} onSessionExpired={onSessionExpired}
                  selectedBusinessId={selectedBusinessId} onBusinessSelected={setSelectedBusinessId} businessManaged={showJourney} />
          ) : activeSection.id === "business" || activeSection.id === "activity" || activeSection.id === "products" || activeSection.id === "intelligence" || activeSection.id === "growth" || activeSection.id === "actions" || activeSection.id === "simulator" || activeSection.id === "progress" ? (
            session.state === "loading" ? <p className="loading-message">Checking your session...</p>
              : session.state === "error" ? <p role="alert" className="form-error">{session.message} <button className="text-button" onClick={() => setSessionAttempt((value) => value + 1)}>Retry session</button></p>
                : session.state === "anonymous" ? <AuthForm onAuthenticated={(user) => setSession({ state: "authenticated", user })} />
                  : activeSection.id === "progress" ? null
                  : activeSection.id === "simulator" ? <Suspense fallback={<p role="status">Loading your simulator...</p>}>
                    <AnalyticsWorkspace key={session.user.id} studio onSessionExpired={onSessionExpired}
                      selectedBusinessId={selectedBusinessId} onBusinessSelected={setSelectedBusinessId} businessManaged />
                  </Suspense>
                  : activeSection.id === "products" ? <ProductsWorkspace key={session.user.id} onSessionExpired={onSessionExpired}
                    selectedBusinessId={selectedBusinessId} onBusinessSelected={setSelectedBusinessId} businessManaged />
                    : <BusinessWorkspace key={session.user.id} activityOnly={activeSection.id === "activity"}
                      profileOnly={activeSection.id === "business"}
                      growthOnly={activeSection.id === "growth" || activeSection.id === "actions"}
                      actionOnly={activeSection.id === "actions"}
                      researchOnly={activeSection.id === "intelligence" || activeSection.id === "growth"}
                      researchView={activeSection.id === "intelligence" ? "intelligence" : "overview"}
                      selectedBusinessId={selectedBusinessId} onBusinessSelected={setSelectedBusinessId}
                      onSessionExpired={onSessionExpired} businessManaged onPlanSaved={onPlanSaved} />
          ) : (
            <section className="empty-state" aria-labelledby="upcoming-heading">
              <span className="empty-symbol"><Icon name={activeSection.icon} /></span>
              <p className="section-eyebrow">COMING SOON</p>
              <h2 id="upcoming-heading">The next piece of the picture.</h2>
              <p>This module is not implemented yet. Agent-led business onboarding, website evidence, and the product catalogue are available. Later analysis modules remain planned.</p>
              <a href="#website" className="text-button">Open website scanner <Icon name="arrow" /></a><br />
              <a href="#overview" className="primary-link">Back to overview <Icon name="arrow" /></a>
            </section>
          )}
          {connection.state === "error" && <section className="status-card" aria-labelledby="status-heading" role="alert">
            <div className="status-copy">
              <span className="status-dot error" aria-hidden="true" />
              <div><h2 id="status-heading">Connection unavailable.</h2>
                <p>{connection.message}</p>
              </div>
            </div>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>Check again <Icon name="arrow" /></button>
          </section>}
          <footer><span>GROWTHPULSE <span className="footer-divider">/</span> BUILT ON EVIDENCE.</span><span>A little clarity goes a long way.</span></footer>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
