import { useState } from "react";
import { Icon } from "./Icon";

const sources = [
  {
    id: "website",
    label: "Website",
    icon: "globe",
    color: "violet",
    caption: "Look beyond the homepage.",
    evidence: "In this example, a clothing store has product pages but no visible size guide. A real scan would need to capture the affected page and its content.",
    opportunity: "Make sizing information easier to find on product pages. This is an example opportunity, not a finding about your website.",
    change: "Preview a proposed size-guide section using measurements confirmed by the owner. Never invent product measurements.",
    checkpoint: 4,
  },
  {
    id: "products",
    label: "Products",
    icon: "box",
    color: "mint",
    caption: "Give every detail a place.",
    evidence: "This sample catalogue has a product with sizes listed but no fit information. Real product evidence would come from a website, CSV import, or manual entry.",
    opportunity: "Clarify the product's fit information so shoppers have a more useful description. This suggestion uses illustrative data only.",
    change: "Show the current and proposed descriptions side by side, using only confirmed product details. The owner reviews the wording before it can be applied.",
    checkpoint: 5,
  },
  {
    id: "whatsapp",
    label: "Customer questions",
    icon: "chat",
    color: "peach",
    caption: "Listen for the useful signals.",
    evidence: "A synthetic conversation asks about clothing sizes. Real conversation insights would reference authorized imported messages, not assume what customers say.",
    opportunity: "Connect a sizing question to the relevant product information. One question is a signal to investigate, not proof of a widespread problem.",
    change: "Draft a reply based on approved business information for the owner to review. The MVP will not send customer messages automatically.",
    checkpoint: 7,
  },
] as const;

const stages = ["Evidence", "Opportunity", "Proposed change", "Your approval"];

export function WorkflowPreview() {
  const [sourceId, setSourceId] = useState<(typeof sources)[number]["id"]>("website");
  const [stage, setStage] = useState(0);
  const source = sources.find((item) => item.id === sourceId) ?? sources[0];
  const details = [
    { title: "Start with what you can see.", body: source.evidence },
    { title: "A signal becomes a next step.", body: source.opportunity },
    { title: "See the change before it happens.", body: source.change },
    { title: "The final call is always yours.", body: "This is a design preview, not a live workflow. Nothing has been scanned, generated, approved, or applied. Owner approval and technical verification will be implemented in later checkpoints." },
  ][stage];

  return (
    <section className="workflow-window" aria-labelledby="workflow-heading">
      <div className="window-toolbar">
        <div className="window-name"><span className="window-dots" aria-hidden="true"><i /><i /><i /></span><span>growthpulse / how it works</span></div>
        <span className="preview-badge"><span /> Design preview</span>
      </div>
      <div className="workflow-intro">
        <p className="section-eyebrow" id="workflow-heading">ONE BUSINESS. A CONNECTED PICTURE.</p>
        <h2>Find the signal.<br className="mobile-break" /> Connect the dots. <span>Make your move.</span></h2>
        <p>Select a source, then explore how evidence becomes an improvement.</p>
      </div>
      <div className="source-grid" role="group" aria-label="Example business sources">
        {sources.map((item) => (
          <button type="button" className={`source-card ${item.color}`} key={item.id} aria-pressed={sourceId === item.id} onClick={() => setSourceId(item.id)}>
            <span className="source-card-heading"><span className="source-title"><span className="source-light" /><span>{item.label}</span></span><Icon name="diagonal" /></span>
            <span className="source-caption">{item.caption}</span>
            {item.id === "website" ? (
              <span className="mini-site" aria-hidden="true">
                <span className="mini-site-header"><span>urban / threads</span><span>shop &nbsp; about &nbsp; +</span></span>
                <span className="mini-site-body"><span className="mini-shirt"><svg width="66" height="74" viewBox="0 0 66 74" fill="none"><path d="m22 13-14 8 7 15 8-4v30h22V32l8 4 7-15-16-8c-3 9-18 9-22 0Z" fill="currentColor" /><path d="M27 15c2 5 9 5 12 0" stroke="#18181c" strokeWidth="2" /></svg></span><span className="mini-site-copy"><span>Everyday essentials.</span><span className="skeleton-line" /><span className="skeleton-line short" /><span className="mini-cta">View collection <span>&rarr;</span></span></span></span>
                <span className="mini-site-footer"><span className="mini-indicator" /> Example storefront</span>
              </span>
            ) : item.id === "products" ? (
              <span className="mini-products" aria-hidden="true">
                <span className="mini-product"><span className="product-swatch swatch-tee" /><span><b>Everyday tee</b><span>S &nbsp; M &nbsp; L</span></span><span className="product-line" /></span>
                <span className="mini-product"><span className="product-swatch swatch-knit" /><span><b>Weekend knit</b><span>Relaxed fit</span></span><span className="product-line" /></span>
                <span className="mini-product"><span className="product-swatch swatch-shirt" /><span><b>Studio shirt</b><span>Details to add</span></span><span className="product-line" /></span>
              </span>
            ) : (
              <span className="mini-conversation" aria-hidden="true">
                <span className="chat-sender"><span className="chat-avatar">?</span> A customer asks</span>
                <span className="chat-bubble">How do I find the right size?<span>Sample message</span></span>
                <span className="chat-insight"><Icon name="spark" /> A question. A possible opportunity.</span>
              </span>
            )}
            <span className="source-card-footer"><Icon name={item.icon} /><span>Illustrative data</span><span className="source-selection">{sourceId === item.id ? "Selected" : "Explore"}</span></span>
          </button>
        ))}
      </div>
      <div className="pipeline-wrap">
        <div className="pipeline" role="group" aria-label="Preview workflow stages">
          {stages.map((label, index) => (
            <button type="button" key={label} aria-pressed={stage === index} onClick={() => setStage(index)} className={stage === index ? "active" : ""}>
              <span className="stage-number">{String(index + 1).padStart(2, "0")}</span>
              <span>{label}</span>
              {index < stages.length - 1 && <Icon name="arrow" className="stage-arrow" />}
            </button>
          ))}
        </div>
        <div className={`preview-detail ${source.color}`} aria-live="polite" aria-atomic="true">
          <div className="detail-icon"><Icon name={stage === 3 ? "shield" : source.icon} /></div>
          <div><p className="detail-kicker">{source.label} <span>/</span> {stages[stage]}</p><h3>{details.title}</h3><p className="detail-description">{details.body}</p></div>
          <span className="detail-tag">{stage === 3 ? "Owner controlled" : `Checkpoint ${source.checkpoint}${stage > 0 ? "+" : ""}`}</span>
        </div>
      </div>
      <div className="preview-disclaimer"><Icon name="shield" /><span>Illustrative only. No scans, AI calls, or business changes are running.</span></div>
    </section>
  );
}
