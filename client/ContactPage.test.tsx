// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContactPage } from "./ContactPage";

describe("contact form", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<ContactPage />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function setValue(name: string, value: string) {
    await act(async () => {
      const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
      const prototype = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function fill() {
    await setValue("name", "Test Visitor");
    await setValue("email", "visitor@example.test");
    await setValue("message", "I have a question about the product.");
  }
  async function submit() {
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("does not load account/business data or submit until explicitly requested, and shows inline validation", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(5);
    expect(container.querySelector('a[href="mailto:hello@growthpulse.live"]')).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await submit();
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(3);
    expect(document.activeElement?.getAttribute("name")).toBe("name");
    await fill();
    expect(container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0);
  });

  it("sends the selected enquiry and optional company once, waits for acceptance, then focuses confirmation", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn((_path: string, _options: RequestInit) => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetch);
    await fill();
    await setValue("company", "Fixture company");
    await act(async () => container.querySelector<HTMLInputElement>('input[value="feedback"]')!.click());
    await submit();
    await submit();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({
      category: "feedback", name: "Test Visitor", email: "visitor@example.test",
      company: "Fixture company", message: "I have a question about the product.", website: "",
    });
    expect(container.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
    expect(container.textContent).not.toContain("Thanks for reaching out.");
    await act(async () => resolve(json({ status: "accepted" })));
    expect(container.textContent).toContain("Your message has been submitted.");
    expect(document.activeElement?.textContent).toBe("Thanks for reaching out.");
    expect(container.textContent).not.toContain("delivered");
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Send another"))!.click());
    expect(container.querySelector<HTMLInputElement>('[name="email"]')?.value).toBe("");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains the draft and selected category after a server failure, without automatic retries", async () => {
    const fetch = vi.fn(async () => json({ error: "Contact is unavailable. Email hello@growthpulse.live directly." }, 503));
    vi.stubGlobal("fetch", fetch);
    await fill();
    await act(async () => container.querySelector<HTMLInputElement>('input[value="partnership"]')!.click());
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("hello@growthpulse.live");
    expect(container.querySelector<HTMLInputElement>('[name="email"]')?.value).toBe("visitor@example.test");
    expect(container.querySelector<HTMLInputElement>('input[value="partnership"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([new TypeError("Failed to fetch"), new DOMException("Timed out", "TimeoutError")])("does not claim a network failure proves non-delivery", async (error) => {
    const fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetch);
    await fill();
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("couldn't confirm");
    expect(container.textContent).not.toContain("Thanks for reaching out.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts a pending browser request when the visitor leaves", async () => {
    const fetch = vi.fn((_path: string, _options: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    await fill();
    await submit();
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    await act(async () => root.render(<div>Other page</div>));
    expect(signal.aborted).toBe(true);
  });
});
