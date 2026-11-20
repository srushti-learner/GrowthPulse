import { useEffect, useRef, useState, type FormEvent } from "react";
import { activitiesSchema, businessesSchema, businessInputSchema, businessResponseSchema, evidenceResponseSchema, type Activity, type Business, type BusinessInput, type Evidence } from "../shared/contracts";
import { api, ApiFailure, errorMessage } from "./api";
import { Icon } from "./Icon";
import { BusinessAgentReview } from "./BusinessAgentReview";
import { businessAnalysisDisclosure } from "../shared/understanding";
import type { ResearchView } from "./ResearchDashboard";
import { GrowthIntelligence } from "./GrowthIntelligence";
import { SourceReference } from "./SourceDetails";
import { MarketplaceResearchProvider } from "./MarketplaceResearchContext";
import { MarketplaceCustomerVoice } from "./MarketplaceCustomerVoice";

const empty: BusinessInput = { name: "", category: "", description: "", website: "" };
function editable(business: Business): BusinessInput {
  return { name: business.name, category: business.category, description: business.description, website: business.website };
}
export function BusinessWorkspace({ activityOnly, onSessionExpired, researchView = "overview", selectedBusinessId, onBusinessSelected, profileOnly = false, researchOnly = false, growthOnly = false, actionOnly = false, businessManaged = false, onPlanSaved }: {
  activityOnly: boolean; onSessionExpired: () => void; researchView?: ResearchView;
  selectedBusinessId?: string; onBusinessSelected?: (id: string) => void;
  profileOnly?: boolean;
  researchOnly?: boolean;
  growthOnly?: boolean;
  actionOnly?: boolean;
  businessManaged?: boolean;
  onPlanSaved?: () => void;
}) {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<BusinessInput>(empty);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [detailsError, setDetailsError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [reload, setReload] = useState(0);
  const [autoStartId, setAutoStartId] = useState("");
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const savedHeading = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const selectedBusiness = businesses.find((business) => business.id === selectedId);
  const analysisVisible = analysisOpen || (!!selectedBusiness && autoStartId === selectedBusiness.id);
  const requestedSelection = useRef(selectedBusinessId);
  requestedSelection.current = selectedBusinessId;

  useEffect(() => { if (notice) savedHeading.current?.focus(); }, [notice]);
  useEffect(() => { if (editing) nameInput.current?.focus(); }, [editing]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    setError("");
    void api("/api/businesses", businessesSchema, { signal: controller.signal }).then(({ businesses }) => {
      if (controller.signal.aborted) return;
      setBusinesses(businesses);
      const selected = requestedSelection.current !== undefined
        ? businesses.find((business) => business.id === requestedSelection.current) : businesses[0];
      setSelectedId(selected?.id ?? "");
      setForm(selected ? editable(selected) : empty);
      setEditing(false);
      setAutoStartId("");
      setAnalysisOpen(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
      else setLoadError(errorMessage(error));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload, onSessionExpired]);

  useEffect(() => {
    if (selectedBusinessId === undefined || selectedBusinessId === selectedId) return;
    const selected = businesses.find((item) => item.id === selectedBusinessId);
    setSelectedId(selected?.id ?? ""); setForm(selected ? editable(selected) : empty);
    setEditing(false); setAutoStartId(""); setAnalysisOpen(false); setNotice(""); setError("");
  }, [selectedBusinessId, businesses]);

  useEffect(() => {
    const controller = new AbortController();
    setActivities([]);
    setEvidence([]);
    setDetailsError("");
    if (!activityOnly || !selectedId) { setDetailsLoading(false); return; }
    setDetailsLoading(true);
    void Promise.all([
      api(`/api/businesses/${selectedId}/activity`, activitiesSchema, { signal: controller.signal }),
      api(`/api/businesses/${selectedId}/evidence`, evidenceResponseSchema, { signal: controller.signal }),
    ]).then(([history, sources]) => {
      if (controller.signal.aborted) return;
      setActivities(history.activities);
      setEvidence(sources.evidence);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
      else setDetailsError(errorMessage(error));
    }).finally(() => { if (!controller.signal.aborted) setDetailsLoading(false); });
    return () => controller.abort();
  }, [activityOnly, selectedId, revision, onSessionExpired]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = businessInputSchema.safeParse(form);
    if (!input.success) { setError(input.error.issues.map((issue) => issue.message).join(" ")); return; }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const { business } = await api(selectedId ? `/api/businesses/${selectedId}` : "/api/businesses", businessResponseSchema, {
        method: selectedId ? "PUT" : "POST", body: JSON.stringify(input.data),
      });
      setBusinesses((current) => [...current.filter((item) => item.id !== business.id), business]);
      setSelectedId(business.id);
      onBusinessSelected?.(business.id);
      setForm(editable(business));
      setEditing(false);
      setAutoStartId(business.website ? business.id : "");
      setNotice("Your business profile is saved. You can edit it anytime.");
      setRevision((value) => value + 1);
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) onSessionExpired();
      else setError(errorMessage(error));
    } finally { setSaving(false); }
  }
  function select(id: string) {
    setAutoStartId("");
    setAnalysisOpen(false);
    setSelectedId(id);
    onBusinessSelected?.(id);
    const business = businesses.find((item) => item.id === id);
    setForm(business ? editable(business) : empty);
    setEditing(false);
    setNotice("");
    setError("");
  }

  if (loading) return <p className="loading-message">Loading your businesses...</p>;
  if (loadError) return <div className="form-error" role="alert">{loadError} <button type="button" className="text-button" onClick={() => setReload((value) => value + 1)}>Reload businesses</button></div>;
  return (
    <section className="business-workspace">
      {error && <div className="form-error" role="alert">{error}</div>}
      {!businessManaged && <div className="business-toolbar">
        <label>Business<select value={selectedId} disabled={saving} onChange={(event) => select(event.target.value)}><option value="">{growthOnly ? "Choose a business" : "New business"}</option>{businesses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {!growthOnly && !activityOnly && <button className="secondary-button new-business-button" type="button" aria-label="New business" disabled={saving} onClick={() => select("")}><Icon name="plus" /><span>New business</span></button>}
      </div>}
      {growthOnly && !selectedBusiness && <section className="profile-card"><h2>Choose a business to build its growth plan.</h2><a className="text-button" href="#overview?view=business">Manage business profiles</a></section>}
      {growthOnly && selectedBusiness && <GrowthIntelligence key={selectedBusiness.id} business={selectedBusiness} onSessionExpired={onSessionExpired} onPlanSaved={onPlanSaved} actionOnly={actionOnly} />}
      <MarketplaceResearchProvider businessId={researchOnly && researchView === "intelligence" ? selectedBusiness?.id ?? "" : ""} onSessionExpired={onSessionExpired}>
      {!growthOnly && !activityOnly && selectedBusiness?.website && (researchOnly || !editing) && (!profileOnly || analysisVisible) && <BusinessAgentReview key={selectedBusiness.id} business={selectedBusiness} autoStart={autoStartId === selectedBusiness.id}
        initialView={researchView}
        mode={researchOnly ? "research" : profileOnly ? "manage" : "full"}
        onSessionExpired={onSessionExpired} onRecorded={() => setRevision((value) => value + 1)}
        onSaved={(business) => {
          setBusinesses((current) => current.map((item) => item.id === business.id ? business : item));
          setForm(editable(business)); setAutoStartId("");
          setNotice("Your business details are saved. This analysis is complete.");
          setRevision((value) => value + 1);
        }} />}
      {!growthOnly && researchOnly && selectedBusiness && !selectedBusiness.website && <section className="profile-card">
        <h2>No website analysis for this profile yet.</h2>
        <p>You can manage this business and its products without starting an analysis.</p>
        <a className="text-button" href={`#overview?view=business&business=${selectedBusiness.id}`}>Manage business profile <Icon name="arrow" /></a>
        {researchView === "intelligence" && <MarketplaceCustomerVoice />}
      </section>}
      </MarketplaceResearchProvider>
      {researchOnly && !growthOnly && researchView === "intelligence" && selectedBusiness && !selectedBusiness.website && <section className="journey-task">
        <p className="section-eyebrow">FROM DISCOVERY TO A DECISION</p><h2>What is worth acting on?</h2>
        <p>Your growth plan brings together supported suggestions from saved research. Review the evidence and its gaps before choosing an action. Opening your plan does not run another analysis.</p>
        <a className="primary-link" href={`#growth?business=${selectedBusiness.id}`}>Next: choose my growth move<Icon name="arrow" /></a>
      </section>}
      {!growthOnly && !activityOnly && (!researchOnly || !selectedBusiness) && (
        <details className="business-profile-settings" open={profileOnly || !selectedBusiness?.website || editing || !!notice}>
          <summary>Business profile and settings</summary><div className="business-columns">
          {selectedBusiness && !editing ? (
            <section className="profile-card saved-profile" aria-labelledby="saved-profile-heading">
              <div className="saved-profile-header">
                <span className="saved-profile-icon"><Icon name="check" /></span>
                <div><p className="section-eyebrow">BUSINESS PROFILE</p><h2 id="saved-profile-heading" ref={savedHeading} tabIndex={-1}>Business profile saved</h2><p role="status">{notice || "You can edit your profile anytime."}</p></div>
              </div>
              <dl className="saved-profile-details">
                <div><dt>Business name</dt><dd>{selectedBusiness.name}</dd></div>
                <div><dt>Category</dt><dd>{selectedBusiness.category || "Not provided"}</dd></div>
                <div><dt>Website</dt><dd>{selectedBusiness.website || "Not provided"}</dd></div>
                <div><dt>Business description</dt><dd>{selectedBusiness.description || "Not provided"}</dd></div>
              </dl>
              <p className="field-note">{selectedBusiness.website ? "You choose which agent suggestions to save." : "Add a website for an agent review, or continue with manual information and CSV."}</p>
              <button className="primary-link" type="button" onClick={() => { setNotice(""); setEditing(true); }}><Icon name="sliders" />Edit profile</button>
              {profileOnly && selectedBusiness.website && <button className="secondary-button" type="button" aria-expanded={analysisVisible} onClick={() => { setAutoStartId(""); setAnalysisOpen(!analysisVisible); }}>
                {analysisVisible ? "Hide website analysis" : "Manage website analysis"}
              </button>}
              {profileOnly && <div className="journey-actions">
                <a className="text-button" href={`#overview?business=${selectedBusiness.id}`}>Back to my growth journey<Icon name="arrow" /></a>
                <a className="primary-link" href={`#intelligence?business=${selectedBusiness.id}`}>Next: understand my market<Icon name="arrow" /></a>
                <a className="text-button" href={`#products?business=${selectedBusiness.id}`}>Review what I sell<Icon name="arrow" /></a>
              </div>}
            </section>
          ) : <form className="workspace-form profile-card" onSubmit={(event) => void save(event)}>
            <div className="card-heading"><p className="section-eyebrow">LET'S GET TO KNOW YOUR BUSINESS</p><h2>{selectedId ? "Your business, in your words." : "A name. A website. We'll take it from here."}</h2><p>{selectedId ? "Review your changes before saving. Nothing is applied to your website." : "Save your profile and let your agent prepare a business review. No website? You can still add information and products yourself."}</p></div>
            <fieldset disabled={saving}>
              <legend className="sr-only">Business profile</legend>
              <label>Business name<input ref={nameInput} name="businessName" value={form.name} required minLength={2} maxLength={120} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label>Website <span className="optional-label">(optional)</span><input name="website" type="url" value={form.website} maxLength={2048} placeholder="https://example.com" onChange={(event) => setForm({ ...form, website: event.target.value })} /><span className="field-note">Used for your automatic business and competitor analysis.</span></label>
              <details className="optional-profile-details" open={!!selectedId}><summary>{selectedId ? "Review profile details" : "Add details yourself (optional)"}</summary><div>
                <label>Category <span className="optional-label">(optional)</span><input name="category" value={form.category} maxLength={120} onChange={(event) => setForm({ ...form, category: event.target.value })} /></label>
                <label>Business description <span className="optional-label">(optional)</span><textarea name="description" rows={5} value={form.description} maxLength={2000} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
              </div></details>
              {!!form.website && <>
                <p id="profile-analysis-notice" className="field-note">Saving starts your business and competitor analysis. By saving, you confirm you own this website or have permission to scan it. Provider charges may apply.</p>
                <details className="optional-profile-details"><summary>How analysis uses public data</summary><p className="field-note">{businessAnalysisDisclosure} Profile suggestions still need your approval.</p></details>
              </>}
              <div className="profile-actions">
                <button type="submit" className="primary-link" aria-describedby={form.website ? "profile-analysis-notice" : undefined}>{saving ? "Saving..." : form.website ? "Save and understand my business" : "Save business profile"}<Icon name="arrow" /></button>
                {selectedBusiness && <button className="secondary-button" type="button" onClick={() => select(selectedBusiness.id)}>Cancel</button>}
              </div>
            </fieldset>
          </form>}
          <aside className="ownership-card"><Icon name="shield" /><h2>The start of your story.</h2><p>This profile gives your workspaces a shared business context. Review suggestions before saving them, then explore your market or work on your products.</p><p className="field-note">Only your signed-in account can manage this profile. A website is optional.</p></aside>
        </div></details>
      )}
      {activityOnly && !selectedId && <div className="profile-card"><h2>Select a saved business to see its history.</h2><a href="#overview?view=setup&new=1" className="text-button">Create a business profile <Icon name="arrow" /></a></div>}
      {activityOnly && selectedId && <section className="activity-card" aria-labelledby="history-heading"><div className="card-heading"><p className="section-eyebrow">YOUR BUSINESS UPDATES</p><h2 id="history-heading">Activity history</h2><p>Your latest saved profile, product and website updates.</p></div>
        {detailsLoading ? <p className="loading-message">Loading history...</p> : detailsError ? <p role="alert" className="form-error">{detailsError} <button className="text-button" onClick={() => setRevision((value) => value + 1)}>Retry history</button></p> : activities.length === 0 ? <p>No activity recorded yet.</p> : <ol className="activity-list">{activities.map((activity) => {
          const source = evidence.find((item) => item.id === activity.evidenceId);
          const label: Record<Activity["action"], string> = { "business.created": "Business profile created", "business.updated": "Business profile updated", "website.scanned": "Website scan recorded", "product.saved": "Product saved", "products.imported": "Product import recorded" };
          return <li key={activity.id}><span className="activity-icon"><Icon name={activity.action === "website.scanned" ? "globe" : activity.action === "business.created" ? "plus" : "sliders"} /></span><div><h3>{label[activity.action]}</h3><time dateTime={activity.createdAt}>{new Date(activity.createdAt).toLocaleString()}</time>
            <p>{source?.source === "website" ? <SourceReference source="website" reference={source.reference} />
              : source?.source === "manual" ? "Changes saved to your business profile."
              : source?.source === "product" ? "Changes saved to your product catalogue."
              : "Saved activity record."}</p>
          </div></li>;
        })}</ol>}
      </section>}
    </section>
  );
}
