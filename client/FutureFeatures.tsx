import { ArrowRight, CalendarCheck, Camera, Images, MessageCircle, MessagesSquare, ShieldCheck, ShoppingBag } from "lucide-react";
import "./future-features.css";

const connectors = [
  {
    title: "Instagram business connector",
    icon: Camera,
    className: "instagram",
    introduction: "Your shop might be a profile, not a website.",
    description: "Connect an Instagram professional account you manage, with permission, to build a business picture from selected posts and product information.",
    outcomes: ["Turn product posts into catalogue drafts.", "Understand recurring questions and content signals.", "Find the next move for your social-first business."],
  },
  {
    title: "WhatsApp Business connector",
    icon: MessageCircle,
    className: "whatsapp",
    introduction: "Your customer conversations are part of the picture.",
    description: "Bring an authorised WhatsApp Business connection into GrowthPulse to understand enquiries and catalogue interest without needing a website.",
    outcomes: ["Spot repeated questions and unmet needs.", "Compare enquiry patterns with your products.", "Prepare reply suggestions for your review."],
  },
] as const;

const ideas = [
  {
    title: "Photo-to-product drafts",
    icon: Images,
    description: "Upload product photos or a price list. Get catalogue drafts to review instead of entering every detail by hand.",
  },
  {
    title: "Connected order history",
    icon: ShoppingBag,
    description: "Bring supported shop and order systems together to compare sales across online, social and offline channels.",
  },
  {
    title: "Conversation-to-customer insights",
    icon: MessagesSquare,
    description: "Turn permitted business conversation signals into sourced customer themes, product gaps and suggested next steps.",
  },
  {
    title: "Automatic weekly check-ins",
    icon: CalendarCheck,
    description: "Choose a schedule for fresh evidence and a weekly briefing. See what changed before deciding what to do next.",
  },
] as const;

export function FutureFeatures() {
  return <section className="future-features" aria-label="Future features roadmap">
    <div className="future-intro">
      <span className="future-status">Planned · Not available yet</span>
      <h2>Your business doesn't have to start with a website.</h2>
      <p>An Instagram shop. WhatsApp enquiries. An offline store. We want GrowthPulse to meet your business where it already happens.</p>
      <p className="future-expectations">These are future plans, not live integrations or promised release dates.</p>
    </div>

    <div className="future-connectors">
      {connectors.map(({ title, icon: ConnectorIcon, className, introduction, description, outcomes }) => <article key={title} className={`future-connector future-${className}`} aria-label={title}>
        <div className="future-card-top"><span className="future-icon"><ConnectorIcon aria-hidden="true" /></span><span className="future-status">Planned connector</span></div>
        <h3>{title}</h3>
        <p className="future-card-lead">{introduction}</p>
        <p>{description}</p>
        <ul>{outcomes.map((outcome) => <li key={outcome}><ArrowRight aria-hidden="true" />{outcome}</li>)}</ul>
      </article>)}
    </div>

    <section className="future-ideas" aria-labelledby="future-ideas-heading">
      <h2 id="future-ideas-heading">More ways to make the next move clearer.</h2>
      <div className="future-ideas-grid">{ideas.map(({ title, icon: IdeaIcon, description }) => <article key={title} className="future-idea">
        <div className="future-card-top"><span className="future-icon"><IdeaIcon aria-hidden="true" /></span><span className="future-status">Future idea</span></div>
        <h3>{title}</h3>
        <p>{description}</p>
      </article>)}</div>
    </section>

    <div className="future-bottom">
      <section className="future-permissions" aria-labelledby="future-permissions-heading">
        <ShieldCheck aria-hidden="true" />
        <div><h2 id="future-permissions-heading">Connections with your permission.</h2>
          <p>Our plan is to use official platform APIs, request only the access you approve, and let you disconnect. Availability will depend on platform permissions and approval.</p>
          <p>No private-chat scraping. No messages or changes published without your approval.</p>
        </div>
      </section>
      <section className="future-start" aria-labelledby="future-start-heading">
        <h2 id="future-start-heading">No website? You can start today.</h2>
        <p>Add your business manually, then build your catalogue with manual entries or CSV. The connectors above are not required.</p>
        <a href="#overview?view=manual&new=1" className="primary-link">Add a business without a website <ArrowRight aria-hidden="true" /></a>
        <a href="#contact" className="text-button">Tell us what your business needs <ArrowRight aria-hidden="true" /></a>
      </section>
    </div>
  </section>;
}
