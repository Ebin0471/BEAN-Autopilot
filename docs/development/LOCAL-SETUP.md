# CORE-01 Local Setup

How to run and test the CORE-01 security core locally.

## 1. Prerequisites

- **Node.js 22+** (the data layer uses the built-in `node:sqlite` module).
- npm.

No external database or service is required for local development and tests —
the data layer runs on `node:sqlite` (in-memory for tests, file-backed for dev).

## 2. Install

```bash
npm install
```

## 3. Environment variables

Create a local `.env.local` (never commit real secrets). Safe examples:

```bash
# Enable the provider-neutral dev/test sign-in.
# Production authentication is CLOSED unless a real OIDC/OAuth provider is wired.
BEAN_DEV_AUTH_ENABLED=true

# Local dev database file (defaults to ./.bean/bean.db)
BEAN_DB_PATH=.bean/bean.db
```

| Variable | Default | Purpose |
|---|---|---|
| `BEAN_DEV_AUTH_ENABLED` | unset (closed) | Enables dev/test sign-in. **Must be `false`/unset in production** unless a real provider is configured. |
| `BEAN_DB_PATH` | `.bean/bean.db` | SQLite file location for the local dev store. |

> There is **no production dev-bypass**. With `BEAN_DEV_AUTH_ENABLED` unset, the
> sign-in endpoint returns `503 authentication is not configured`.

## 4. Run the app

```bash
npm run dev      # http://localhost:3000
```

The preserved UI-01 pages load. The API routes under `/api/*` are active.

## 5. Test

```bash
npm test                 # all tests (UI-01 + CORE-01 security)
npx vitest run tests/core01-security.test.ts   # CORE-01 only
```

The CORE-01 tests are **real database integration tests** over an in-memory
`node:sqlite` database — they verify persistence, isolation, and enforcement,
not mocks.

## 6. Type check & lint

```bash
npm run typecheck
npm run lint
```

## 7. Production build

```bash
npm run build
npm run start
```

## 8. API quick smoke

With `BEAN_DEV_AUTH_ENABLED=true`:

```bash
# Sign in (saves the HTTP-only session cookie)
curl -c cookies.txt -X POST http://localhost:3000/api/auth/session \
  -H 'Content-Type: application/json' \
  -d '{"provider":"oidc","providerUserId":"demo","email":"demo@example.com","displayName":"Demo"}'

# Current session + workspaces
curl -b cookies.txt http://localhost:3000/api/auth/session

# Create a business workspace
curl -b cookies.txt -X POST http://localhost:3000/api/workspaces \
  -H 'Content-Type: application/json' \
  -d '{"kind":"BUSINESS","name":"Acme"}'

# Request a consequential (R3) action -> PENDING_APPROVAL
curl -b cookies.txt -X POST http://localhost:3000/api/passports \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"<id>","targetType":"file","targetId":"doc-1","command":"send","operation":"email","dataScope":"doc-1","permissionScope":["actions.execute","workspace.read"],"idempotencyKey":"k1"}'
```

## 9. Production notes

- **Switch the data layer to PostgreSQL** before production (ADR-002). The schema
  in `lib/db/schema.sql` is written portably.
- **Enable PostgreSQL RLS** as defence-in-depth (ADR-003); app-level checks stay
  mandatory.
- **Wire a real OIDC/OAuth provider**; do not rely on `BEAN_DEV_AUTH_ENABLED`.
- **Never commit credentials**; `.env` and `.env.local` are ignored.
- The `.bean/` runtime database directory is git-ignored.
