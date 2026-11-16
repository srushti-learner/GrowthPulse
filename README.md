# GrowthPulse

An evidence-first business growth partner. This repository currently implements
**checkpoint 1: the application foundation**, not the complete product.

See [the product overview](project%20overview.md) and [the implementation
plan](plan.md) for scope and dependencies.

## Prerequisites

- Node.js 22.12 or later within Node 22 (the selected deployment target).
  Node 24 is also accepted for local development; match the hosting runtime before
  deployment. With nvm, run `nvm install` and `nvm use`.
- npm.

MySQL, an Anthropic key, and marketplace/WhatsApp credentials are **not required**
for this checkpoint.

## Run locally

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173. Vite proxies `/api` requests to Express on port 3001
(or the `PORT` in your environment). The development web server binds to loopback
only. Stop both processes with Ctrl+C.

Navigate between workspace sections using the menu. The overview includes a real
API health check and a retry button. All future modules explicitly show that they
are not implemented; no business metrics, integrations, or analysis are fabricated.

The dark workspace uses an original visual design inspired by Fleet's restrained
typography and contrasting source accents; it does not include the paid template.
Its interactive workflow is explicitly an illustrative design preview: select a
sample source and evidence/opportunity/change/approval stage to explore the
intended experience. These controls do not scan, call AI, save data, or apply changes.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `PORT` | `3001` | Express listening port, integer from 1 to 65535 |

Invalid configuration stops startup with an error. Real `.env` files are ignored
by Git. Do not put credentials into frontend variables or source files.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

Tests cover API health/errors, request limits, configuration validation,
production frontend serving, frontend connection/retry behavior, and navigation.

## Production and GoDaddy Node.js hosting

**GoDaddy's selected Node.js hosting option is the required application host.**
Do not substitute another provider without explicit approval.

Express serves the compiled React frontend and API from one application and
listens on the hosting-provided `process.env.PORT`.

```sh
npm ci --include=dev
npm run build
NODE_ENV=production npm start
```

Configure `NODE_ENV=production` in the hosting environment and use `npm start` as
the application start command. Do not run Vite's development server in production.
Build with development dependencies available; if deploying prebuilt artifacts,
include `dist/`, `package.json`, and `package-lock.json`, then install runtime
dependencies with `npm ci --omit=dev`.

Verify the actual GoDaddy plan's Node versions, process/start-command support,
environment settings, and HTTPS setup before deployment. Database connectivity,
storage, and browser-worker capabilities must be checked before their respective
checkpoints. Hosting has not been configured or deployed by this checkpoint.

## Project layout

```text
client/           React application and responsive styles
server/           Express API, environment configuration, focused tests
dist/client/      Generated frontend build (not committed)
dist/server/      Generated backend build (not committed)
```

## Phase 1 delivery

- Responsive workspace shell with all planned navigation sections.
- `GET /api/health` returning application health only.
- Validated environment configuration and explicit API errors.
- Single-command development and GoDaddy-oriented production build/start.
- No database migrations or external credentials added.

Next: checkpoint 2, database persistence, business ownership, and shared contracts.
