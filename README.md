# CounselWorks API — Phase 1

Backend API for CounselWorks OS. Legal operations infrastructure for California PI firms.

## Setup (exact sequence)

```bash
# 1. Install
npm install

# 2. Configure environment
cp .env.example .env
# Fill in: DATABASE_URL, DIRECT_URL, SUPABASE_JWT_SECRET

# 3. Generate Prisma client
npm run db:generate

# 4. Run migrations (includes activity_log immutability trigger — no manual step)
npm run db:migrate

# 5. Seed test data
npm run db:seed

# 6. Unit tests — no DB required
npm test -- tests/middleware/middleware.test.ts

# 7. Integration tests — THE PHASE 1 GATE (requires seeded DB)
npm test -- tests/integration/firmIsolation.test.ts

# 8. Start dev server
npm run dev
```

## Phase 1 gate — all must pass

```
□ npm install succeeds
□ Prisma connects to Supabase
□ Migrations run (includes activity_log trigger automatically)
□ Seed creates: Firm A, Firm B, User A (Firm A), User B (Firm B), CW Admin
□ middleware.test.ts — all 13 unit tests pass (no DB needed)
□ firmIsolation.test.ts — all 13 integration tests pass

Isolation proof:
  □ Firm A user → Firm A → 200
  □ Firm A user → Firm B → 403
  □ Firm B user → Firm B → 200
  □ Firm B user → Firm A → 403
  □ CW Admin → Firm A → 200 (no firm membership required)
  □ CW Admin → Firm B → 200
  □ Unknown firm → 403 (never 404)
```

When all boxes are checked → Phase 2 begins.

## What was fixed in this version

- Valid UUIDs throughout (`11111111-1111-...` format, no invalid prefixes)
- `requireFirmAccess` implements Option A correctly: cw_admin bypasses firm
  membership check via a global role lookup — no dead code
- `activity_log` immutability trigger is in the migration, not a manual step
- `cookie` package explicitly declared in dependencies
- CORS returns `callback(null, false)` for forbidden origins — no 500 bleed
- Flat repo structure — no nested duplicate folder

## Folder structure

```
counselworks-api/
  src/
    app.ts                        Express app (no port binding — importable by tests)
    server.ts                     Port binding only
    config/
      cors.ts                     CORS with credentials: true
      cookies.ts                  Centralised httpOnly cookie options
      prisma.ts                   PrismaClient singleton
    middleware/
      authenticate.ts             JWT from cookie → req.user
      requireFirmAccess.ts        Firm isolation gate → req.firmContext
      requireRole.ts              Role authorization
    modules/
      firms/firms.router.ts       GET /firms/:firmId  (Phase 1 test route)
      auth/                       Phase 1 next: login/logout/refresh
    utils/
      auditLog.ts                 Raw SQL insert — immutable audit trail
    types/index.ts                Shared TypeScript types
  prisma/
    schema.prisma                 firms, users, firm_memberships, activity_log
    seed.ts                       Deterministic test data with valid UUIDs
    migrations/
      20240101000000_init/
        migration.sql             All tables + activity_log immutability trigger
  tests/
    middleware/
      middleware.test.ts          Unit tests — Prisma mocked, no DB needed
    integration/
      firmIsolation.test.ts       Integration tests — THE PHASE 1 GATE
  Dockerfile                      Railway deployment
  .env.example                    Environment variable template
```

## Stack

| Layer    | Choice                                |
|----------|---------------------------------------|
| Runtime  | Node.js 20 + TypeScript               |
| Framework| Express                               |
| Database | Supabase Postgres                     |
| ORM      | Prisma (except activity_log)          |
| Auth     | Supabase Auth + httpOnly cookies      |
| Files    | AWS S3 private + presigned URLs (Ph4) |
| Hosting  | Railway (API) + Vercel (frontend)     |
