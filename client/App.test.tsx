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
      const select = container.querySelector<HTMLSelectElement>(".business-toolbar select")!;
      select.value = businesses[1].id; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (const section of ["opportunities", "intelligence", "growth", "products", "simulator", "business", "overview"]) {
      await act(async () => {
        window.history.replaceState(null, "", `/#${section}`); window.dispatchEvent(new HashChangeEvent("hashchange"));
        await vi.dynamicImportSettled();
      });
      expect(container.querySelector<HTMLSelectElement>('.business-toolbar select, select[aria-label="Analytics business"]')?.value).toBe(businesses[1].id);
      if (section === "business") expect(container.querySelector(".saved-profile-details")?.textContent).toContain("Second shop");
      else if (section !== "products" && section !== "simulator") {
        expect(container.querySelector(".business-profile-settings")).toBeNull();
        expect(container.querySelector('.business-workspace a[href="#business"]')?.textContent)
          .toContain(section === "growth" || section === "opportunities" ? "Manage website analysis" : "Manage business profile");
      }
    }
    expect(fetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "POST" }));
  });
  it("makes Growth Simulator an available destination but requires authentication before loading sales", async () => {
    window.history.replaceState(null, "", "/#simulator");
    const fetch = publicFetch(); vi.stubGlobal("fetch", fetch); await renderApp();
    expect(container.querySelector('nav > [data-slot="sidebar-menu"] a[href="#simulator"]')).not.toBeNull();
    expect(container.querySelector('.planned-navigation a[href="#simulator"]')).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Growth Simulator");
    expect(container.querySelector("form")).not.toBeNull();
    expect(container.textContent).not.toContain("This module is not implemented yet");
    expect(fetch.mock.calls.every(([path]) => !path.includes("/analytics"))).toBe(true);
  });

  it("removes Opportunities navigation and redirects its saved URL to Growth intelligence", async () => {
    window.history.replaceState(null, "", "/#opportunities");
    const fetch = publicFetch(); vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(window.location.hash).toBe("#growth");
    expect(container.querySelector('nav[aria-label="Main navigation"] a[href="#opportunities"]')).toBeNull();
    expect(container.querySelector('nav[aria-label="Main navigation"] a[aria-current="page"]')?.textContent).toBe("Growth intelligence");
    expect(fetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "POST" }));
  });

  it("opens mobile navigation as a dismissable sheet and closes it after selecting a destination", async () => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("fetch", publicFetch()); await renderApp();
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
    vi.stubGlobal("fetch", publicFetch());
    await renderApp();
    await act(async () => {
      window.history.replaceState(null, "", "/#whatsapp");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector("h1")?.textContent).toBe("WhatsApp Insights");
    expect(container.textContent).toContain("This module is not implemented yet");
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain("WhatsApp Insights");
    await act(async () => {
      window.history.replaceState(null, "", "/#main-content");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector("h1")?.textContent).toBe("WhatsApp Insights");
  });

  it("explores sample sources and workflow stages without triggering real analysis", async () => {
    const fetch = publicFetch();
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    await act(async () => container.querySelector<HTMLElement>(".workflow-explainer > summary")!.click());
    const sourceButtons = container.querySelectorAll<HTMLButtonElement>(".source-card");
    await act(async () => sourceButtons[1].click());
    expect(sourceButtons[1].getAttribute("aria-pressed")).toBe("true");
    expect(sourceButtons[0].getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".preview-detail")?.textContent).toContain("This sample catalogue");

    const stages = container.querySelectorAll<HTMLButtonElement>(".pipeline button");
    await act(async () => stages[2].click());
    expect(stages[2].getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".preview-detail")?.textContent).toContain("current and proposed descriptions");
    await act(async () => stages[3].click());
    expect(container.querySelector(".preview-detail")?.textContent).toContain("Nothing has been scanned, generated, approved, or applied");
    expect(container.querySelector(".preview-disclaimer")?.textContent).toContain("No scans, AI calls, or business changes are running");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("requires login for business profiles while leaving the illustrative overview public", async () => {
    window.history.replaceState(null, "", "/#business");
    vi.stubGlobal("fetch", publicFetch());
    await renderApp();
    expect(container.querySelector("#auth-heading")?.textContent).toBe("Welcome back.");
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector(".business-workspace")).toBeNull();
  });

  it("makes the website scanner available without requiring an account", async () => {
    window.history.replaceState(null, "", "/#website");
    const fetch = publicFetch();
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    expect(container.querySelector(".scan-form")).not.toBeNull();
    expect(container.querySelector(".auth-form")).toBeNull();
    expect(container.textContent).toContain("Preview only");
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
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("form.profile-card")).not.toBeNull();
  });

  it("signs up, creates a business without an owner supplied by the browser, and logs out", async () => {
    window.history.replaceState(null, "", "/#business");
    const user = { id: "509e12ce-3028-4ed1-bdf7-329a26d470d8", name: "Test Owner", email: "owner@example.test" };
    const business = { id: "02a221ee-41f1-46c9-bc96-12401d8dcf73", name: "Local Shop", category: "", description: "", website: "", createdAt: "2026-11-16T12:00:00.000Z", updatedAt: "2026-11-16T12:00:00.000Z" };
    const updated = { ...business, name: "Updated Local Shop" };
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/health") return json(health);
      if (path === "/api/auth/me") return json({ error: "Please log in to continue." }, 401);
      if (path === "/api/auth/register") return json({ user }, 201);
      if (path === "/api/auth/logout") return new Response(null, { status: 204 });
      if (path === "/api/businesses") return options?.method === "POST" ? json({ business }, 201) : json({ businesses: [] });
      if (path === `/api/businesses/${business.id}` && options?.method === "PUT") return json({ business: updated });
      if (path.endsWith("/activity")) return json({ activities: [] });
      if (path.endsWith("/evidence")) return json({ evidence: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);
    await renderApp();
    await act(async () => container.querySelector<HTMLButtonElement>(".auth-form .text-button")?.click());
    await act(async () => {
      setValue("name", user.name);
      setValue("email", user.email);
      setValue("password", "local test passphrase");
      container.querySelector(".auth-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector(".business-workspace")).not.toBeNull();
    await act(async () => setValue("businessName", business.name));
    await act(async () => container.querySelector("form.profile-card")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector(".saved-profile h2")?.textContent).toBe("Business profile saved");
    expect(container.querySelector(".saved-profile-icon svg")).not.toBeNull();
    expect(container.querySelector(".saved-profile-details")?.textContent).toContain(business.name);
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
    expect(container.querySelector(".auth-form")).not.toBeNull();
  });

  it("opens existing profiles as saved cards, discards cancelled edits, and retains failed edits", async () => {
    window.history.replaceState(null, "", "/#business");
    const business = { id: "02a221ee-41f1-46c9-bc96-12401d8dcf73", name: "Saved Shop", category: "", description: "", website: "", createdAt: "2026-11-16T12:00:00.000Z", updatedAt: "2026-11-16T12:00:00.000Z" };
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/health") return json(health);
      if (path === "/api/auth/me") return json({ user: { id: "509e12ce-3028-4ed1-bdf7-329a26d470d8", name: "Test Owner", email: "owner@example.test" } });
      if (path === "/api/businesses") return json({ businesses: [business] });
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
    await act(async () => container.querySelector<HTMLButtonElement>(".business-toolbar .secondary-button")?.click());
    expect(container.querySelector(".saved-profile")).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[name="businessName"]')?.value).toBe("");
  });
});
