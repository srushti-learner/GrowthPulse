// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { BusinessWorkspace } from "./BusinessWorkspace";

describe("workspace foundation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderApp() {
    await act(async () => root.render(<App />));
  }

  function setValue(name: string, value: string) {
    const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const health = { status: "ok", service: "growthpulse-api", database: { engine: "sqlite", status: "ok" } };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  it("opens contact directly without loading authentication or business data, and returns to normal entry", async () => {
    window.history.replaceState(null, "", "/#contact");
    const fetch = publicFetch();
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(container.querySelector("h1")?.textContent).toBe("Let's talk.");
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      window.history.replaceState(null, "", "/#overview");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector(".welcome-shell")).not.toBeNull();
    expect(fetch.mock.calls.map(([path]) => path)).toContain("/api/auth/me");
    expect(fetch.mock.calls.map(([path]) => path)).toContain("/api/health");
    expect(container.querySelector('a[href="#contact"]')).not.toBeNull();
  });
  it("allows contact navigation even when the account service is unavailable", async () => {
    const fetch = vi.fn(async () => json({ error: "Service unavailable" }, 503));
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(container.querySelector(".entry-status")).not.toBeNull();
    expect(container.querySelector('a[href="#contact"]')).not.toBeNull();
    const count = fetch.mock.calls.length;
    await act(async () => {
      window.history.replaceState(null, "", "/#contact");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector("h1")?.textContent).toBe("Let's talk.");
    expect(fetch).toHaveBeenCalledTimes(count);
  });
  it("shows meaningful activity history without database references or raw scan summaries", async () => {
    const business = {
      id: "02a221ee-41f1-46c9-bc96-12401d8dcf73", name: "Fixture shop", website: "", category: "", description: "",
      createdAt: "2026-11-17T12:00:00.000Z", updatedAt: "2026-11-17T12:00:00.000Z",
    };
    const sources = (["manual", "product", "website"] as const).map((source, index) => ({
      id: `509e12ce-3028-4ed1-bdf7-329a26d470d${index}`, businessId: business.id, source,
      reference: source === "website" ? "https://shop.example.com/" : `internal/${index}`,
      summary: "Static HTML from scan internal-scan-id. Raw captured text.", capturedAt: business.createdAt,
    }));
    const actions = ["business.created", "product.saved", "website.scanned", "business.updated"];
    const fetch = vi.fn(async (path: string) => {
      if (path === "/api/businesses") return json({ businesses: [business] });
      if (path.endsWith("/evidence")) return json({ evidence: sources });
      if (path.endsWith("/activity")) return json({ activities: actions.map((action, index) => ({
        id: `63243bee-1f3a-40db-a516-93b04d40f79${index}`, businessId: business.id,
        evidenceId: sources[index]?.id ?? "63243bee-1f3a-40db-a516-93b04d40f799", action, createdAt: business.createdAt,
      })) });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<BusinessWorkspace activityOnly onSessionExpired={() => {}} />));
    const history = container.querySelector(".activity-list")!;
    expect(history.querySelectorAll("li")).toHaveLength(4);
    expect(history.textContent).toContain("Changes saved to your business profile.");
    expect(history.textContent).toContain("Changes saved to your product catalogue.");
    expect(history.querySelector("a")?.href).toBe("https://shop.example.com/");
    expect(history.textContent).toContain("Saved activity record.");
    for (const technical of ["internal/", "internal-scan-id", "Static HTML", "Evidence reference:", sources[0].id]) {
      expect(history.textContent).not.toContain(technical);
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  function publicFetch(checkHealth: () => Promise<Response> = async () => json(health)) {
    return vi.fn((path: string) => path === "/api/auth/me" ? Promise.resolve(json({ error: "Please log in to continue." }, 401))
      : path === "/api/onboarding/preview" ? Promise.resolve(json({ preview: null })) : checkHealth());
  }
  function signedInFetch() {
    return vi.fn(async (path: string) => {
      if (path === "/api/auth/me") return json({ user: { id: "509e12ce-3028-4ed1-bdf7-329a26d470d8", name: "Test Owner", email: "owner@example.test" } });
      if (path === "/api/health") return json(health);
      if (path === "/api/businesses") return json({ businesses: [] });
      if (path === "/api/onboarding/preview") return json({ preview: null });
      throw new Error(`Unexpected request: ${path}`);
    });
  }

  it("shows planned social-first features without fetching business data or starting connector activity", async () => {
    window.history.replaceState(null, "", "/#future");
    const fetch = signedInFetch();
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(container.querySelector("h1")?.textContent).toBe("Future features");
    expect(container.querySelector('nav[aria-label="Main navigation"] a[aria-current="page"]')?.getAttribute("href")).toBe("#future");
    const roadmap = container.querySelector('[aria-label="Future features roadmap"]')!;
    expect(roadmap.textContent).toContain("Planned · Not available yet");
    expect(roadmap.querySelector('[aria-label="Instagram business connector"]')).not.toBeNull();
    expect(roadmap.querySelector('[aria-label="WhatsApp Business connector"]')).not.toBeNull();
    expect(roadmap.textContent).toContain("not live integrations or promised release dates");
    expect(roadmap.querySelector('a[href="#overview?view=manual&new=1"]')).not.toBeNull();
    expect(roadmap.querySelector("button")).toBeNull();
    expect(fetch.mock.calls.map(([path]) => path).sort()).toEqual(["/api/auth/me", "/api/health"]);
  });

  it.each(["sqlite", "mysql"])("accepts a healthy %s connection without exposing technical status controls", async (engine) => {
    const fetch = publicFetch(async () => json({ ...health, database: { engine, status: "ok" } }));
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(fetch).toHaveBeenCalledWith("/api/health", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.querySelector(".connection-details")).toBeNull();
    expect(container.querySelector(".status-card")).toBeNull();
    expect(container.textContent).not.toContain("Express API");
    expect(container.textContent).not.toContain("Local SQLite");
    expect(container.querySelector(".phase-label")).toBeNull();
    expect(container.querySelector(".sidebar-bottom")).toBeNull();
  });

  it("keeps the active business across dashboard destinations without starting analysis", async () => {
    const businesses = ["First shop", "Second shop"].map((name, index) => ({
      id: `02a221ee-41f1-46c9-bc96-12401d8dcf7${index}`, name, website: "", category: "", description: "",
      createdAt: "2026-11-16T12:00:00.000Z", updatedAt: "2026-11-16T12:00:00.000Z",
    }));
    const fetch = vi.fn(async (path: string, _options?: RequestInit) => {
      if (path === "/api/auth/me") return json({ user: { id: "509e12ce-3028-4ed1-bdf7-329a26d470d8", name: "Test Owner", email: "owner@example.test" } });
      if (path === "/api/health") return json(health);
      if (path === "/api/onboarding/preview") return json({ preview: null });
      if (path === "/api/businesses") return json({ businesses });
      if (path.endsWith("/products")) return json({ products: [] });
      if (path.endsWith("/scans")) return json({ scans: [] });
      if (path.endsWith("/understanding")) return json({ understanding: null });
      if (path.endsWith("/growth")) return json({ opportunities: [], plan: [], researchStatus: "unavailable", evidenceSavedAt: null });
      if (path.endsWith("/analytics")) return json({ analytics: {
        currency: null, version: "1234567890abcdef12345678", days: [], products: [], sources: [], imports: [], scenarios: [], warnings: [], traffic: null,
      } });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch); await renderApp();
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Active business"]')!;
      select.value = businesses[1].id; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (const section of ["opportunities", "intelligence", "growth", "actions", "products", "simulator", "website", "progress", "future", "business", "overview"]) {
      await act(async () => {
        window.history.replaceState(null, "", `/#${section}`); window.dispatchEvent(new HashChangeEvent("hashchange"));
        await vi.dynamicImportSettled();
      });
      if (section === "future") {
        expect(container.querySelectorAll('select[aria-label="Active business"]')).toHaveLength(0);
        expect(container.querySelector('[aria-label="Future features roadmap"]')).not.toBeNull();
      } else {
        expect(container.querySelector<HTMLSelectElement>('select[aria-label="Active business"]')?.value).toBe(businesses[1].id);
        expect(container.querySelectorAll('select[aria-label="Active business"]')).toHaveLength(1);
      }
      if (section === "business") expect(container.querySelector(".saved-profile-details")?.textContent).toContain("Second shop");
      else if (section === "overview") {
        expect(container.querySelector(".journey-next")?.textContent).toContain("Give what you sell a place");
        expect(container.querySelector(".first-visit")).toBeNull();
      } else if (["growth", "opportunities", "intelligence"].includes(section)) {
        expect(container.querySelector(".business-profile-settings")).toBeNull();
        expect(container.querySelector('.business-workspace a[href^="#overview?view=business"]')?.textContent)
          .toContain(section === "growth" || section === "opportunities" ? "Manage website analysis" : "Manage business profile");
      }
      expect(container.querySelector('nav[aria-label="Main navigation"] a[href^="#products"]')?.getAttribute("href"))
        .toBe(`#products?business=${businesses[1].id}`);
    }
    expect(fetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "POST" }));
  });
  it.each(["website", "simulator", "products", "actions", "business", "future"])("requires authentication on a direct %s link without exposing the workspace", async (section) => {
    window.history.replaceState(null, "", `/#${section}`);
    const fetch = publicFetch(); vi.stubGlobal("fetch", fetch); await renderApp();
    expect(container.querySelector(".auth-form")).not.toBeNull();
    expect(container.querySelector('nav[aria-label="Main navigation"]')).toBeNull();
    expect(container.querySelector('input[type="url"]')).toBeNull();
    expect(fetch.mock.calls.map(([path]) => path).sort()).toEqual(["/api/auth/me", "/api/health"]);
  });

  it("opens chosen steps rather than products from Act, and refreshes the journey after a status update", async () => {
    const business = {
      id: "02a221ee-41f1-46c9-bc96-12401d8dcf73", name: "Fixture shop", website: "", category: "", description: "",
      createdAt: "2026-11-17T12:00:00.000Z", updatedAt: "2026-11-17T12:00:00.000Z",
    };
    const opportunity = {
      id: "a".repeat(64), title: "Check sizing", detail: "Check the measurements.", agents: ["growth"], reviewReason: "Needs validation.",
      sources: [{ id: "e_1111111111111111", url: "https://shop.example.com/", quote: "Five sizes are available.", capturedAt: business.createdAt }],
      strategy: { objective: "Clarify sizing", actions: ["Check measurements."], metric: "Enquiries", hypothesis: "Check sizing.", measurement: "Choose a baseline." },
    };
    let plan: unknown[] = [];
    window.history.replaceState(null, "", `/#growth?business=${business.id}`);
    vi.stubGlobal("fetch", vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/health") return json(health);
      if (path === "/api/auth/me") return json({ user: { id: "509e12ce-3028-4ed1-bdf7-329a26d470d8", name: "Test Owner", email: "owner@example.test" } });
      if (path === "/api/businesses") return json({ businesses: [business] });
      if (path.endsWith("/products")) return json({ products: [] });
      if (path.endsWith("/activity")) return json({ activities: [] });
      if (path.endsWith("/evidence")) return json({ evidence: [] });
      if (path.endsWith("/growth")) return json({ opportunities: [opportunity], plan, researchStatus: "partial", evidenceSavedAt: business.createdAt });
      if (path.endsWith("/plan")) {
        const item = { opportunity, impact: "unknown", effort: "unknown", timeToValue: "unknown", status: options?.method === "PATCH" ? "completed" : "planned",
          revision: options?.method === "PATCH" ? 1 : 0, createdAt: business.createdAt, updatedAt: business.updatedAt };
        plan = [item]; return json({ item }, options?.method === "POST" ? 201 : 200);
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    await renderApp();
    expect(container.querySelector(".journey-stages")).toBeNull();
    await act(async () => [...container.querySelectorAll("button")].find((item) => item.textContent === "Add to my growth plan")!.click());
    expect(container.querySelector(".growth-plan-item")?.textContent).toContain(opportunity.title);
    const actLink = container.querySelector<HTMLAnchorElement>('nav[aria-label="Main navigation"] a[href^="#actions"]')!;
    expect(actLink.getAttribute("href")).toBe(`#actions?business=${business.id}`);
    await act(async () => {
      window.history.replaceState(null, "", actLink.getAttribute("href")!);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector("h1")?.textContent).toBe("My actions");
    expect(container.querySelector(".action-workspace ol")?.textContent).toContain("Check measurements.");
    expect(container.querySelector(".products-workspace")).toBeNull();
    expect(container.querySelector('nav[aria-label="Main navigation"] a[href^="#products"]')?.textContent).toBe("Products");
    expect(container.querySelector('nav[aria-label="Main navigation"] a[aria-current="page"]')?.getAttribute("href")).toBe(`#actions?business=${business.id}`);
    const details = container.querySelector<HTMLDetailsElement>(".growth-plan-item")!;
    await act(async () => {
      details.open = true; details.querySelector<HTMLSelectElement>('select[name="status"]')!.value = "completed";
      details.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector(".action-workspace")?.textContent).toContain("No open actions");
    await act(async () => {
      window.history.replaceState(null, "", `/#overview?business=${business.id}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector(".journey-stages")?.textContent).toContain("Owner updates available");
  });

  it("preserves the old Opportunities route as an alias for My growth plan", async () => {
    window.history.replaceState(null, "", "/#opportunities");
    const fetch = signedInFetch(); vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(window.location.hash).toBe("#growth");
    expect(container.querySelector('nav[aria-label="Main navigation"] a[href="#opportunities"]')).toBeNull();
    expect(container.querySelector('nav[aria-label="Main navigation"] a[aria-current="page"]')?.textContent).toBe("My growth plan");
    expect(fetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "POST" }));
  });

  it("opens mobile navigation as a dismissable sheet and closes it after selecting a destination", async () => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("fetch", signedInFetch()); await renderApp();
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="sidebar-trigger"]')!;
    await act(async () => { trigger.focus(); trigger.click(); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    await act(async () => dialog.querySelector<HTMLAnchorElement>('a[href="#website"]')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("displays connection errors and can retry successfully", async () => {
    const check = vi.fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce(json(health));
    const fetch = publicFetch(check);
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Network unavailable");
    await act(async () => container.querySelector<HTMLButtonElement>(".status-card button")?.click());
    expect(container.querySelector(".status-card")).toBeNull();
    expect(container.querySelector(".connection-details")).toBeNull();
  });

  it("does not display connected for an unexpected API response", async () => {
    vi.stubGlobal("fetch", publicFetch(async () => json({ status: "unhealthy" })));
    await renderApp();
    expect(container.querySelector(".status-dot.error")).not.toBeNull();
    expect(container.querySelector(".status-dot.connected")).toBeNull();
  });

  it("navigates to honest module placeholders and preserves the section on skip-to-content", async () => {
    vi.stubGlobal("fetch", signedInFetch());
    await renderApp();
    await act(async () => {
      window.history.replaceState(null, "", "/#whatsapp");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector("h1")?.textContent).toBe("WhatsApp Insights");
    expect(container.textContent).toContain("This feature is coming soon");
    expect(container.textContent).not.toContain("Later analysis modules remain planned");
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain("WhatsApp Insights");
    await act(async () => {
      window.history.replaceState(null, "", "/#main-content");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector("h1")?.textContent).toBe("WhatsApp Insights");
  });

  it("moves through animated story frames and signup without scans or workspace navigation", async () => {
    const fetch = publicFetch();
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(container.querySelector("h1")?.textContent).toBe("Running a business means juggling a lot.");
    expect(container.querySelector(".auth-form")).toBeNull();
    expect(container.querySelector('nav[aria-label="Main navigation"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".welcome-next")!.click());
    expect(container.querySelector(".welcome-scene-1")).not.toBeNull();
    expect(document.activeElement).toBe(container.querySelector("h1"));
    await act(async () => container.querySelector<HTMLButtonElement>(".welcome-next")!.click());
    expect(container.querySelector("h1")?.textContent).toBe("Find your next move.");
    expect(container.querySelector('[aria-current="step"]')?.getAttribute("aria-label")).toContain("frame 3");
    await act(async () => container.querySelector<HTMLButtonElement>(".welcome-pagination .welcome-back")!.click());
    expect(container.querySelector(".welcome-scene-1")).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".welcome-skip")!.click());
    expect(container.querySelector("#auth-heading")?.textContent).toBe("Make room for clarity.");
    expect(container.textContent).not.toContain("Create a local account");
    expect(container.textContent).not.toContain("Development preview:");
    expect(container.querySelector('[name="name"]')).not.toBeNull();
    expect(container.querySelector('input[type="url"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".welcome-login")!.click());
    expect(container.querySelector("#auth-heading")?.textContent).toBe("Welcome back.");
    expect(container.querySelector('[name="name"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".auth-form .text-button")!.click());
    expect(container.querySelector('[name="name"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".welcome-login")!.click());
    expect(container.querySelector('[name="name"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="Show frame 1:"]')!.click());
    expect(container.querySelector("h1")?.textContent).toBe("Running a business means juggling a lot.");
    expect(fetch.mock.calls.map(([path]) => path).sort()).toEqual(["/api/auth/me", "/api/health"]);
  });

  it("requires login for business profiles while leaving the illustrative overview public", async () => {
    window.history.replaceState(null, "", "/#business");
    vi.stubGlobal("fetch", publicFetch());
    await renderApp();
    expect(container.querySelector("#auth-heading")?.textContent).toBe("Welcome back.");
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector(".business-workspace")).toBeNull();
  });

  it("lets a returning visitor bypass the story with a direct login link", async () => {
    window.history.replaceState(null, "", "/#login");
    const fetch = publicFetch();
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(container.querySelector(".scan-form")).toBeNull();
    expect(container.querySelector(".auth-form")).not.toBeNull();
    expect(container.querySelector("#auth-heading")?.textContent).toBe("Welcome back.");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shows a session failure with a retry instead of pretending the user is logged out", async () => {
    window.history.replaceState(null, "", "/#business");
    vi.stubGlobal("fetch", vi.fn((path: string) => Promise.resolve(path === "/api/health" ? json(health) : json({ error: "Database unavailable" }, 500))));
    await renderApp();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Database unavailable");
    expect(container.querySelector(".auth-form")).toBeNull();
  });

  it("explains a non-JSON proxy error without a browser JSON parsing error", async () => {
    window.history.replaceState(null, "", "/#business");
    vi.stubGlobal("fetch", vi.fn((path: string) => Promise.resolve(path === "/api/health" ? json(health) : new Response("Backend restarting", { status: 502 }))));
    await renderApp();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Request failed (HTTP 502). Please retry.");
  });

  it("does not mistake a failed business load for an empty account and can retry", async () => {
    window.history.replaceState(null, "", "/#business");
    let failed = true;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/health") return json(health);
      if (path === "/api/auth/me") return json({ user: { id: "509e12ce-3028-4ed1-bdf7-329a26d470d8", name: "Test Owner", email: "owner@example.test" } });
      return failed ? json({ error: "Could not load saved businesses" }, 500) : json({ businesses: [] });
    }));
    await renderApp();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load saved businesses");
    expect(container.querySelector("form.profile-card")).toBeNull();
    failed = false;
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>('[role="alert"] button').forEach((button) => button.click());
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("form.profile-card")).not.toBeNull();
  });

  it.each(["#signup", "#products?business=00000000-0000-4000-8000-000000000001"])("registers from %s before website/manual setup, without retaining another account's business context", async (entry) => {
    window.history.replaceState(null, "", `/${entry}`);
    const user = { id: "509e12ce-3028-4ed1-bdf7-329a26d470d8", name: "Test Owner", email: "owner@example.test" };
    const business = { id: "02a221ee-41f1-46c9-bc96-12401d8dcf73", name: "Local Shop", category: "", description: "", website: "", createdAt: "2026-11-16T12:00:00.000Z", updatedAt: "2026-11-16T12:00:00.000Z" };
    const updated = { ...business, name: "Updated Local Shop" };
    let saved = false;
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/health") return json(health);
      if (path === "/api/auth/me") return json({ error: "Please log in to continue." }, 401);
      if (path === "/api/auth/register") return json({ user }, 201);
      if (path === "/api/auth/logout") return new Response(null, { status: 204 });
      if (path === "/api/businesses" && options?.method === "POST") { saved = true; return json({ business }, 201); }
      if (path === "/api/businesses") return json({ businesses: saved ? [business] : [] });
      if (path === "/api/onboarding/preview") return json({ preview: null });
      if (path.endsWith("/products")) return json({ products: [] });
      if (path.endsWith("/growth")) return json({ opportunities: [], plan: [], researchStatus: "unavailable", evidenceSavedAt: null });
      if (path === `/api/businesses/${business.id}` && options?.method === "PUT") return json({ business: updated });
      if (path.endsWith("/activity")) return json({ activities: [] });
      if (path.endsWith("/evidence")) return json({ evidence: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    if (entry.startsWith("#products")) await act(async () => container.querySelector<HTMLButtonElement>(".auth-form .text-button")!.click());
    await act(async () => {
      setValue("name", user.name);
      setValue("email", user.email);
      setValue("password", "local test passphrase");
      container.querySelector(".auth-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector(".business-workspace")).toBeNull();
    expect(container.querySelector(".first-visit h2")?.textContent).toBe("What's your business website?");
    expect(container.querySelector('nav[aria-label="Main navigation"]')?.textContent).not.toContain("My business");
    expect(fetch.mock.calls.some(([, options]) => options?.method === "POST" && String(options.body).includes("permission"))).toBe(false);
    await act(async () => {
      window.history.replaceState(null, "", "/#overview?view=business&new=1");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector(".business-workspace")).not.toBeNull();
    await act(async () => setValue("businessName", business.name));
    await act(async () => container.querySelector("form.profile-card")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector(".saved-profile h2")?.textContent).toBe("Business profile saved");
    expect(container.querySelector(".saved-profile-icon svg")).not.toBeNull();
    expect(container.querySelector(".saved-profile-details")?.textContent).toContain(business.name);
    expect(window.location.hash).toBe(`#overview?view=business&business=${business.id}`);
    expect(container.querySelector("form.profile-card")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".saved-profile h2"));
    const write = fetch.mock.calls.find(([path, options]) => path === "/api/businesses" && options?.method === "POST");
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ name: "Local Shop", category: "", description: "", website: "" });
    await act(async () => container.querySelector<HTMLButtonElement>(".saved-profile button")?.click());
    expect(container.querySelector<HTMLInputElement>('[name="businessName"]')?.value).toBe(business.name);
    expect(document.activeElement).toBe(container.querySelector('[name="businessName"]'));
    await act(async () => setValue("businessName", updated.name));
    await act(async () => container.querySelector("form.profile-card")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector(".saved-profile-details")?.textContent).toContain(updated.name);
    expect(container.querySelector("form.profile-card")).toBeNull();
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${business.id}`, expect.objectContaining({ method: "PUT", body: JSON.stringify({ name: updated.name, category: "", description: "", website: "" }) }));
    await act(async () => container.querySelector<HTMLButtonElement>(".session-actions button")?.click());
    expect(container.querySelector(".business-workspace")).toBeNull();
    expect(container.querySelector(".welcome-scene-0")).not.toBeNull();
    expect(container.querySelector(".auth-form")).toBeNull();
  });

  it("opens existing profiles as saved cards, discards cancelled edits, and retains failed edits", async () => {
    window.history.replaceState(null, "", "/#business");
    const business = { id: "02a221ee-41f1-46c9-bc96-12401d8dcf73", name: "Saved Shop", category: "", description: "", website: "", createdAt: "2026-11-16T12:00:00.000Z", updatedAt: "2026-11-16T12:00:00.000Z" };
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/health") return json(health);
      if (path === "/api/auth/me") return json({ user: { id: "509e12ce-3028-4ed1-bdf7-329a26d470d8", name: "Test Owner", email: "owner@example.test" } });
      if (path === "/api/businesses") return json({ businesses: [business] });
      if (path.endsWith("/products")) return json({ products: [] });
      if (path.endsWith("/growth")) return json({ opportunities: [], plan: [], researchStatus: "unavailable", evidenceSavedAt: null });
      if (path.endsWith("/activity")) return json({ activities: [] });
      if (path.endsWith("/evidence")) return json({ evidence: [] });
      if (options?.method === "PUT") return json({ error: "Could not save your profile" }, 500);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(container.querySelector(".saved-profile-details")?.textContent).toContain(business.name);
    expect(container.querySelector("form.profile-card")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".saved-profile button")?.click());
    await act(async () => setValue("businessName", "Unsaved change"));
    await act(async () => container.querySelector<HTMLButtonElement>('.profile-actions button[type="button"]')?.click());
    expect(container.querySelector(".saved-profile-details")?.textContent).toContain(business.name);
    expect(fetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>(".saved-profile button")?.click());
    expect(container.querySelector<HTMLInputElement>('[name="businessName"]')?.value).toBe(business.name);
    await act(async () => setValue("businessName", "Keep this draft"));
    await act(async () => container.querySelector("form.profile-card")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save your profile");
    expect(container.querySelector<HTMLInputElement>('[name="businessName"]')?.value).toBe("Keep this draft");
    expect(container.querySelector(".saved-profile")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.profile-actions button[type="submit"]')?.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('.profile-actions button[type="button"]')?.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".saved-profile-details")?.textContent).toContain(business.name);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add a business"]')?.click());
    expect(container.querySelector(".saved-profile")).toBeNull();
    expect(container.querySelector('[name="onboardingUrl"]')).not.toBeNull();
    expect(window.location.hash).toBe("#overview?view=setup&new=1");
  });
});
