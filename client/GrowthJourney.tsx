import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, Circle, Compass, Plus } from "lucide-react";
import { businessesSchema, type Business } from "../shared/contracts";
import { growthResponseSchema, type GrowthResponse } from "../shared/growth";
import { productsResponseSchema, type Product } from "../shared/products";
import { api, ApiFailure, errorMessage } from "./api";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { WeeklyGrowthReview } from "./WeeklyGrowthReview";
import "./journey.css";

const stages = [
  { section: "business", verb: "Understand" },
  { section: "intelligence", verb: "Discover" },
  { section: "growth", verb: "Decide" },
  { section: "actions", verb: "Act" },
  { section: "progress", verb: "Review" },
] as const;

export function journeyLink(section: string, businessId: string, actionId?: string) {
  const query = new URLSearchParams(section === "business" ? { view: "business", business: businessId } : { business: businessId });
  if (actionId) query.set("action", actionId);
  return `#${section === "business" ? "overview" : section}?${query}`;
}

export function GrowthJourney({ section, selectedBusinessId, onBusinessSelected, onSessionExpired, revision = 0, setup, profile, view = "" }: {
  section: string; selectedBusinessId?: string;
  onBusinessSelected: (id: string) => void; onSessionExpired: () => void;
  revision?: number;
  setup?: ReactNode; profile?: ReactNode; view?: string;
}) {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [snapshot, setSnapshot] = useState<{ businessId: string; products: Product[]; growth: GrowthResponse } | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const selection = useRef({ id: selectedBusinessId, onSelected: onBusinessSelected });
  selection.current = { id: selectedBusinessId, onSelected: onBusinessSelected };
  const business = businesses.find((item) => item.id === selectedBusinessId);
  const home = section === "overview";
  const progress = section === "progress";
  const showProfile = home && view === "business";
  const showSetup = home && !showProfile && (view === "setup" || !businesses.length) && !!setup;
  const dashboard = home && !showProfile && !showSetup;
  const needsSnapshot = dashboard || progress;

  function report(error: unknown, update: (message: string) => void) {
    if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
    else update(errorMessage(error));
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError("");
    void api("/api/businesses", businessesSchema, { signal: controller.signal }).then(({ businesses }) => {
      if (controller.signal.aborted) return;
      setBusinesses(businesses);
      if (selection.current.id === undefined && businesses[0]) selection.current.onSelected(businesses[0].id);
      else if (selection.current.id && !businesses.some((item) => item.id === selection.current.id)) {
        setLoadError("This business is not available in your account. Choose another business to continue.");
      }
    }).catch((error: unknown) => { if (!controller.signal.aborted) report(error, setLoadError); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [section, selectedBusinessId, reload, onSessionExpired]);
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null); setError("");
    if (!business || !needsSnapshot) { setReading(false); return; }
    setReading(true);
    void Promise.all([
      api(`/api/businesses/${business.id}/products`, productsResponseSchema, { signal: controller.signal }),
      api(`/api/businesses/${business.id}/growth`, growthResponseSchema, { signal: controller.signal }),
    ]).then(([catalogue, growth]) => {
      if (!controller.signal.aborted) setSnapshot({ businessId: business.id, products: catalogue.products, growth });
    }).catch((error: unknown) => { if (!controller.signal.aborted) report(error, setError); })
      .finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [business?.id, section, needsSnapshot, reload, revision, onSessionExpired]);

  const saved = snapshot?.businessId === business?.id ? snapshot : null;
  const growth = saved?.growth;
  const active = growth?.plan.filter((item) => item.status !== "dismissed") ?? [];
  const completed = active.filter((item) => item.status === "completed");
  const pending = active.filter((item) => item.status !== "completed");
  const next = pending.find((item) => item.status === "in_progress") ?? pending[0];
  const statuses = [
    business ? "Profile saved" : "Add your business",
    !growth ? "Not loaded" : ({ unavailable: "No saved research", running: "Research running", partial: "Partial research saved", complete: "Research saved" })[growth.researchStatus],
    !growth ? "Not loaded" : growth.plan.length ? "Plan saved" : growth.opportunities.length ? "Ready to review" : "Needs evidence",
    !growth ? "Not loaded" : active.some((item) => item.status !== "planned") ? "Work recorded" : "Not started",
    !growth ? "Not loaded" : completed.length ? "Owner updates available" : "No completed actions yet",
  ];
  const recorded = [!!business, growth?.researchStatus === "complete", !!growth?.plan.length,
    active.some((item) => item.status !== "planned"), completed.length > 0];
  const nextMove = !business ? { title: "Start with your business.", detail: "Have a website? Your agent can use it. If not, add your business and products manually.", label: "Add my business", href: "#overview?view=setup&new=1" }
    : !saved ? null
      : next ? { title: next.opportunity.title, detail: "Continue your saved plan. Review the evidence and choose the work you want to do.", label: "Continue this action", href: journeyLink("actions", business.id, next.opportunity.id) }
        : growth?.opportunities.some((item) => !growth.plan.some((entry) => entry.opportunity.id === item.id))
          ? { title: "Choose the opportunity worth acting on.", detail: "Your saved research has suggestions. Review their sources before adding one to your plan.", label: "Review opportunities", href: journeyLink("growth", business.id) }
          : !saved.products.length ? { title: "Give what you sell a place.", detail: "Website discoveries appear automatically. Add a missed product manually, or use the optional CSV tools.", label: "Open my catalogue", href: journeyLink("products", business.id) }
            : completed.length ? { title: "Review your work. Choose the next move.", detail: "Completed actions are owner-reported progress, not proof of increased sales. Review the evidence before your next decision.", label: "Review my progress", href: journeyLink("progress", business.id) }
              : { title: "Discover what matters in your market.", detail: "Explore saved evidence, its limitations and customer signals. Starting new research is a separate, explicit action.", label: "Explore my market", href: journeyLink("intelligence", business.id) };

  return <section className="growth-journey" aria-label="Your growth journey">
    <div className="journey-toolbar">
      <div className="journey-business">
        <label>Active business<select aria-label="Active business" value={business?.id ?? ""} disabled={loading} onChange={(event) => {
          setLoadError(""); onBusinessSelected(event.target.value);
          const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
          query.set("business", event.target.value);
          query.delete("action"); query.delete("product"); query.delete("import"); query.delete("new"); query.delete("view");
          window.location.hash = `#${section}?${query}`;
        }}><option value="" disabled>{loading ? "Loading businesses..." : "Choose a business"}</option>
          {businesses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <Button variant="outline" aria-label="Add a business" onClick={() => {
          onBusinessSelected(""); window.location.hash = "#overview?view=setup&new=1";
        }}><Plus /><span>Add business</span></Button>
      </div>
    </div>
    {loadError && <p role="alert" className="form-error">{loadError} <button type="button" className="text-button" onClick={() => setReload((value) => value + 1)}>Reload journey</button></p>}
    {error && <p role="alert" className="form-error">Your saved journey could not be loaded: {error} <button type="button" className="text-button" onClick={() => setReload((value) => value + 1)}>Retry saved progress</button></p>}
    {showProfile && !loadError && profile}
    {(home || progress) && loading && <p role="status">Loading your saved journey...</p>}
    {(home || progress) && !loading && !loadError && <>
      {reading && <p role="status">Reading saved catalogue and plan...</p>}
      {showSetup && !loadError && setup}
      {dashboard && nextMove && !error && <Card className="journey-next">
        <CardHeader><CardDescription><Compass /> YOUR NEXT STEP{business ? ` / ${business.name}` : ""}</CardDescription>
          <CardTitle><h2>{nextMove.title}</h2></CardTitle></CardHeader>
        <CardContent><p>{nextMove.detail}</p><Button asChild><a href={nextMove.href}>{nextMove.label}<ArrowRight /></a></Button>
          <p className="field-note">Browsing does not start scans or paid AI analysis. Nothing is published automatically.</p></CardContent>
      </Card>}
      {(dashboard || progress) && saved && <div className="journey-summary" aria-label="Saved journey summary">
        <Card><CardContent><strong>{saved.products.length}</strong><span>Catalogue products</span></CardContent></Card>
        <Card><CardContent><strong>{pending.length}</strong><span>Open plan actions</span></CardContent></Card>
        <Card><CardContent><strong>{completed.length}</strong><span>Owner-marked complete</span></CardContent></Card>
      </div>}
      {dashboard && business && <nav className="journey-stages" aria-label="Growth journey stages">
        {stages.map((stage, index) => <a key={stage.section} href={journeyLink(stage.section, business.id)}>
          <span className="journey-stage-number">{recorded[index] ? <CheckCircle2 aria-label="Saved record available" /> : String(index + 1).padStart(2, "0")}</span>
          <span><strong>{stage.verb}</strong><small>{loading || reading ? "Loading saved progress..." : statuses[index]}</small></span>
        </a>)}
      </nav>}
      {progress && business && saved && !error && <WeeklyGrowthReview key={business.id}
        businessId={business.id} plan={saved.growth.plan} expanded onSessionExpired={onSessionExpired} />}
      {progress && business && saved && <section className="journey-review" aria-labelledby="journey-review-heading">
        <h2 id="journey-review-heading">Your work so far.</h2>
        <p>These are your saved planning updates, not measured business growth. Marking an action complete does not verify its outcome.</p>
        {!growth?.plan.length ? <Card><CardContent><h3>No actions saved yet.</h3><p>Choose an evidence-backed opportunity before tracking your work.</p>
          <Button asChild><a href={journeyLink("growth", business.id)}>Choose my next move<ArrowRight /></a></Button></CardContent></Card>
          : <ul className="journey-action-list">{growth.plan.map((item) => <li key={item.opportunity.id}>
            <span>{item.status === "completed" ? <CheckCircle2 /> : <Circle />}</span>
            <div><a href={journeyLink("actions", business.id, item.opportunity.id)}>{item.opportunity.title}<ArrowRight /></a>
              <p>{({ planned: "Planned", in_progress: "In progress", completed: "Marked complete by you", dismissed: "Dismissed" })[item.status]} · Updated <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString()}</time></p></div>
          </li>)}</ul>}
        <Card className="journey-results"><CardHeader><CardTitle><h3>Did your business improve?</h3></CardTitle></CardHeader>
          <CardContent><p>Action status alone cannot answer this. Review your imported sales or owner-entered records separately; what-if projections are not actual results. Automatic campaign attribution is not available.</p>
            <div className="journey-actions"><Button asChild variant="outline"><a href={`${journeyLink("simulator", business.id)}&view=sales`}>Review my sales records<ArrowRight /></a></Button>
              <Button asChild variant="ghost"><a href={journeyLink("activity", business.id)}>View saved activity<ArrowRight /></a></Button>
              <Button asChild variant="ghost"><a href={journeyLink("growth", business.id)}>Choose my next move<ArrowRight /></a></Button></div></CardContent></Card>
      </section>}
      {progress && !business && <Card><CardContent><h2>Start with your business.</h2><p>Save a profile to build a plan and review its progress.</p><Button asChild><a href="#overview?view=setup&new=1">Add my business<ArrowRight /></a></Button></CardContent></Card>}
    </>}
  </section>;
}
