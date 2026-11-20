import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, MessageCircle, Package, Search, ShieldCheck, Sparkles, Store } from "lucide-react";
import type { User } from "../shared/contracts";
import { AuthForm } from "./AuthForm";
import { Icon } from "./Icon";
import "./welcome.css";

const frames = [
  { eyebrow: "A LOT ON YOUR PLATE", title: "Running a business means juggling a lot.", detail: "Your products. Your customers. Your competitors. It can be hard to see what deserves your attention next." },
  { eyebrow: "FROM SCATTERED TO CONNECTED", title: "Bring the picture together.", detail: "GrowthPulse helps you understand your business and explore public market evidence, with sources you can review." },
  { eyebrow: "CLARITY, THEN ACTION", title: "Find your next move.", detail: "Review an opportunity, choose what matters, and turn it into a plan. You decide what to do. Your agent never publishes changes for you." },
  { eyebrow: "YOUR STORY STARTS HERE", title: "Let's understand your business.", detail: "Create your account first. Next, add your website or tell us about your business yourself." },
] as const;

function BusinessStory({ frame }: { frame: number }) {
  return <div className={`welcome-illustration welcome-scene-${frame}`} aria-hidden="true">
    <div className="story-orbit story-orbit-outer" /><div className="story-orbit story-orbit-inner" />
    <svg className="story-connections" viewBox="0 0 600 440" fill="none">
      <path d="M125 95Q250 65 300 220M485 110Q390 90 300 220M115 335Q235 375 300 220M485 335Q370 375 300 220" />
    </svg>
    <div className="story-shop">
      <div className="story-shop-roof"><i /><i /><i /><i /><i /></div>
      <div className="story-shop-front"><Store /><span>YOUR BUSINESS</span><div className="story-shop-window"><Package /><span>Made with care.<br />Built by you.</span></div></div>
      <div className="story-engine"><Icon name="pulse" /><span>GrowthPulse</span></div>
    </div>
    <div className="story-signal story-products"><span className="story-card-icon"><Package /></span><div><small>WHAT YOU SELL</small><strong>Your products</strong><span>Details, prices, possibilities.</span></div></div>
    <div className="story-signal story-customers"><span className="story-card-icon"><MessageCircle /></span><div><small>WHAT PEOPLE ASK</small><strong>Customer questions</strong><span>What do they need to know?</span></div></div>
    <div className="story-signal story-market"><span className="story-card-icon"><Search /></span><div><small>THE BIGGER PICTURE</small><strong>Your market</strong><span>Evidence, not guesswork.</span></div></div>
    <div className="story-insight"><Sparkles /><div><small>ILLUSTRATIVE OPPORTUNITY</small><strong>Make sizing easier to understand</strong><span>Review the evidence before deciding.</span></div></div>
    <div className="story-action"><div className="story-action-heading"><span><Check /> YOUR CHOSEN ACTION</span><small>To do</small></div><strong>Review your product size guide</strong><p>Confirm measurements. Clarify the details.</p><span className="story-action-footer">Your decision. Your next step.<ArrowRight /></span></div>
    <span className="story-caption">An illustration of the experience, not a live analysis.</span>
  </div>;
}

export function WelcomeExperience({ initialMode, onAuthenticated }: {
  initialMode?: "login" | "register";
  onAuthenticated: (user: User, registered: boolean) => void;
}) {
  const [frame, setFrame] = useState(initialMode ? 3 : 0);
  const [authMode, setAuthMode] = useState<"login" | "register">(initialMode ?? "register");
  const heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(frame);
  useEffect(() => {
    if (previous.current !== frame) heading.current?.focus();
    previous.current = frame;
  }, [frame]);
  function showAuth(mode: "login" | "register") { setAuthMode(mode); setFrame(3); }
  const current = frames[frame];

  return <div className="welcome-shell">
    <a className="skip-link" href="#welcome-content">Skip to content</a>
    <header className="welcome-header">
      <a className="brand" href="#overview" onClick={() => setFrame(0)} aria-label="GrowthPulse welcome"><span className="brand-mark"><Icon name="pulse" /></span>GrowthPulse</a>
      <button className="welcome-login" type="button" onClick={() => showAuth("login")}>Log in<ArrowRight /></button>
    </header>
    <main id="welcome-content" className={`welcome-main${frame === 3 ? " welcome-auth" : ""}`}>
      <div className="welcome-copy">
        <p className="welcome-eyebrow"><span />{current.eyebrow}</p>
        <div key={frame} className="welcome-frame-copy" aria-live="polite" aria-atomic="true">
          <h1 ref={heading} tabIndex={-1}>{current.title}</h1>
          <p>{current.detail}</p>
        </div>
        {frame === 3 ? <div className="welcome-account">
          <AuthForm mode={authMode} onModeChange={setAuthMode} onAuthenticated={onAuthenticated} />
          <button className="welcome-back" type="button" onClick={() => setFrame(2)}><ArrowLeft />Back to the story</button>
        </div> : <>
          <div className="welcome-controls">
            <button type="button" className="welcome-next" onClick={() => frame === 2 ? showAuth("register") : setFrame(frame + 1)}>
              {frame === 2 ? "Let's get started" : "Next"}<ArrowRight />
            </button>
            <button type="button" className="welcome-skip" onClick={() => showAuth("register")}>Skip intro</button>
          </div>
          <p className="welcome-reassurance"><ShieldCheck />Your business. Your final call.</p>
        </>}
      </div>
      <BusinessStory frame={frame} />
      <div className="welcome-pagination" role="group" aria-label="Welcome story frames">
        <button className="welcome-back" type="button" disabled={frame === 0} onClick={() => setFrame(frame - 1)}><ArrowLeft />Back</button>
        <div>{frames.map((item, index) => <button key={item.eyebrow} type="button"
          aria-label={`Show frame ${index + 1}: ${item.title}`} aria-current={index === frame ? "step" : undefined}
          onClick={() => { if (index === 3) showAuth("register"); else setFrame(index); }}><span /></button>)}</div>
        <span>{String(frame + 1).padStart(2, "0")} / 04</span>
      </div>
    </main>
    <footer className="welcome-footer"><span>A LITTLE CLARITY GOES A LONG WAY.</span><a href="#contact">Contact us</a><span>No website changes without your approval.</span></footer>
  </div>;
}
