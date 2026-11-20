import { raw, Router, type Request, type Response, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { businessInputSchema, loginSchema, registerSchema } from "../shared/contracts.js";
import { hashPassword, newSession, requestTokenHash, sessionCookie, sessionDuration, verifyPassword } from "./auth.js";
import type { Store } from "./database.js";
import { scanInputSchema } from "../shared/website.js";
import { createWebsiteScanner, type WebsiteScanner } from "./website-scanner.js";
import { publicUrl } from "./public-http.js";
import { csvImportSchema, emptyProduct, productInputSchema, websiteImportSchema } from "../shared/products.js";
import { csvProducts, websiteProducts } from "./product-imports.js";
import { createBusinessAgent, AgentError, type BusinessAgent } from "./business-agent.js";
import { understandingInputSchema, understandingReviewInputSchema, understandingTimeoutMs, type UnderstandingStreamEvent } from "../shared/understanding.js";
import type { SavedScan } from "../shared/website.js";
import { onboardingClaimSchema, previewLifetime } from "../shared/onboarding.js";
import { activeAnalysis, type AnalysisJob } from "../shared/analysis.js";
import { recordUnderstanding } from "./record-understanding.js";
import { claimWorkSlot } from "./work-slots.js";
import { growthOpportunities } from "./growth-store.js";
import { growthOpportunityId, growthOpportunitySchema, growthPlanInputSchema, growthResponseSchema } from "../shared/growth.js";
import { productAnalysisConsentSchema, productPlanInputSchema, productRewriteInputSchema } from "../shared/product-intelligence.js";
import { createProductAnalyst, productAnalysisTimeout, productAnalysisFingerprint, productFingerprint, type ProductAnalyst } from "./product-intelligence.js";
import { readSalesFile, readSalesHeaders, salesFileHash } from "./sales-imports.js";
import { salesMappingSchema } from "../shared/sales-mapping.js";
import { analyticsCurrency } from "../shared/analytics.js";
import { trafficSourceSchema } from "../shared/traffic.js";
import { readTrafficFile } from "./traffic-imports.js";
import { marketplaceAnalyseInput, marketplaceImportInput, marketplaceLimits, marketplaceMatchInput, marketplaceResearchInput, matchedMarketplaceListings, type MarketplaceProgress, type MarketplaceReport } from "../shared/marketplace.js";
import { importMarketplaceCsv, marketplaceUrl } from "./marketplace-research.js";
import { contactInputSchema, contactMailbox } from "../shared/contact.js";
import type { ContactSender } from "./contact.js";
import { catalogueFingerprint, createGrowthAdvisor, knownProductDecision, selectionIsStale, type GrowthAdvisor } from "./growth-advisor.js";
import { emptyGrowthWork, isActionGeneratedStep, manualWorkStepInputSchema, workConsentSchema, workSelectionInputSchema, workStepInputSchema, type GrowthWork } from "../shared/growth-work.js";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function createApi(store: Store, origin: string, production: boolean, scan: WebsiteScanner = createWebsiteScanner(), agent: BusinessAgent = createBusinessAgent(), productAnalyst: ProductAnalyst = createProductAnalyst(), contactSender?: ContactSender, growthAdvisor: GrowthAdvisor = createGrowthAdvisor()) {
  const api = Router();
  const cookie = { httpOnly: true, secure: production, sameSite: "lax", path: "/" } as const;
  const previewCookie = "gp_preview";
  const marketplaceCancellation = new AbortController();
  const marketplaceTasks = new Set<Promise<void>>();
  const authLimit = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Try again in 15 minutes." },
  });
  const anonymousScanLimit = rateLimit({
    windowMs: 10 * 60 * 1000, limit: 3, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "Public scan limit reached. Sign in for your own scan allowance, or wait for the cooldown." },
  });
  const contactLimit = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "Too many contact messages. Please try again in 15 minutes." },
  });
  function accountLimit(label: string) {
    return rateLimit({
      windowMs: 10 * 60 * 1000, limit: 3, standardHeaders: "draft-8", legacyHeaders: false,
      keyGenerator: async (request) => (await userFor(request)).id,
      skipFailedRequests: true,
      requestWasSuccessful: (_request, response) => !response.locals.productAnalysisReused
        && (response.statusCode < 400 || response.locals.productAnalysisAdmitted === true),
      handler: (_request, response, _next, options) => {
        const remaining = response.get("Retry-After");
        response.status(options.statusCode).json({
          error: `${label} limit reached for your account. Retry in ${remaining} seconds. Saved results are still available.`,
        });
      },
    });
  }
  const accountScanLimit = accountLimit("Fresh website scan");
  const analysisLimit = accountLimit("New AI analysis");
  const scanLimit: RequestHandler = async (request, response, next) => {
    const token = requestTokenHash(request);
    const authenticated = token && await store.sessionUser(token);
    (authenticated ? accountScanLimit : anonymousScanLimit)(request, response, next);
  };
  let activeJobStreams = 0;
  api.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && request.get("origin") !== origin) {
      throw new ApiError(403, "This request must come from the configured application origin.");
    }
    next();
  });
  let activeContactMessages = 0;
  api.post("/contact", contactLimit, async (request, response) => {
    if (!request.is("application/json")) throw new ApiError(415, "Send the contact form as JSON.");
    const input = contactInputSchema.parse(request.body);
    if (!contactSender) throw new ApiError(503, `The contact form is temporarily unavailable. Please email ${contactMailbox} directly.`);
    if (activeContactMessages >= 3) throw new ApiError(429, "The contact form is busy. Please try again shortly.");
    activeContactMessages++;
    try {
      await contactSender(input);
    } catch (error) {
      console.error("Contact email failed:", error instanceof Error ? error.name : "unknown");
      throw new ApiError(502, `We couldn't confirm your message was sent. Please email ${contactMailbox} directly.`);
    } finally {
      activeContactMessages--;
    }
    response.json({ status: "accepted" });
  });
  async function userFor(request: Request) {
    const tokenHash = requestTokenHash(request);
    const user = tokenHash ? await store.sessionUser(tokenHash) : undefined;
    if (!user) throw new ApiError(401, "Please log in to continue.");
    return user;
  }
  async function ownedBusiness(request: Request) {
    const user = await userFor(request);
    const id = z.uuid().parse(request.params.id);
    const business = await store.getBusiness(user.id, id);
    if (!business) throw new ApiError(404, "Business not found.");
    return { user, business };
  }
  function setSession(response: Response, token: string) {
    response.cookie(sessionCookie, token, { ...cookie, maxAge: sessionDuration });
  }
  api.post("/auth/register", authLimit, async (request, response) => {
    const input = registerSchema.parse(request.body);
    const passwordHash = await hashPassword(input.password);
    const user = { id: randomUUID(), name: input.name, email: input.email };
    const session = newSession();
    await store.createAccount(user, passwordHash, session.tokenHash, session.expiresAt);
    setSession(response, session.token);
    response.status(201).json({ user });
  });
  api.post("/auth/login", authLimit, async (request, response) => {
    const input = loginSchema.parse(request.body);
    const credentials = await store.credentials(input.email);
    const valid = await verifyPassword(input.password, credentials?.passwordHash);
    if (!credentials || !valid) throw new ApiError(401, "Email or password is incorrect.");
    const session = newSession();
    await store.createSession(credentials.user.id, session.tokenHash, session.expiresAt, requestTokenHash(request));
    setSession(response, session.token);
    response.json({ user: credentials.user });
  });
  api.get("/auth/me", async (request, response) => { response.json({ user: await userFor(request) }); });
  api.post("/auth/logout", async (request, response) => {
    const tokenHash = requestTokenHash(request);
    if (tokenHash) await store.deleteSession(tokenHash);
    const previewHash = requestTokenHash(request, previewCookie);
    if (previewHash) await store.discardPreview(previewHash);
    response.clearCookie(sessionCookie, cookie);
    response.clearCookie(previewCookie, cookie);
    response.status(204).end();
  });
  async function withScanSlot(response: Response, work: (signal: AbortSignal) => Promise<void>) {
    const release = claimWorkSlot();
    if (!release) throw new ApiError(429, "Two scans or analyses are already running. Please retry shortly.");
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.on("close", cancel);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(understandingTimeoutMs)]);
    try {
      await work(signal);
    } catch (error) {
      if (signal.aborted) throw new ApiError(504, "The website review was interrupted or timed out. Your profile is unchanged. Check saved website evidence before retrying.");
      throw error;
    } finally {
      release();
      response.off("close", cancel);
    }
  }
  async function runScan(request: Request, response: Response, owned?: Awaited<ReturnType<typeof ownedBusiness>>) {
    const input = scanInputSchema.parse(request.body);
    const url = publicUrl(input.url);
    const live = request.get("Accept") === "application/x-ndjson";
    const send = (event: unknown) => { if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`); };
    try {
      await withScanSlot(response, async (signal) => {
        if (live) {
          response.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
          response.flushHeaders();
        }
        const result = live ? await scan(url.href, signal, { onProgress: (progress) => send({ type: "progress", progress }) }) : await scan(url.href, signal);
        signal.throwIfAborted();
        if (owned) {
          if (live) send({ type: "progress", progress: {
            stage: "saving", startedAt: result.startedAt, updatedAt: new Date().toISOString(), url: result.requestedUrl,
            pages: result.pages.length, products: result.pages.reduce((count, page) => count + (page.productJson?.length ?? 0), 0),
            failures: result.failures.length,
          } });
          const saved = await store.saveScan(owned.user.id, owned.business.id, result);
          if (!saved) throw new ApiError(404, "Business not found.");
          if (live) { send({ type: "complete", scan: saved }); response.end(); }
          else response.status(201).json({ scan: saved });
        } else if (live) { send({ type: "complete", scan: result }); response.end(); }
        else response.json({ scan: result });
      });
    } catch (error) {
      if (!live || !response.headersSent) throw error;
      console.warn("Website scan stream stopped:", error instanceof Error ? error.name : "unknown");
      send({ type: "error", status: error instanceof ApiError ? error.status : 502,
        message: error instanceof ApiError ? error.message : "The scan could not finish. Check saved scans before explicitly trying again." });
      response.end();
    }
  }
  api.post("/website/scan", scanLimit, async (request, response) => { await runScan(request, response); });
  api.get("/onboarding/preview", async (request, response) => {
    const tokenHash = requestTokenHash(request, previewCookie);
    response.json({ preview: tokenHash ? await store.getPreview(tokenHash) : null });
  });
  api.post("/onboarding/scan", scanLimit, async (request, response) => {
    const input = scanInputSchema.parse(request.body);
    const url = publicUrl(input.url);
    await withScanSlot(response, async (signal) => {
      const result = await scan(url.href, signal);
      signal.throwIfAborted();
      const token = newSession();
      const preview = await store.savePreview(token.tokenHash, result, requestTokenHash(request, previewCookie));
      response.cookie(previewCookie, token.token, { ...cookie, maxAge: previewLifetime });
      response.json({ preview });
    });
  });
  api.post("/onboarding/claim", async (request, response) => {
    const user = await userFor(request);
    onboardingClaimSchema.parse(request.body);
    const tokenHash = requestTokenHash(request, previewCookie);
    if (!tokenHash) throw new ApiError(410, "Your public findings have expired. Read the website again to continue.");
    response.json(await store.claimPreview(user.id, tokenHash));
  });
  api.get("/businesses", async (request, response) => {
    response.json({ businesses: await store.listBusinesses((await userFor(request)).id) });
  });
  api.post("/businesses", async (request, response) => {
    const user = await userFor(request);
    const input = businessInputSchema.parse(request.body);
    response.status(201).json({ business: await store.saveBusiness(user.id, input) });
  });
  api.get("/businesses/:id", async (request, response) => {
    response.json({ business: (await ownedBusiness(request)).business });
  });
  api.put("/businesses/:id", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    const input = businessInputSchema.parse(request.body);
    const saved = await store.saveBusiness(user.id, input, business.id);
    if (!saved) throw new ApiError(404, "Business not found.");
    response.json({ business: saved });
  });
  api.get("/businesses/:id/activity", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json({ activities: await store.listActivity(user.id, business.id) });
  });
  api.get("/businesses/:id/evidence", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json({ evidence: await store.listEvidence(user.id, business.id) });
  });
  const salesLimit = rateLimit({
    windowMs: 10 * 60 * 1000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: async (request) => (await userFor(request)).id,
    message: { error: "Sales import limit reached for your account. Retry in 10 minutes. Saved sales and scenarios remain available." },
  });
  api.get("/businesses/:id/analytics", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json({ analytics: await store.salesData(user.id, business.id) });
  });
  let importing = false;
  api.post("/businesses/:id/sales-imports", async (request, _response, next) => { await ownedBusiness(request); next(); }, salesLimit,
    raw({ type: ["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], limit: "32mb" }),
    async (request, response) => {
      const { user, business } = await ownedBusiness(request);
      const currency = analyticsCurrency.parse(request.query.currency);
      const filename = z.string().trim().min(1).max(180).parse(request.query.filename);
      if (!Buffer.isBuffer(request.body)) throw new ApiError(400, "Upload CSV as text/csv or XLSX with its spreadsheet content type.");
      if (importing) throw new ApiError(429, "Another sales file is being read. Retry shortly.");
      importing = true;
      try {
        const format = request.is("text/csv") ? "csv" : "xlsx";
        const mode = z.enum(["headers", "preview"]).default("preview").parse(request.query.mode);
        if (mode === "headers") {
          response.json(await readSalesHeaders(request.body, format));
          return;
        }
        let mapping;
        if (request.query.mapping !== undefined) {
          const serialized = z.string().max(1000).parse(request.query.mapping);
          let parsed: unknown;
          try { parsed = JSON.parse(serialized); }
          catch { throw new ApiError(400, "Column mapping must be a JSON array of fields or null for skipped columns."); }
          mapping = salesMappingSchema.parse(parsed);
        }
        const snapshot = await readSalesFile(request.body, format, currency, mapping);
        response.status(201).json({ draft: await store.previewSales(user.id, business.id, filename, salesFileHash(request.body, { format, currency, mapping }), snapshot) });
      } finally { importing = false; }
    });
  const salesVersion = z.string().regex(/^[a-f0-9]{24}$/);
  api.post("/businesses/:id/sales-imports/:importId/commit", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    const input = z.object({ expectedVersion: salesVersion, confirmRejected: z.boolean() }).strict().parse(request.body);
    response.json({ analytics: await store.commitSales(user.id, business.id, z.uuid().parse(request.params.importId), input.expectedVersion, input.confirmRejected) });
  });
  api.post("/businesses/:id/analytics/manual", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    const input = z.object({ expectedVersion: salesVersion, entry: z.unknown() }).strict().parse(request.body);
    response.status(201).json({ analytics: await store.saveManualSales(user.id, business.id, input.entry, input.expectedVersion) });
  });
  api.post("/businesses/:id/analytics/scenarios", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    const input = z.object({ expectedVersion: salesVersion, scenario: z.unknown() }).strict().parse(request.body);
    response.status(201).json({ analytics: await store.saveSalesScenario(user.id, business.id, input.scenario, input.expectedVersion) });
  });
  api.post("/businesses/:id/traffic-imports", async (request, _response, next) => { await ownedBusiness(request); next(); }, salesLimit,
    raw({ type: "text/csv", limit: "1mb" }), async (request, response) => {
      const { user, business } = await ownedBusiness(request);
      const filename = z.string().trim().min(1).max(180).parse(request.query.filename);
      const sourceName = trafficSourceSchema.parse(request.query.sourceName);
      if (!Buffer.isBuffer(request.body)) throw new ApiError(400, "Upload a traffic CSV with Content-Type text/csv.");
      response.status(201).json({ draft: await store.previewTraffic(user.id, business.id, filename, sourceName, salesFileHash(request.body), readTrafficFile(request.body)) });
    });
  api.post("/businesses/:id/traffic-imports/:importId/commit", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    const input = z.object({ expectedVersion: salesVersion, sameBusiness: z.literal(true) }).strict().parse(request.body);
    response.json({ analytics: await store.commitTraffic(user.id, business.id, z.uuid().parse(request.params.importId), input.expectedVersion, input.sameBusiness) });
  });
  async function growthSnapshot(request: Request) {
    const { user, business } = await ownedBusiness(request);
    const url = business.website ? new URL(business.website).href : "";
    const saved = await store.latestUnderstanding(user.id, business.id, url);
    const previous = await store.lastSuccessfulUnderstanding(user.id, business.id);
    let report = saved?.research;
    let evidenceSavedAt = saved?.createdAt ?? null;
    if (!growthOpportunities(business.id, report).length && growthOpportunities(business.id, previous?.research).length) {
      report = previous?.research;
      evidenceSavedAt = previous?.createdAt ?? null;
    }
    const job = await store.latestAnalysisWithSuggestions(user.id, business.id, url);
    if (job?.research && (!growthOpportunities(business.id, report).length || Date.parse(job.updatedAt) >= Date.parse(evidenceSavedAt ?? ""))) {
      report = job.research ?? undefined;
      evidenceSavedAt = job.updatedAt;
    }
    return {
      user, business,
      snapshot: growthResponseSchema.parse({
        opportunities: growthOpportunities(business.id, report),
        plan: await store.listGrowthPlan(user.id, business.id),
        researchStatus: report?.status ?? "unavailable",
        evidenceSavedAt: report ? evidenceSavedAt : null,
      }),
    };
  }
  api.get("/businesses/:id/growth", async (request, response) => {
    response.json((await growthSnapshot(request)).snapshot);
  });
  api.get("/businesses/:id/weekly-review", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json(await store.weeklyReview(user.id, business.id));
  });
  api.post("/businesses/:id/weekly-review", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.status(201).json(await store.saveWeeklyReview(user.id, business.id, request.body));
  });
  api.post("/businesses/:id/action-measurements", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.status(201).json(await store.startActionMeasurement(user.id, business.id, request.body));
  });
  api.post("/businesses/:id/action-measurements/:measurementId/decision", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json(await store.decideActionMeasurement(user.id, business.id, z.uuid().parse(request.params.measurementId), request.body));
  });
  api.post("/businesses/:id/growth/:opportunityId/plan", async (request, response) => {
    z.object({}).strict().parse(request.body);
    const id = growthOpportunityId.parse(request.params.opportunityId);
    const { user, business, snapshot } = await growthSnapshot(request);
    const existing = snapshot.plan.find((item) => item.opportunity.id === id);
    const opportunity = snapshot.opportunities.find((item) => item.id === id);
    if (!existing && !opportunity) throw new ApiError(404, "This opportunity is no longer in saved research. Reload Growth intelligence.");
    response.status(existing ? 200 : 201).json({ item: existing ?? await store.addGrowthPlan(user.id, business.id, opportunity!) });
  });
  api.patch("/businesses/:id/growth/:opportunityId/plan", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json({ item: await store.updateGrowthPlan(user.id, business.id, growthOpportunityId.parse(request.params.opportunityId), growthPlanInputSchema.parse(request.body)) });
  });
  async function actionSnapshot(request: Request) {
    const { user, business, snapshot } = await growthSnapshot(request);
    const id = growthOpportunityId.parse(request.params.opportunityId);
    const item = snapshot.plan.find((entry) => entry.opportunity.id === id) ?? null;
    const opportunity = item?.opportunity ?? snapshot.opportunities.find((entry) => entry.id === id);
    if (!opportunity) throw new ApiError(404, "This recommendation is no longer available for this business.");
    const products = await store.listProducts(user.id, business.id);
    const fingerprint = catalogueFingerprint(products);
    const decision = opportunity.work?.decision ?? knownProductDecision(opportunity, business.id, products, origin);
    const stale = opportunity.work?.selection ? selectionIsStale(opportunity.work.selection, products)
      : !!decision && decision.catalogueFingerprint !== fingerprint;
    return { user, business, products, item, opportunity,
      response: { configured: growthAdvisor.configured, opportunity, item, products, decision, stale, catalogueFingerprint: fingerprint } };
  }
  async function saveActionWork(request: Request, revision: number, work: GrowthWork) {
    const { user, business, item } = await actionSnapshot(request);
    if (!item) throw new ApiError(409, "Add this recommendation to your growth plan before connecting work.");
    await store.updateGrowthWork(user.id, business.id, item.opportunity.id, revision, work);
    return (await actionSnapshot(request)).response;
  }
  api.get("/businesses/:id/growth/:opportunityId/work", async (request, response) => {
    response.json((await actionSnapshot(request)).response);
  });
  api.patch("/businesses/:id/growth/:opportunityId/work/selection", async (request, response) => {
    const input = workSelectionInputSchema.parse(request.body);
    const current = await actionSnapshot(request);
    if (current.response.catalogueFingerprint !== input.catalogueFingerprint) throw new ApiError(409, "The catalogue changed. Reload and review the current products before confirming.");
    const selected = input.productIds.map((id) => {
      const product = current.products.find((entry) => entry.id === id);
      if (!product) throw new ApiError(404, "A selected product is not available in this business.");
      return { productId: product.id, fingerprint: productFingerprint(product) };
    }).sort((left, right) => left.productId.localeCompare(right.productId));
    const work = current.opportunity.work ?? emptyGrowthWork();
    const changed = !!work.selection && (work.selection.scope !== input.scope
      || JSON.stringify([...work.selection.products].sort((left, right) => left.productId.localeCompare(right.productId))) !== JSON.stringify(selected));
    if (changed && work.steps.some((step) => step.status !== "draft")) {
      throw new ApiError(409, "This action has reviewed work. Return those steps to draft before changing its targets, or keep this work as a separate action.");
    }
    response.json(await saveActionWork(request, input.revision, {
      ...work, decision: work.decision ?? current.response.decision,
      selection: { scope: input.scope, products: selected, confirmedAt: new Date().toISOString() },
      steps: changed ? work.steps.filter((step) => !isActionGeneratedStep(step)) : work.steps,
    }));
  });
  const activeActionGuidance = new Set<string>();
  async function generateActionGuidance(request: Request, response: Response, kind: "decision" | "steps") {
    const input = workConsentSchema.parse(request.body);
    const current = await actionSnapshot(request);
    if (!current.item || current.item.revision !== input.revision) throw new ApiError(409, "Save or reload this growth action before requesting guidance.");
    const work = current.opportunity.work ?? emptyGrowthWork();
    if (kind === "decision" && current.response.decision?.catalogueFingerprint === current.response.catalogueFingerprint) {
      response.locals.productAnalysisReused = true;
      response.json(current.response); return;
    }
    if (kind === "steps" && (!work.selection || current.response.stale)) throw new ApiError(409, "Confirm current targets before requesting action-specific steps.");
    if (kind === "steps" && work.steps.some(isActionGeneratedStep)) {
      response.locals.productAnalysisReused = true;
      response.json(current.response); return;
    }
    if (!growthAdvisor.configured) throw new ApiError(503, "Action AI guidance is not configured. Choose targets and record work manually.");
    const key = `${current.business.id}:${current.opportunity.id}`;
    if (activeActionGuidance.has(key)) throw new ApiError(409, "Guidance for this action is already running. Reload saved work before trying again.");
    const release = claimWorkSlot();
    if (!release) throw new ApiError(429, "Analysis capacity is busy. Saved work is still available.");
    activeActionGuidance.add(key); response.locals.productAnalysisAdmitted = true;
    const disconnected = new AbortController();
    const abort = () => { if (!response.writableEnded) disconnected.abort(); };
    response.once("close", abort);
    const signal = AbortSignal.any([disconnected.signal, marketplaceCancellation.signal, AbortSignal.timeout(productAnalysisTimeout)]);
    try {
      const updated = kind === "decision"
        ? { ...work, decision: await growthAdvisor.decide(current.opportunity, current.business.id, current.products, origin, signal) }
        : { ...work, steps: [...work.steps, ...await growthAdvisor.propose(current.opportunity, work.selection!, current.business.id, current.products, origin, signal)] };
      signal.throwIfAborted();
      const fresh = await actionSnapshot(request);
      if (fresh.response.catalogueFingerprint !== current.response.catalogueFingerprint) throw new ApiError(409, "The catalogue changed during guidance. Nothing was saved; review current records before trying again.");
      signal.throwIfAborted();
      response.json(await saveActionWork(request, input.revision, updated));
    } catch (error) {
      if (signal.aborted) throw new AgentError(504, "Action guidance timed out or was interrupted. Reload saved work before trying again.");
      throw error;
    } finally {
      response.off("close", abort); activeActionGuidance.delete(key); release();
    }
  }
  api.post("/businesses/:id/growth/:opportunityId/work/decision", analysisLimit, async (request, response) => {
    await generateActionGuidance(request, response, "decision");
  });
  api.post("/businesses/:id/growth/:opportunityId/work/proposals", analysisLimit, async (request, response) => {
    await generateActionGuidance(request, response, "steps");
  });
  api.post("/businesses/:id/growth/:opportunityId/work/steps", async (request, response) => {
    const input = manualWorkStepInputSchema.parse(request.body);
    const current = await actionSnapshot(request);
    const work = current.opportunity.work ?? emptyGrowthWork();
    response.json(await saveActionWork(request, input.revision, { ...work, steps: [...work.steps, {
      id: createHash("sha256").update(randomUUID()).digest("hex"), title: input.title, detail: input.detail,
      sources: current.opportunity.sources.slice(0, 6), status: "draft", outcome: "", origin: "owner",
    }] }));
  });
  api.patch("/businesses/:id/growth/:opportunityId/work/steps", async (request, response) => {
    const input = workStepInputSchema.parse(request.body);
    const current = await actionSnapshot(request);
    const work = current.opportunity.work ?? emptyGrowthWork();
    if (!work.steps.some((step) => step.id === input.stepId)) throw new ApiError(404, "This supporting step is no longer available.");
    response.json(await saveActionWork(request, input.revision, {
      ...work, steps: work.steps.map((step) => step.id === input.stepId ? { ...step, status: input.status, outcome: input.outcome } : step),
    }));
  });
  api.get("/businesses/:id/understanding", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json({
      understanding: await store.latestUnderstanding(user.id, business.id, business.website ? new URL(business.website).href : ""),
      lastSuccessfulUnderstanding: await store.lastSuccessfulUnderstanding(user.id, business.id),
      job: await store.latestAnalysisJob(user.id, business.id),
    });
  });
  api.get("/businesses/:id/analysis-jobs/:jobId", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    const job = await store.getAnalysisJob(user.id, business.id, z.uuid().parse(request.params.jobId));
    if (!job) throw new ApiError(404, "Analysis not found.");
    response.json({ job });
  });
  api.post("/businesses/:id/analysis-jobs/:jobId/cancel", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json({ job: await store.cancelAnalysis(user.id, business.id, z.uuid().parse(request.params.jobId)) });
  });
  api.get("/businesses/:id/analysis-jobs/:jobId/events", async (request, response, next) => {
    const { user, business } = await ownedBusiness(request);
    const id = z.uuid().parse(request.params.jobId);
    const first = await store.getAnalysisJob(user.id, business.id, id);
    if (!first) throw new ApiError(404, "Analysis not found.");
    if (activeJobStreams >= 20) throw new ApiError(429, "Too many analysis viewers are connected. Your background work continues; reconnect shortly.");
    activeJobStreams++;
    response.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
    response.flushHeaders();
    let revision = -1;
    let polling = false;
    const interval = setInterval(async () => {
      if (polling || closed) return;
      polling = true;
      try {
        const job = await store.getAnalysisJob(user.id, business.id, id);
        if (!job) throw new ApiError(404, "Analysis not found.");
        if (!closed) send(job);
      } catch (error) { if (!closed) { cleanup(); next(error); } }
      finally { polling = false; }
    }, 500);
    const lifetime = setTimeout(() => response.end(), 20_000);
    let closed = false;
    function cleanup() {
      if (closed) return;
      closed = true; activeJobStreams--;
      clearInterval(interval); clearTimeout(lifetime);
      marketplaceCancellation.signal.removeEventListener("abort", endStream);
    }
    function endStream() { cleanup(); response.end(); }
    marketplaceCancellation.signal.addEventListener("abort", endStream, { once: true });
    function send(job: AnalysisJob) {
      if (response.destroyed || response.writableEnded || response.writableNeedDrain) return;
      if (job.revision !== revision) {
        response.write(`${JSON.stringify({ type: "job", job })}\n`);
        revision = job.revision;
      }
      if (!activeAnalysis(job)) response.end();
    }
    response.once("close", cleanup);
    send(first);
  });
  api.post("/businesses/:id/understanding/:reviewId/apply", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    const reviewId = z.uuid().parse(request.params.reviewId);
    const input = understandingReviewInputSchema.parse(request.body);
    response.json(await store.applyUnderstanding(user.id, business.id, reviewId, input));
  });
  async function analysisInput(request: Request) {
    const { user, business } = await ownedBusiness(request);
    const input = understandingInputSchema.parse(request.body);
    if ((input.research || input.resumeJobId) && request.get("Prefer") !== "respond-async") {
      throw new ApiError(400, "Wider research and resuming require a queued analysis request.");
    }
    if (input.research && input.researchVersion !== 2) {
      throw new ApiError(400, "Market research now has a larger search and AI budget. Reload and confirm the updated research permission before starting.");
    }
    if (!business.website) throw new ApiError(400, "Add a public website to your profile first, or continue with manual information and CSV.");
    const url = publicUrl(business.website);
    const existingScan = input.scanId ? await store.getScan(user.id, business.id, input.scanId) : await store.reusableScan(user.id, business.id, url.href);
    if (input.scanId && (!existingScan || existingScan.requestedUrl !== url.href)) throw new ApiError(404, "Matching saved website evidence was not found for this business.");
    if (existingScan && (existingScan.status === "failed" || !existingScan.pages.length)) throw new ApiError(400, "No public pages were captured. Read the website again before requesting an AI briefing.");
    return { user, business, input, url, existingScan };
  }
  function queued(response: Response, job: AnalysisJob) {
    response.status(202).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform" })
      .end(`${JSON.stringify({ type: "job", job })}\n`);
  }
  api.post("/businesses/:id/understanding", async (request, response, next) => {
    const { user, business, input, url } = await analysisInput(request);
    if (request.get("Prefer") === "respond-async") {
      const key = z.uuid().parse(request.get("Idempotency-Key"));
      const existing = await store.matchingAnalysisJob(user.id, business.id, key, url.href, input.scanId, input.research, input.resumeJobId, input.reuseCustomerEvidence);
      if (existing) { queued(response, existing); return; }
    }
    if (!agent.configured) throw new AgentError(503, "Your profile is saved. To enable your business agent, set ANTHROPIC_API_KEY on the server and restart it. Manual entry and CSV remain available.");
    next();
  }, analysisLimit, async (request, response, next) => {
    if ((await analysisInput(request)).existingScan) next();
    else accountScanLimit(request, response, next);
  }, async (request, response) => {
    const { user, business, input, url, existingScan } = await analysisInput(request);
    if (!agent.configured) throw new AgentError(503, "Your profile is saved. To enable your business agent, set ANTHROPIC_API_KEY on the server and restart it. Manual entry and CSV remain available.");
    if (request.get("Prefer") === "respond-async") {
      queued(response, await store.enqueueAnalysis(user.id, business.id, z.uuid().parse(request.get("Idempotency-Key")), url.href, input.scanId, input.research, input.resumeJobId, existingScan?.id, input.reuseCustomerEvidence));
      return;
    }
    const streaming = request.accepts(["application/json", "application/x-ndjson"]) === "application/x-ndjson";
    await withScanSlot(response, async (signal) => {
      const frame = (event: UnderstandingStreamEvent) => `${JSON.stringify(event)}\n`;
      if (streaming) {
        response.status(200).set({
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        });
        response.flushHeaders();
      }
      let savedScan: SavedScan | undefined = existingScan;
      const proposal = await agent.run(url.href, async () => {
        if (existingScan) return existingScan;
        const result = await scan(url.href, signal);
        savedScan = await store.saveScan(user.id, business.id, result);
        if (!savedScan) throw new ApiError(404, "Business not found.");
        return savedScan;
      }, signal, streaming ? (update) => {
        // Updates are replaceable snapshots; don't queue them behind a slow reader.
        if (!response.destroyed && !response.writableNeedDrain) response.write(frame(update));
      } : undefined);
      signal.throwIfAborted();
      if (!savedScan) throw new AgentError(502, "The agent did not capture website evidence. Nothing was applied.");
      const understanding = await recordUnderstanding(store, user.id, business.id, savedScan, proposal);
      if (streaming) response.end(frame({ type: "complete", understanding }));
      else response.status(201).json({ understanding });
    });
  });
  api.post("/businesses/:id/scans", async (request, response, next) => {
    await ownedBusiness(request);
    next();
  }, scanLimit, async (request, response) => { await runScan(request, response, await ownedBusiness(request)); });
  api.get("/businesses/:id/scans", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json({ scans: await store.listScans(user.id, business.id) });
  });
  api.get("/businesses/:id/scans/:scanId", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    const saved = await store.getScan(user.id, business.id, z.uuid().parse(request.params.scanId));
    if (!saved) throw new ApiError(404, "Scan not found.");
    response.json({ scan: saved });
  });
  api.get("/businesses/:id/products", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json({ products: await store.listProducts(user.id, business.id) });
  });
  async function ownedProduct(request: Request) {
    const { user, business } = await ownedBusiness(request);
    const id = z.uuid().parse(request.params.productId);
    const product = (await store.listProducts(user.id, business.id)).find((item) => item.id === id);
    if (!product) throw new ApiError(404, "Product not found.");
    return { user, business, product };
  }
  async function productSnapshot(request: Request) {
    const { user, business, product } = await ownedProduct(request);
    return { configured: productAnalyst.configured,
      ...await store.productAnalysisState(user.id, business.id, product.id, productAnalysisFingerprint(product)) };
  }
  async function marketplaceSnapshot(request: Request) {
    const { user, business, product } = await ownedProduct(request);
    return { configured: agent.marketplace?.configured ?? false, discoveryConfigured: agent.marketplace?.discoveryConfigured ?? false,
      ...await store.marketplaceState(user.id, business.id, product.id, productFingerprint(product)) };
  }
  async function currentMarketplace(request: Request, reportId: string) {
    const current = await marketplaceSnapshot(request);
    if (!current.report || current.stale || current.report.id !== reportId) throw new ApiError(409, "The product or marketplace evidence changed. Reload current evidence before continuing.");
    if (current.running) throw new ApiError(409, "Marketplace research is already running. Saved evidence remains available.");
    return current.report;
  }
  async function marketplaceTask(request: Request, response: Response, requestKey: string, inputHash: string,
    work: (signal: AbortSignal, progress: (value: MarketplaceProgress) => Promise<void>) => Promise<MarketplaceReport>,
    stage: MarketplaceProgress["stage"] = "discovering") {
    const { user, business, product } = await ownedProduct(request);
    const release = claimWorkSlot();
    if (!release) throw new ApiError(429, "Analysis capacity is busy. Saved evidence remains available; try again shortly.");
    let task: Awaited<ReturnType<Store["beginMarketplace"]>>;
    try { task = await store.beginMarketplace(user.id, business.id, product.id, productFingerprint(product), requestKey, inputHash); }
    catch (error) { release(); throw error; }
    if (!task.started) {
      release();
      response.locals.productAnalysisReused = true;
      response.status(202).json(await marketplaceSnapshot(request));
      return;
    }
    response.locals.productAnalysisAdmitted = true;
    const signal = AbortSignal.any([marketplaceCancellation.signal, AbortSignal.timeout(marketplaceLimits.milliseconds)]);
    const startedAt = new Date().toISOString();
    // Persist status before returning; browser disconnects never restart paid work.
    const pending = Promise.resolve().then(async () => {
      try {
        const progress = (value: MarketplaceProgress) => store.updateMarketplaceProgress(user.id, business.id, product.id, task.id,
          { ...value, startedAt, updatedAt: new Date().toISOString() });
        await progress({ stage, completed: 0, total: 0 });
        const result = await work(signal, progress);
        signal.throwIfAborted();
        await store.finishMarketplace(user.id, business.id, product.id, task.id, result);
      } catch (error) {
        console.warn("Marketplace research failed:", { kind: signal.aborted ? "timeout" : error instanceof Error ? error.name : "unknown" });
        const message = signal.aborted ? "Marketplace research was interrupted or timed out. Previous evidence remains available. No automatic retry was made."
          : error instanceof AgentError ? error.message : "Marketplace research could not finish. Previous evidence remains available. No automatic retry was made.";
        await store.failMarketplace(user.id, business.id, product.id, task.id, message);
      } finally { release(); }
    }).catch((error: unknown) => console.error("Unable to persist marketplace job status:", error instanceof Error ? error.name : "unknown"))
      .finally(() => { marketplaceTasks.delete(pending); });
    marketplaceTasks.add(pending);
    response.status(202).json(await marketplaceSnapshot(request));
  }
  api.get("/businesses/:id/products/:productId/marketplace", async (request, response) => {
    response.json(await marketplaceSnapshot(request));
  });
  api.post("/businesses/:id/products/:productId/marketplace", async (request, response, next) => {
    const input = marketplaceResearchInput.parse(request.body);
    const { user, business, product } = await ownedProduct(request);
    const urls = input.urls.map((url) => {
      const canonical = marketplaceUrl(url);
      if (!canonical) throw new ApiError(400, "Use Amazon India or Flipkart product listing URLs, not search, login or account pages.");
      return canonical;
    });
    const inputHash = createHash("sha256").update(JSON.stringify([productFingerprint(product), urls, input.refresh])).digest("hex");
    const state = await marketplaceSnapshot(request);
    if (await store.marketplaceRequest(user.id, business.id, product.id, input.requestKey, inputHash)
      || state.running || !input.refresh && !urls.length && state.report && !state.stale) {
      response.json(state); return;
    }
    if (!agent.marketplace) throw new ApiError(503, "Marketplace research is not configured. Authorized review imports and saved evidence remain available.");
    if (!urls.length && (!agent.marketplace.configured || !agent.marketplace.discoveryConfigured)) throw new ApiError(503, "Automatic discovery needs the server's existing Anthropic and Tavily configuration. Supply listing URLs or an authorized review CSV instead.");
    response.locals.marketplaceInput = { input, urls, inputHash };
    next();
  }, analysisLimit, async (request, response) => {
    const { business, product } = await ownedProduct(request);
    const { input, urls, inputHash } = response.locals.marketplaceInput as {
      input: z.infer<typeof marketplaceResearchInput>; urls: string[]; inputHash: string;
    };
    const capability = agent.marketplace;
    if (!capability) throw new ApiError(503, "Marketplace research is not configured.");
    await marketplaceTask(request, response, input.requestKey, inputHash, (signal, progress) => capability.discover(product, business.category, urls, signal, progress));
  });
  api.post("/businesses/:id/products/:productId/marketplace/import", async (request, _response, next) => {
    await ownedProduct(request); next();
  }, salesLimit, async (request, response) => {
    const { user, business, product } = await ownedProduct(request);
    const input = marketplaceImportInput.parse(request.body);
    const result = importMarketplaceCsv(product, input.csv);
    const task = await store.beginMarketplace(user.id, business.id, product.id, result.fingerprint, randomUUID(), createHash("sha256").update(input.csv).digest("hex"));
    await store.finishMarketplace(user.id, business.id, product.id, task.id, result);
    response.status(201).json(await marketplaceSnapshot(request));
  });
  api.patch("/businesses/:id/products/:productId/marketplace/match", async (request, response) => {
    const { user, business, product } = await ownedProduct(request);
    const input = marketplaceMatchInput.parse(request.body);
    const saved = await currentMarketplace(request, input.reportId);
    const found = saved.listings.find((item) => item.id === input.listingId);
    if (!found) throw new ApiError(404, "Marketplace listing not found.");
    if (found.status !== "captured" && input.relation !== "excluded") throw new ApiError(400, "This listing has no captured product evidence to confirm.");
    await store.updateMarketplace(user.id, business.id, product.id, saved, { ...saved, themes: [], comparisons: [], analysisVersion: undefined, analysedAt: null,
      listings: saved.listings.map((item) => item.id === input.listingId ? { ...item, relation: input.relation,
        matching: { method: "owner", reason: "Relationship selected by the owner." } } : item) });
    response.json(await marketplaceSnapshot(request));
  });
  api.post("/businesses/:id/products/:productId/marketplace/analyse", async (request, response, next) => {
    const { product } = await ownedProduct(request);
    const input = marketplaceAnalyseInput.parse(request.body);
    const state = await marketplaceSnapshot(request);
    if (state.running) { response.json(state); return; }
    const saved = await currentMarketplace(request, input.reportId);
    if (saved.analysedAt && saved.analysisVersion === 2) { response.json(state); return; }
    if (!agent.marketplace?.configured) throw new ApiError(503, "Marketplace AI analysis is not configured. Saved evidence remains available.");
    const available = saved.matchingVersion === 1 ? matchedMarketplaceListings(saved)
      : saved.listings.filter((item) => item.status === "captured" && item.relation !== "excluded"
        && !(item.relation === "unconfirmed" && item.matching?.method === "owner"));
    if (available.flatMap((item) => item.reviews).length < 2) {
      throw new ApiError(400, "At least two relevant review excerpts are needed. Find more feedback or review uncertain product matches.");
    }
    response.locals.marketplaceAnalysis = { saved, product };
    next();
  }, analysisLimit, async (request, response) => {
    const { saved, product } = response.locals.marketplaceAnalysis as { saved: MarketplaceReport; product: Awaited<ReturnType<typeof ownedProduct>>["product"] };
    const capability = agent.marketplace;
    if (!capability) throw new ApiError(503, "Marketplace analysis is not configured.");
    await marketplaceTask(request, response, randomUUID(), createHash("sha256").update(JSON.stringify(saved)).digest("hex"),
      (signal) => capability.analyse(saved, product, signal), "analysing");
  });
  api.get("/businesses/:id/product-intelligence", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    const products = await store.listProducts(user.id, business.id);
    response.json({ analyses: (await store.productAnalysisSummaries(user.id, business.id))
      .filter((item) => products.some((product) => product.id === item.productId && productAnalysisFingerprint(product) === item.fingerprint)) });
  });
  api.get("/businesses/:id/products/:productId/intelligence", async (request, response) => {
    response.json(await productSnapshot(request));
  });
  const activeProductAnalyses = new Map<string, Promise<void>>();
  api.post("/businesses/:id/products/:productId/intelligence", async (request, response, next) => {
    productAnalysisConsentSchema.parse(request.body);
    const { product } = await ownedProduct(request);
    const current = await productSnapshot(request);
    if (current.analysis && !current.stale) { response.json(current); return; }
    const pending = activeProductAnalyses.get(`${product.id}:${productAnalysisFingerprint(product)}`);
    if (pending) {
      if (request.get("Prefer") !== "respond-async") await pending;
      response.status(request.get("Prefer") === "respond-async" ? 202 : 200).json(await productSnapshot(request)); return;
    }
    if (!productAnalyst.configured) throw new ApiError(503, "Product AI analysis is not configured on this server. Your catalogue remains available.");
    if (current.running) throw new ApiError(409, "This product already has an analysis running. Reload its saved status instead of starting another.");
    next();
  }, analysisLimit, async (request, response) => {
    const { user, business, product } = await ownedProduct(request);
    const fingerprint = productAnalysisFingerprint(product), key = `${product.id}:${fingerprint}`;
    const existing = activeProductAnalyses.get(key), current = await productSnapshot(request);
    if (existing || current.analysis && !current.stale) {
      response.locals.productAnalysisReused = true;
      if (existing && request.get("Prefer") !== "respond-async") await existing;
      response.status(existing && request.get("Prefer") === "respond-async" ? 202 : 200).json(await productSnapshot(request)); return;
    }
    const release = claimWorkSlot();
    if (!release) throw new ApiError(429, "Analysis capacity is busy. Saved results are still available; try again shortly.");
    let leaseUntil: number;
    try { leaseUntil = await store.beginProductAnalysis(user.id, business.id, product.id, fingerprint); }
    catch (error) { release(); throw error; }
    response.locals.productAnalysisAdmitted = true;
    const pending = Promise.resolve().then(async () => {
      try {
        const signal = AbortSignal.any([marketplaceCancellation.signal, AbortSignal.timeout(productAnalysisTimeout)]);
        signal.throwIfAborted();
        const latestScan = (await store.listScans(user.id, business.id)).find((scan) => scan.status !== "failed");
        const captured = latestScan ? await store.getScan(user.id, business.id, latestScan.id) : undefined;
        const analysis = await productAnalyst.run(product, signal, (progress) =>
          store.updateProductAnalysisProgress(user.id, business.id, product.id, fingerprint, leaseUntil, progress), captured?.pages);
        signal.throwIfAborted();
        if (analysis.productId !== product.id || analysis.fingerprint !== fingerprint) throw new AgentError(502, "The AI returned an analysis for different product evidence. Nothing was changed.");
        await store.finishProductAnalysis(user.id, business.id, analysis, leaseUntil);
      } catch (error) {
        if (!(error instanceof AgentError)) console.error("Product analysis failed:", error instanceof Error ? error.name : "unknown");
        const failure = error instanceof AgentError ? error : new AgentError(502, "Product analysis could not finish. Nothing was changed. No automatic retry was made.");
        await store.failProductAnalysis(user.id, business.id, product.id, fingerprint, failure.message, leaseUntil);
        throw failure;
      }
    }).finally(() => { release(); activeProductAnalyses.delete(key); });
    activeProductAnalyses.set(key, pending);
    if (request.get("Prefer") === "respond-async") {
      void pending.catch((error: unknown) => console.warn("Background product analysis stopped:", error instanceof Error ? error.name : "unknown"));
      response.status(202).json(await productSnapshot(request)); return;
    }
    await pending;
    response.json(await productSnapshot(request));
  });
  api.post("/businesses/:id/products/:productId/approve-listing", async (request, response) => {
    const { user, business, product } = await ownedProduct(request);
    const input = productRewriteInputSchema.parse(request.body);
    const state = await productSnapshot(request);
    if (!state.analysis || state.stale || state.analysis.id !== input.analysisId) throw new ApiError(409, "The product or analysis changed. Reload and review a current suggestion before saving.");
    const manual = product.listings.find((listing) => listing.source === "manual");
    response.json({ product: await store.saveProduct(user.id, business.id, {
      ...(manual?.data ?? emptyProduct), name: input.title, description: input.description, sku: product.sku, gtin: product.gtin,
    }, product.id) });
  });
  api.post("/businesses/:id/products/:productId/growth-plan", async (request, response) => {
    const { user, business, product } = await ownedProduct(request);
    const input = productPlanInputSchema.parse(request.body);
    const state = await productSnapshot(request);
    if (!state.analysis || state.stale || state.analysis.id !== input.analysisId) throw new ApiError(409, "Reload and review a current product analysis before planning this recommendation.");
    const analysis = state.analysis;
    const recommendation = analysis.result.recommendations[input.index];
    if (!recommendation) throw new ApiError(404, "Product recommendation not found.");
    const reference = new URL(`/#products?${new URLSearchParams({ business: business.id, product: product.id })}`, origin).href;
    const opportunity = growthOpportunitySchema.parse({
      id: createHash("sha256").update(`product:${business.id}:${product.id}:${state.analysis.fingerprint}:${input.index}`).digest("hex"),
      title: recommendation.title, detail: recommendation.detail, agents: ["store"],
      originProductId: product.id,
      sources: recommendation.references.map((id) => {
        const evidence = analysis.evidence.find((item) => item.id === id);
        if (!evidence) throw new ApiError(409, "This saved recommendation has incomplete evidence. Review a new product analysis before planning it.");
        return { id, url: reference, quote: evidence.quote, capturedAt: evidence.capturedAt };
      }),
      reviewReason: `Product recommendation for ${product.name}, based on saved catalogue excerpts. This is not a measured growth opportunity or external market finding.`,
      strategy: {
        objective: recommendation.title,
        actions: ["Check the saved product evidence against the current listing.", recommendation.detail,
          "Review a small change with the owner before publishing it.", "Measure the result against a comparable baseline before expanding."],
        metric: "Product-page purchase conversion rate",
        hypothesis: `Test whether this product improvement helps customers: ${recommendation.title}`,
        measurement: "Connect authorized analytics and set a baseline, eligible audience, duration and success threshold. No performance is inferred from public product data.",
      },
    });
    if (input.attachTo) {
      const parent = (await store.listGrowthPlan(user.id, business.id)).find((item) => item.opportunity.id === input.attachTo!.actionId);
      if (!parent) throw new ApiError(404, "The selected growth action is not in this business's plan.");
      const work = parent.opportunity.work ?? emptyGrowthWork();
      const stepId = createHash("sha256").update(`attached:${opportunity.id}`).digest("hex");
      if (work.steps.some((step) => step.id === stepId)) { response.json({ item: parent }); return; }
      const updated = await store.updateGrowthWork(user.id, business.id, parent.opportunity.id, input.attachTo.revision, {
        ...work, steps: [...work.steps, { id: stepId, title: recommendation.title, detail: recommendation.detail,
          sources: opportunity.sources.slice(0, 6), status: "draft", outcome: "", productId: product.id, origin: "product" }],
      });
      response.json({ item: updated }); return;
    }
    const existing = (await store.listGrowthPlan(user.id, business.id)).find((item) => item.opportunity.id === opportunity.id);
    response.status(existing ? 200 : 201).json({ item: existing ?? await store.addGrowthPlan(user.id, business.id, opportunity) });
  });
  api.post("/businesses/:id/products", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.status(201).json({ product: await store.saveProduct(user.id, business.id, productInputSchema.parse(request.body)) });
  });
  api.post("/businesses/:id/scans/:scanId/catalogue", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    z.object({}).strict().parse(request.body);
    const scan = await store.getScan(user.id, business.id, z.uuid().parse(request.params.scanId));
    if (!scan) throw new ApiError(404, "Saved scan not found in this business.");
    const catalogue = await store.syncWebsiteProducts(user.id, business.id, scan);
    response.json({ catalogue: catalogue ?? null, products: await store.listProducts(user.id, business.id) });
  });
  api.put("/businesses/:id/products/:productId", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json({ product: await store.saveProduct(user.id, business.id, productInputSchema.parse(request.body), z.uuid().parse(request.params.productId)) });
  });
  const importLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Import preview limit reached. Retry in 10 minutes." } });
  api.post("/businesses/:id/product-imports/csv", importLimit, async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    const input = csvImportSchema.parse(request.body);
    response.status(201).json({ draft: await store.createProductImport(user.id, business.id, "csv", input.sourceName.toLowerCase(), csvProducts(input.csv)) });
  });
  api.post("/businesses/:id/product-imports/website", importLimit, async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    const { scanId } = websiteImportSchema.parse(request.body);
    const scan = await store.getScan(user.id, business.id, scanId);
    if (!scan) throw new ApiError(404, "Saved scan not found in this business.");
    response.status(201).json({ draft: await store.createProductImport(user.id, business.id, "website", new URL(scan.requestedUrl).hostname.replace(/^www\./, ""), websiteProducts(scan)) });
  });
  api.get("/businesses/:id/product-imports/:importId", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json({ draft: await store.getProductImport(user.id, business.id, z.uuid().parse(request.params.importId)) });
  });
  api.post("/businesses/:id/product-imports/:importId/refresh", importLimit, async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    z.object({}).strict().parse(request.body);
    const scan = await store.getProductImportScan(user.id, business.id, z.uuid().parse(request.params.importId));
    if (!scan) throw new ApiError(409, "The original saved scan could not be identified uniquely. Select a saved scan and choose Preview website products instead.");
    response.status(201).json({ draft: await store.createProductImport(user.id, business.id, "website", new URL(scan.requestedUrl).hostname.replace(/^www\./, ""), websiteProducts(scan)) });
  });
  api.post("/businesses/:id/product-imports/:importId/commit", async (request, response) => {
    const { user, business } = await ownedBusiness(request);
    response.json({ result: await store.commitProductImport(user.id, business.id, z.uuid().parse(request.params.importId), request.body) });
  });
  return Object.assign(api, {
    async stopMarketplace() {
      marketplaceCancellation.abort();
      await Promise.allSettled([...marketplaceTasks, ...activeProductAnalyses.values()]);
    },
  });
}
