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
import { createProductAnalyst, productAnalysisTimeout, productFingerprint, type ProductAnalyst } from "./product-intelligence.js";
import { readSalesFile, salesFileHash } from "./sales-imports.js";
import { analyticsCurrency } from "../shared/analytics.js";
import { trafficSourceSchema } from "../shared/traffic.js";
import { readTrafficFile } from "./traffic-imports.js";
import { marketplaceAnalyseInput, marketplaceImportInput, marketplaceLimits, marketplaceMatchInput, marketplaceResearchInput, type MarketplaceReport } from "../shared/marketplace.js";
import { importMarketplaceCsv, marketplaceUrl } from "./marketplace-research.js";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function createApi(store: Store, origin: string, production: boolean, scan: WebsiteScanner = createWebsiteScanner(), agent: BusinessAgent = createBusinessAgent(), productAnalyst: ProductAnalyst = createProductAnalyst()) {
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
  function accountLimit(label: string) {
    return rateLimit({
      windowMs: 10 * 60 * 1000, limit: 3, standardHeaders: "draft-8", legacyHeaders: false,
      keyGenerator: (request) => userFor(request).id,
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
  const scanLimit: RequestHandler = (request, response, next) => {
    const token = requestTokenHash(request);
    const authenticated = token && store.sessionUser(token);
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
  function userFor(request: Request) {
    const tokenHash = requestTokenHash(request);
    const user = tokenHash ? store.sessionUser(tokenHash) : undefined;
    if (!user) throw new ApiError(401, "Please log in to continue.");
    return user;
  }
  function ownedBusiness(request: Request) {
    const user = userFor(request);
    const id = z.uuid().parse(request.params.id);
    const business = store.getBusiness(user.id, id);
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
    store.createAccount(user, passwordHash, session.tokenHash, session.expiresAt);
    setSession(response, session.token);
    response.status(201).json({ user });
  });
  api.post("/auth/login", authLimit, async (request, response) => {
    const input = loginSchema.parse(request.body);
    const credentials = store.credentials(input.email);
    const valid = await verifyPassword(input.password, credentials?.passwordHash);
    if (!credentials || !valid) throw new ApiError(401, "Email or password is incorrect.");
    const session = newSession();
    store.createSession(credentials.user.id, session.tokenHash, session.expiresAt, requestTokenHash(request));
    setSession(response, session.token);
    response.json({ user: credentials.user });
  });
  api.get("/auth/me", (request, response) => { response.json({ user: userFor(request) }); });
  api.post("/auth/logout", (request, response) => {
    const tokenHash = requestTokenHash(request);
    if (tokenHash) store.deleteSession(tokenHash);
    const previewHash = requestTokenHash(request, previewCookie);
    if (previewHash) store.discardPreview(previewHash);
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
  async function runScan(request: Request, response: Response, owned?: ReturnType<typeof ownedBusiness>) {
    const input = scanInputSchema.parse(request.body);
    const url = publicUrl(input.url);
    await withScanSlot(response, async (signal) => {
      const result = await scan(url.href, signal);
      if (owned) {
        const saved = store.saveScan(owned.user.id, owned.business.id, result);
        if (!saved) throw new ApiError(404, "Business not found.");
        response.status(201).json({ scan: saved });
      } else response.json({ scan: result });
    });
  }
  api.post("/website/scan", scanLimit, async (request, response) => { await runScan(request, response); });
  api.get("/onboarding/preview", (request, response) => {
    const tokenHash = requestTokenHash(request, previewCookie);
    response.json({ preview: tokenHash ? store.getPreview(tokenHash) : null });
  });
  api.post("/onboarding/scan", scanLimit, async (request, response) => {
    const input = scanInputSchema.parse(request.body);
    const url = publicUrl(input.url);
    await withScanSlot(response, async (signal) => {
      const result = await scan(url.href, signal);
      signal.throwIfAborted();
      const token = newSession();
      const preview = store.savePreview(token.tokenHash, result, requestTokenHash(request, previewCookie));
      response.cookie(previewCookie, token.token, { ...cookie, maxAge: previewLifetime });
      response.json({ preview });
    });
  });
  api.post("/onboarding/claim", (request, response) => {
    const user = userFor(request);
    onboardingClaimSchema.parse(request.body);
    const tokenHash = requestTokenHash(request, previewCookie);
    if (!tokenHash) throw new ApiError(410, "Your public findings have expired. Read the website again to continue.");
    response.json(store.claimPreview(user.id, tokenHash));
  });
  api.get("/businesses", (request, response) => {
    response.json({ businesses: store.listBusinesses(userFor(request).id) });
  });
  api.post("/businesses", (request, response) => {
    const user = userFor(request);
    const input = businessInputSchema.parse(request.body);
    response.status(201).json({ business: store.saveBusiness(user.id, input) });
  });
  api.get("/businesses/:id", (request, response) => {
    response.json({ business: ownedBusiness(request).business });
  });
  api.put("/businesses/:id", (request, response) => {
    const { user, business } = ownedBusiness(request);
    const input = businessInputSchema.parse(request.body);
    const saved = store.saveBusiness(user.id, input, business.id);
    if (!saved) throw new ApiError(404, "Business not found.");
    response.json({ business: saved });
  });
  api.get("/businesses/:id/activity", (request, response) => {
    const { user, business } = ownedBusiness(request);
    response.json({ activities: store.listActivity(user.id, business.id) });
  });
  api.get("/businesses/:id/evidence", (request, response) => {
    const { user, business } = ownedBusiness(request);
    response.json({ evidence: store.listEvidence(user.id, business.id) });
  });
  const salesLimit = rateLimit({
    windowMs: 10 * 60 * 1000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: (request) => userFor(request).id,
    message: { error: "Sales import limit reached for your account. Retry in 10 minutes. Saved sales and scenarios remain available." },
  });
  api.get("/businesses/:id/analytics", (request, response) => {
    const { user, business } = ownedBusiness(request);
    response.json({ analytics: store.salesData(user.id, business.id) });
  });
  let importing = false;
  api.post("/businesses/:id/sales-imports", (request, _response, next) => { ownedBusiness(request); next(); }, salesLimit,
    raw({ type: ["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], limit: "32mb" }),
    async (request, response) => {
      const { user, business } = ownedBusiness(request);
      const currency = analyticsCurrency.parse(request.query.currency);
      const filename = z.string().trim().min(1).max(180).parse(request.query.filename);
      if (!Buffer.isBuffer(request.body)) throw new ApiError(400, "Upload CSV as text/csv or XLSX with its spreadsheet content type.");
      if (importing) throw new ApiError(429, "Another sales file is being read. Retry shortly.");
      importing = true;
      try {
        const format = request.is("text/csv") ? "csv" : "xlsx";
        const snapshot = await readSalesFile(request.body, format, currency);
        response.status(201).json({ draft: store.previewSales(user.id, business.id, filename, salesFileHash(request.body), snapshot) });
      } finally { importing = false; }
    });
  const salesVersion = z.string().regex(/^[a-f0-9]{24}$/);
  api.post("/businesses/:id/sales-imports/:importId/commit", (request, response) => {
    const { user, business } = ownedBusiness(request);
    const input = z.object({ expectedVersion: salesVersion, confirmRejected: z.boolean() }).strict().parse(request.body);
    response.json({ analytics: store.commitSales(user.id, business.id, z.uuid().parse(request.params.importId), input.expectedVersion, input.confirmRejected) });
  });
  api.post("/businesses/:id/analytics/manual", (request, response) => {
    const { user, business } = ownedBusiness(request);
    const input = z.object({ expectedVersion: salesVersion, entry: z.unknown() }).strict().parse(request.body);
    response.status(201).json({ analytics: store.saveManualSales(user.id, business.id, input.entry, input.expectedVersion) });
  });
  api.post("/businesses/:id/analytics/scenarios", (request, response) => {
    const { user, business } = ownedBusiness(request);
    const input = z.object({ expectedVersion: salesVersion, scenario: z.unknown() }).strict().parse(request.body);
    response.status(201).json({ analytics: store.saveSalesScenario(user.id, business.id, input.scenario, input.expectedVersion) });
  });
  api.post("/businesses/:id/traffic-imports", (request, _response, next) => { ownedBusiness(request); next(); }, salesLimit,
    raw({ type: "text/csv", limit: "1mb" }), (request, response) => {
      const { user, business } = ownedBusiness(request);
      const filename = z.string().trim().min(1).max(180).parse(request.query.filename);
      const sourceName = trafficSourceSchema.parse(request.query.sourceName);
      if (!Buffer.isBuffer(request.body)) throw new ApiError(400, "Upload a traffic CSV with Content-Type text/csv.");
      response.status(201).json({ draft: store.previewTraffic(user.id, business.id, filename, sourceName, salesFileHash(request.body), readTrafficFile(request.body)) });
    });
  api.post("/businesses/:id/traffic-imports/:importId/commit", (request, response) => {
    const { user, business } = ownedBusiness(request);
    const input = z.object({ expectedVersion: salesVersion, sameBusiness: z.literal(true) }).strict().parse(request.body);
    response.json({ analytics: store.commitTraffic(user.id, business.id, z.uuid().parse(request.params.importId), input.expectedVersion, input.sameBusiness) });
  });
  function growthSnapshot(request: Request) {
    const { user, business } = ownedBusiness(request);
    const url = business.website ? new URL(business.website).href : "";
    const saved = store.latestUnderstanding(user.id, business.id, url);
    const previous = store.lastSuccessfulUnderstanding(user.id, business.id);
    let report = saved?.research;
    let evidenceSavedAt = saved?.createdAt ?? null;
    if (!growthOpportunities(business.id, report).length && growthOpportunities(business.id, previous?.research).length) {
      report = previous?.research;
      evidenceSavedAt = previous?.createdAt ?? null;
    }
    const job = store.latestAnalysisWithSuggestions(user.id, business.id, url);
    if (job?.research && (!growthOpportunities(business.id, report).length || Date.parse(job.updatedAt) >= Date.parse(evidenceSavedAt ?? ""))) {
      report = job.research ?? undefined;
      evidenceSavedAt = job.updatedAt;
    }
    return {
      user, business,
      snapshot: growthResponseSchema.parse({
        opportunities: growthOpportunities(business.id, report),
        plan: store.listGrowthPlan(user.id, business.id),
        researchStatus: report?.status ?? "unavailable",
        evidenceSavedAt: report ? evidenceSavedAt : null,
      }),
    };
  }
  api.get("/businesses/:id/growth", (request, response) => {
    response.json(growthSnapshot(request).snapshot);
  });
  api.post("/businesses/:id/growth/:opportunityId/plan", (request, response) => {
    z.object({}).strict().parse(request.body);
    const id = growthOpportunityId.parse(request.params.opportunityId);
    const { user, business, snapshot } = growthSnapshot(request);
    const existing = snapshot.plan.find((item) => item.opportunity.id === id);
    const opportunity = snapshot.opportunities.find((item) => item.id === id);
    if (!existing && !opportunity) throw new ApiError(404, "This opportunity is no longer in saved research. Reload Growth intelligence.");
    response.status(existing ? 200 : 201).json({ item: existing ?? store.addGrowthPlan(user.id, business.id, opportunity!) });
  });
  api.patch("/businesses/:id/growth/:opportunityId/plan", (request, response) => {
    const { user, business } = ownedBusiness(request);
    response.json({ item: store.updateGrowthPlan(user.id, business.id, growthOpportunityId.parse(request.params.opportunityId), growthPlanInputSchema.parse(request.body)) });
  });
  api.get("/businesses/:id/understanding", (request, response) => {
    const { user, business } = ownedBusiness(request);
    response.json({
      understanding: store.latestUnderstanding(user.id, business.id, business.website ? new URL(business.website).href : ""),
      lastSuccessfulUnderstanding: store.lastSuccessfulUnderstanding(user.id, business.id),
      job: store.latestAnalysisJob(user.id, business.id),
    });
  });
  api.get("/businesses/:id/analysis-jobs/:jobId", (request, response) => {
    const { user, business } = ownedBusiness(request);
    const job = store.getAnalysisJob(user.id, business.id, z.uuid().parse(request.params.jobId));
    if (!job) throw new ApiError(404, "Analysis not found.");
    response.json({ job });
  });
  api.post("/businesses/:id/analysis-jobs/:jobId/cancel", (request, response) => {
    const { user, business } = ownedBusiness(request);
    response.json({ job: store.cancelAnalysis(user.id, business.id, z.uuid().parse(request.params.jobId)) });
  });
  api.get("/businesses/:id/analysis-jobs/:jobId/events", (request, response, next) => {
    const { user, business } = ownedBusiness(request);
    const id = z.uuid().parse(request.params.jobId);
    const first = store.getAnalysisJob(user.id, business.id, id);
    if (!first) throw new ApiError(404, "Analysis not found.");
    if (activeJobStreams >= 20) throw new ApiError(429, "Too many analysis viewers are connected. Your background work continues; reconnect shortly.");
    activeJobStreams++;
    response.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
    response.flushHeaders();
    let revision = -1;
    const interval = setInterval(() => {
      try {
        const job = store.getAnalysisJob(user.id, business.id, id);
        if (!job) throw new ApiError(404, "Analysis not found.");
        send(job);
      } catch (error) { cleanup(); next(error); }
    }, 500);
    const lifetime = setTimeout(() => response.end(), 20_000);
    let closed = false;
    function cleanup() {
      if (closed) return;
      closed = true; activeJobStreams--;
      clearInterval(interval); clearTimeout(lifetime);
    }
    function send(job: AnalysisJob) {
      if (response.destroyed || response.writableNeedDrain) return;
      if (job.revision !== revision) {
        response.write(`${JSON.stringify({ type: "job", job })}\n`);
        revision = job.revision;
      }
      if (!activeAnalysis(job)) response.end();
    }
    response.once("close", cleanup);
    send(first);
  });
  api.post("/businesses/:id/understanding/:reviewId/apply", (request, response) => {
    const { user, business } = ownedBusiness(request);
    const reviewId = z.uuid().parse(request.params.reviewId);
    const input = understandingReviewInputSchema.parse(request.body);
    response.json(store.applyUnderstanding(user.id, business.id, reviewId, input));
  });
  function analysisInput(request: Request) {
    const { user, business } = ownedBusiness(request);
    const input = understandingInputSchema.parse(request.body);
    if ((input.research || input.resumeJobId) && request.get("Prefer") !== "respond-async") {
      throw new ApiError(400, "Wider research and resuming require a queued analysis request.");
    }
    if (input.research && input.researchVersion !== 2) {
      throw new ApiError(400, "Market research now has a larger search and AI budget. Reload and confirm the updated research permission before starting.");
    }
    if (!business.website) throw new ApiError(400, "Add a public website to your profile first, or continue with manual information and CSV.");
    const url = publicUrl(business.website);
    const existingScan = input.scanId ? store.getScan(user.id, business.id, input.scanId) : store.reusableScan(user.id, business.id, url.href);
    if (input.scanId && (!existingScan || existingScan.requestedUrl !== url.href)) throw new ApiError(404, "Matching saved website evidence was not found for this business.");
    if (existingScan && (existingScan.status === "failed" || !existingScan.pages.length)) throw new ApiError(400, "No public pages were captured. Read the website again before requesting an AI briefing.");
    return { user, business, input, url, existingScan };
  }
  function queued(response: Response, job: AnalysisJob) {
    response.status(202).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform" })
      .end(`${JSON.stringify({ type: "job", job })}\n`);
  }
  api.post("/businesses/:id/understanding", (request, response, next) => {
    const { user, business, input, url } = analysisInput(request);
    if (request.get("Prefer") === "respond-async") {
      const key = z.uuid().parse(request.get("Idempotency-Key"));
      const existing = store.matchingAnalysisJob(user.id, business.id, key, url.href, input.scanId, input.research, input.resumeJobId);
      if (existing) { queued(response, existing); return; }
    }
    if (!agent.configured) throw new AgentError(503, "Your profile is saved. To enable your business agent, set ANTHROPIC_API_KEY on the server and restart it. Manual entry and CSV remain available.");
    next();
  }, analysisLimit, (request, response, next) => {
    if (analysisInput(request).existingScan) next();
    else accountScanLimit(request, response, next);
  }, async (request, response) => {
    const { user, business, input, url, existingScan } = analysisInput(request);
    if (!agent.configured) throw new AgentError(503, "Your profile is saved. To enable your business agent, set ANTHROPIC_API_KEY on the server and restart it. Manual entry and CSV remain available.");
    if (request.get("Prefer") === "respond-async") {
      queued(response, store.enqueueAnalysis(user.id, business.id, z.uuid().parse(request.get("Idempotency-Key")), url.href, input.scanId, input.research, input.resumeJobId, existingScan?.id));
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
        savedScan = store.saveScan(user.id, business.id, result);
        if (!savedScan) throw new ApiError(404, "Business not found.");
        return savedScan;
      }, signal, streaming ? (update) => {
        // Updates are replaceable snapshots; don't queue them behind a slow reader.
        if (!response.destroyed && !response.writableNeedDrain) response.write(frame(update));
      } : undefined);
      signal.throwIfAborted();
      if (!savedScan) throw new AgentError(502, "The agent did not capture website evidence. Nothing was applied.");
      const understanding = recordUnderstanding(store, user.id, business.id, savedScan, proposal);
      if (streaming) response.end(frame({ type: "complete", understanding }));
      else response.status(201).json({ understanding });
    });
  });
  api.post("/businesses/:id/scans", (request, response, next) => {
    ownedBusiness(request);
    next();
  }, scanLimit, async (request, response) => { await runScan(request, response, ownedBusiness(request)); });
  api.get("/businesses/:id/scans", (request, response) => {
    const { user, business } = ownedBusiness(request);
    response.json({ scans: store.listScans(user.id, business.id) });
  });
  api.get("/businesses/:id/scans/:scanId", (request, response) => {
    const { user, business } = ownedBusiness(request);
    const saved = store.getScan(user.id, business.id, z.uuid().parse(request.params.scanId));
    if (!saved) throw new ApiError(404, "Scan not found.");
    response.json({ scan: saved });
  });
  api.get("/businesses/:id/products", (request, response) => {
    const { user, business } = ownedBusiness(request);
    response.json({ products: store.listProducts(user.id, business.id) });
  });
  function ownedProduct(request: Request) {
    const { user, business } = ownedBusiness(request);
    const id = z.uuid().parse(request.params.productId);
    const product = store.listProducts(user.id, business.id).find((item) => item.id === id);
    if (!product) throw new ApiError(404, "Product not found.");
    return { user, business, product };
  }
  function productSnapshot(request: Request) {
    const { user, business, product } = ownedProduct(request);
    return { configured: productAnalyst.configured,
      ...store.productAnalysisState(user.id, business.id, product.id, productFingerprint(product)) };
  }
  function marketplaceSnapshot(request: Request) {
    const { user, business, product } = ownedProduct(request);
    return { configured: agent.marketplace?.configured ?? false, discoveryConfigured: agent.marketplace?.discoveryConfigured ?? false,
      ...store.marketplaceState(user.id, business.id, product.id, productFingerprint(product)) };
  }
  function currentMarketplace(request: Request, reportId: string) {
    const current = marketplaceSnapshot(request);
    if (!current.report || current.stale || current.report.id !== reportId) throw new ApiError(409, "The product or marketplace evidence changed. Reload current evidence before continuing.");
    if (current.running) throw new ApiError(409, "Marketplace research is already running. Saved evidence remains available.");
    return current.report;
  }
  function marketplaceTask(request: Request, response: Response, requestKey: string, inputHash: string,
    work: (signal: AbortSignal) => Promise<MarketplaceReport>) {
    const { user, business, product } = ownedProduct(request);
    const release = claimWorkSlot();
    if (!release) throw new ApiError(429, "Analysis capacity is busy. Saved evidence remains available; try again shortly.");
    let task: ReturnType<Store["beginMarketplace"]>;
    try { task = store.beginMarketplace(user.id, business.id, product.id, productFingerprint(product), requestKey, inputHash); }
    catch (error) { release(); throw error; }
    response.locals.productAnalysisAdmitted = true;
    const signal = AbortSignal.any([marketplaceCancellation.signal, AbortSignal.timeout(marketplaceLimits.milliseconds)]);
    // Persist status before returning; browser disconnects never restart paid work.
    const pending = Promise.resolve().then(async () => {
      try {
        const result = await work(signal);
        signal.throwIfAborted();
        store.finishMarketplace(user.id, business.id, product.id, task.id, result);
      } catch (error) {
        console.warn("Marketplace research failed:", { kind: signal.aborted ? "timeout" : error instanceof Error ? error.name : "unknown" });
        const message = signal.aborted ? "Marketplace research was interrupted or timed out. Previous evidence remains available. No automatic retry was made."
          : error instanceof AgentError ? error.message : "Marketplace research could not finish. Previous evidence remains available. No automatic retry was made.";
        store.failMarketplace(user.id, business.id, product.id, task.id, message);
      } finally { release(); }
    }).catch((error: unknown) => console.error("Unable to persist marketplace job status:", error instanceof Error ? error.name : "unknown"))
      .finally(() => { marketplaceTasks.delete(pending); });
    marketplaceTasks.add(pending);
    response.status(202).json(marketplaceSnapshot(request));
  }
  api.get("/businesses/:id/products/:productId/marketplace", (request, response) => {
    response.json(marketplaceSnapshot(request));
  });
  api.post("/businesses/:id/products/:productId/marketplace", (request, response, next) => {
    const input = marketplaceResearchInput.parse(request.body);
    const { user, business, product } = ownedProduct(request);
    const urls = input.urls.map((url) => {
      const canonical = marketplaceUrl(url);
      if (!canonical) throw new ApiError(400, "Use Amazon India or Flipkart product listing URLs, not search, login or account pages.");
      return canonical;
    });
    const inputHash = createHash("sha256").update(JSON.stringify([productFingerprint(product), urls, input.refresh])).digest("hex");
    const state = marketplaceSnapshot(request);
    if (store.marketplaceRequest(user.id, business.id, product.id, input.requestKey, inputHash)
      || state.running || !input.refresh && !urls.length && state.report && !state.stale) {
      response.json(state); return;
    }
    if (!agent.marketplace) throw new ApiError(503, "Marketplace research is not configured. Authorized review imports and saved evidence remain available.");
    if (!urls.length && (!agent.marketplace.configured || !agent.marketplace.discoveryConfigured)) throw new ApiError(503, "Automatic discovery needs the server's existing Anthropic and Tavily configuration. Supply listing URLs or an authorized review CSV instead.");
    response.locals.marketplaceInput = { input, urls, inputHash };
    next();
  }, analysisLimit, (request, response) => {
    const { business, product } = ownedProduct(request);
    const { input, urls, inputHash } = response.locals.marketplaceInput as {
      input: z.infer<typeof marketplaceResearchInput>; urls: string[]; inputHash: string;
    };
    const capability = agent.marketplace;
    if (!capability) throw new ApiError(503, "Marketplace research is not configured.");
    marketplaceTask(request, response, input.requestKey, inputHash, (signal) => capability.discover(product, business.category, urls, signal));
  });
  api.post("/businesses/:id/products/:productId/marketplace/import", (request, _response, next) => {
    ownedProduct(request); next();
  }, salesLimit, (request, response) => {
    const { user, business, product } = ownedProduct(request);
    const input = marketplaceImportInput.parse(request.body);
    const result = importMarketplaceCsv(product, input.csv);
    const task = store.beginMarketplace(user.id, business.id, product.id, result.fingerprint, randomUUID(), createHash("sha256").update(input.csv).digest("hex"));
    store.finishMarketplace(user.id, business.id, product.id, task.id, result);
    response.status(201).json(marketplaceSnapshot(request));
  });
  api.patch("/businesses/:id/products/:productId/marketplace/match", (request, response) => {
    const { user, business, product } = ownedProduct(request);
    const input = marketplaceMatchInput.parse(request.body);
    const saved = currentMarketplace(request, input.reportId);
    const found = saved.listings.find((item) => item.id === input.listingId);
    if (!found) throw new ApiError(404, "Marketplace listing not found.");
    if (found.status !== "captured" && input.relation !== "excluded") throw new ApiError(400, "This listing has no captured product evidence to confirm.");
    store.updateMarketplace(user.id, business.id, product.id, saved, { ...saved, themes: [], analysedAt: null,
      listings: saved.listings.map((item) => item.id === input.listingId ? { ...item, relation: input.relation } : item) });
    response.json(marketplaceSnapshot(request));
  });
  api.post("/businesses/:id/products/:productId/marketplace/analyse", (request, response, next) => {
    const { product } = ownedProduct(request);
    const input = marketplaceAnalyseInput.parse(request.body);
    const state = marketplaceSnapshot(request);
    if (state.running) { response.json(state); return; }
    const saved = currentMarketplace(request, input.reportId);
    if (saved.analysedAt) { response.json(state); return; }
    if (!agent.marketplace?.configured) throw new ApiError(503, "Marketplace AI analysis is not configured. Saved evidence remains available.");
    if (saved.listings.filter((item) => !["excluded", "unconfirmed"].includes(item.relation)).flatMap((item) => item.reviews).length < 2) {
      throw new ApiError(400, "Confirm relevant listings with at least two distinct review excerpts before analysing customer themes.");
    }
    response.locals.marketplaceAnalysis = { saved, product };
    next();
  }, analysisLimit, (request, response) => {
    const { saved, product } = response.locals.marketplaceAnalysis as { saved: MarketplaceReport; product: ReturnType<typeof ownedProduct>["product"] };
    const capability = agent.marketplace;
    if (!capability) throw new ApiError(503, "Marketplace analysis is not configured.");
    marketplaceTask(request, response, randomUUID(), createHash("sha256").update(JSON.stringify(saved)).digest("hex"),
      (signal) => capability.analyse(saved, product, signal));
  });
  api.get("/businesses/:id/product-intelligence", (request, response) => {
    const { user, business } = ownedBusiness(request);
    const products = store.listProducts(user.id, business.id);
    response.json({ analyses: store.productAnalysisSummaries(user.id, business.id)
      .filter((item) => products.some((product) => product.id === item.productId && productFingerprint(product) === item.fingerprint)) });
  });
  api.get("/businesses/:id/products/:productId/intelligence", (request, response) => {
    response.json(productSnapshot(request));
  });
  const activeProductAnalyses = new Map<string, Promise<void>>();
  api.post("/businesses/:id/products/:productId/intelligence", async (request, response, next) => {
    productAnalysisConsentSchema.parse(request.body);
    const { product } = ownedProduct(request);
    const current = productSnapshot(request);
    if (current.analysis && !current.stale) { response.json(current); return; }
    const pending = activeProductAnalyses.get(`${product.id}:${productFingerprint(product)}`);
    if (pending) { await pending; response.json(productSnapshot(request)); return; }
    if (!productAnalyst.configured) throw new ApiError(503, "Product AI analysis is not configured on this server. Your catalogue remains available.");
    if (current.running) throw new ApiError(409, "This product already has an analysis running. Reload its saved status instead of starting another.");
    next();
  }, analysisLimit, async (request, response) => {
    const { user, business, product } = ownedProduct(request);
    const fingerprint = productFingerprint(product), key = `${product.id}:${fingerprint}`;
    const existing = activeProductAnalyses.get(key), current = productSnapshot(request);
    if (existing || current.analysis && !current.stale) {
      response.locals.productAnalysisReused = true;
      if (existing) await existing;
      response.json(productSnapshot(request)); return;
    }
    const release = claimWorkSlot();
    if (!release) throw new ApiError(429, "Analysis capacity is busy. Saved results are still available; try again shortly.");
    let leaseUntil: number;
    try { leaseUntil = store.beginProductAnalysis(user.id, business.id, product.id, fingerprint); }
    catch (error) { release(); throw error; }
    response.locals.productAnalysisAdmitted = true;
    const pending = Promise.resolve().then(async () => {
      try {
        const analysis = await productAnalyst.run(product, AbortSignal.timeout(productAnalysisTimeout));
        if (analysis.productId !== product.id || analysis.fingerprint !== fingerprint) throw new AgentError(502, "The AI returned an analysis for different product evidence. Nothing was changed.");
        store.finishProductAnalysis(user.id, business.id, analysis, leaseUntil);
      } catch (error) {
        if (!(error instanceof AgentError)) console.error("Product analysis failed:", error instanceof Error ? error.name : "unknown");
        const failure = error instanceof AgentError ? error : new AgentError(502, "Product analysis could not finish. Nothing was changed. No automatic retry was made.");
        store.failProductAnalysis(user.id, business.id, product.id, fingerprint, failure.message, leaseUntil);
        throw failure;
      }
    }).finally(() => { release(); activeProductAnalyses.delete(key); });
    activeProductAnalyses.set(key, pending);
    await pending;
    response.json(productSnapshot(request));
  });
  api.post("/businesses/:id/products/:productId/approve-listing", (request, response) => {
    const { user, business, product } = ownedProduct(request);
    const input = productRewriteInputSchema.parse(request.body);
    const state = productSnapshot(request);
    if (!state.analysis || state.stale || state.analysis.id !== input.analysisId) throw new ApiError(409, "The product or analysis changed. Reload and review a current suggestion before saving.");
    const manual = product.listings.find((listing) => listing.source === "manual");
    response.json({ product: store.saveProduct(user.id, business.id, {
      ...(manual?.data ?? emptyProduct), name: input.title, description: input.description, sku: product.sku, gtin: product.gtin,
    }, product.id) });
  });
  api.post("/businesses/:id/products/:productId/growth-plan", (request, response) => {
    const { user, business, product } = ownedProduct(request);
    const input = productPlanInputSchema.parse(request.body);
    const state = productSnapshot(request);
    if (!state.analysis || state.stale || state.analysis.id !== input.analysisId) throw new ApiError(409, "Reload and review a current product analysis before planning this recommendation.");
    const analysis = state.analysis;
    const recommendation = analysis.result.recommendations[input.index];
    if (!recommendation) throw new ApiError(404, "Product recommendation not found.");
    const reference = new URL(`/#products?${new URLSearchParams({ business: business.id, product: product.id })}`, origin).href;
    const opportunity = growthOpportunitySchema.parse({
      id: createHash("sha256").update(`product:${business.id}:${product.id}:${state.analysis.fingerprint}:${input.index}`).digest("hex"),
      title: recommendation.title, detail: recommendation.detail, agents: ["store"],
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
    const existing = store.listGrowthPlan(user.id, business.id).find((item) => item.opportunity.id === opportunity.id);
    response.status(existing ? 200 : 201).json({ item: existing ?? store.addGrowthPlan(user.id, business.id, opportunity) });
  });
  api.post("/businesses/:id/products", (request, response) => {
    const { user, business } = ownedBusiness(request);
    response.status(201).json({ product: store.saveProduct(user.id, business.id, productInputSchema.parse(request.body)) });
  });
  api.put("/businesses/:id/products/:productId", (request, response) => {
    const { user, business } = ownedBusiness(request);
    response.json({ product: store.saveProduct(user.id, business.id, productInputSchema.parse(request.body), z.uuid().parse(request.params.productId)) });
  });
  const importLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Import preview limit reached. Retry in 10 minutes." } });
  api.post("/businesses/:id/product-imports/csv", importLimit, (request, response) => {
    const { user, business } = ownedBusiness(request);
    const input = csvImportSchema.parse(request.body);
    response.status(201).json({ draft: store.createProductImport(user.id, business.id, "csv", input.sourceName.toLowerCase(), csvProducts(input.csv)) });
  });
  api.post("/businesses/:id/product-imports/website", importLimit, (request, response) => {
    const { user, business } = ownedBusiness(request);
    const { scanId } = websiteImportSchema.parse(request.body);
    const scan = store.getScan(user.id, business.id, scanId);
    if (!scan) throw new ApiError(404, "Saved scan not found in this business.");
    response.status(201).json({ draft: store.createProductImport(user.id, business.id, "website", new URL(scan.requestedUrl).hostname.replace(/^www\./, ""), websiteProducts(scan)) });
  });
  api.get("/businesses/:id/product-imports/:importId", (request, response) => {
    const { user, business } = ownedBusiness(request);
    response.json({ draft: store.getProductImport(user.id, business.id, z.uuid().parse(request.params.importId)) });
  });
  api.post("/businesses/:id/product-imports/:importId/refresh", importLimit, (request, response) => {
    const { user, business } = ownedBusiness(request);
    z.object({}).strict().parse(request.body);
    const scan = store.getProductImportScan(user.id, business.id, z.uuid().parse(request.params.importId));
    if (!scan) throw new ApiError(409, "The original saved scan could not be identified uniquely. Select a saved scan and choose Preview website products instead.");
    response.status(201).json({ draft: store.createProductImport(user.id, business.id, "website", new URL(scan.requestedUrl).hostname.replace(/^www\./, ""), websiteProducts(scan)) });
  });
  api.post("/businesses/:id/product-imports/:importId/commit", (request, response) => {
    const { user, business } = ownedBusiness(request);
    response.json({ result: store.commitProductImport(user.id, business.id, z.uuid().parse(request.params.importId), request.body) });
  });
  return Object.assign(api, {
    async stopMarketplace() {
      marketplaceCancellation.abort();
      await Promise.all(marketplaceTasks);
    },
  });
}
