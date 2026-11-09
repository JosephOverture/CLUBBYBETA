# Local backend and development clients

Requirements: Node 24, pnpm 11.19.0. The active public beta is in `web/`, connected to the API and PostgreSQL. The root `index.html` remains the original simulation. `apps/mobile` retains the original Expo operations consumer.

On Apple Silicon macOS and Windows x64, `pnpm local --web` provisions a persistent loopback database, runs reviewed migrations and the guarded catalogue seed, then starts the API, worker and backend-connected beta website. macOS stores its database and generated settings under `.local-data/runtime`; Windows retains `%LOCALAPPDATA%/ClubbyPlatform/<workspace-id>`. Use `--mobile` instead of `--web` for the original Expo web consumer. The API is at port 4100, database at 5433, website at 8081. All subprocesses are hidden. It never resets unreadable existing data or stops a database already occupying the port. Omit `--web` for API/worker only. `pnpm local --web --smoke` starts, verifies readiness/catalogue/website/visitor reset and shuts down while preserving the local database for a restart test.

The local launcher creates persistent random credentials in its runtime directory and uses development email file delivery at `.local-data/mail`. These files contain short-lived test sign-in codes and stay out of Git. File delivery is refused in staging/production. Real email uses configured Resend delivery; optional managed identity uses a pinned HTTPS issuer, audience and JWKS. Native secrets use Expo SecureStore; web sessions use HttpOnly cookies and CSRF tokens. This development launcher never enables live commerce.

1. `pnpm install --frozen-lockfile`
2. `docker compose -f infra/local/compose.yaml up -d` (when Docker is installed).
3. Set the environment variables in `.env.example` in the process environment. Do not commit `.env` or credentials. Shell commands below use the process environment; `.env` is not auto-loaded.
4. `pnpm db:migrate` then `pnpm db:seed`. Seeding is explicitly restricted to development/test and does not overwrite records.
5. Run `pnpm dev` and `pnpm worker` in managed background/non-windowed processes or existing user-requested terminals.
6. Run `pnpm --filter @clubby/mobile start`. The browser/iOS consumer uses `EXPO_PUBLIC_API_URL`; it defaults to loopback port 4100. Physical iOS devices need an HTTPS reachable API and a signed build; loopback refers to the device itself.

`pnpm test:database` starts an isolated temporary PostgreSQL 17 on Apple Silicon macOS and Windows x64 without Docker, binds only to loopback, runs integration tests, stops it and removes only its generated temp directory. Every subprocess is hidden. It does not use the neighboring project's data. Elsewhere set `TEST_DATABASE_URL` to a disposable test database, or `PG_BIN_DIR` to PostgreSQL 17 binaries (including initdb, postgres, pg_ctl, pg_dump and pg_restore). This is test infrastructure, not a production database installation.

Test credentials need CREATE DATABASE permission in the disposable test cluster; each integration file creates and drops only its own randomly named database. Never point `TEST_DATABASE_URL` at a production server.

First platform administrator: after the intended operator has verified their email, run `pnpm admin:bootstrap <verified-email> <reason>` with the same database environment. This command requires direct database access, refuses to bootstrap a second active administrator, and records an audit event. No default admin password or publicly selectable staff persona exists.

Checks: `pnpm typecheck`, `pnpm test:database`, `pnpm build`, consumer typecheck, web export and iOS JavaScript bundle export. An iOS JavaScript bundle is not a signed iOS build or device test. `pnpm gate M1` checks the recorded phase evidence; it does not replace running the commands.

Migrations take an advisory lock, verify every applied checksum, reject forgotten/out-of-order/changed files and verify the database environment. Add migrations; never rewrite an applied file. Deployment copies the migration directory alongside the built scripts. Run migration as an explicit deployment job before rolling API/worker instances. Use expand/contract changes when customers have released apps.

`/health/live` checks process liveness; `/health/ready` checks the database environment and complete migration checksums. Jobs use database leases and fenced acknowledgements. Transactional handlers must perform bounded database operations only. External delivery/payment handlers must use their provider's idempotency and reconciliation contract outside database transactions. `dead` jobs require diagnosis and an audited replay tool before production, not arbitrary manual data editing.

The Dockerfile and CI definition are deployment preparation. Locally passing tests do not verify an unrun CI workflow, a container build, cloud TLS, backups, alerts, third-party delivery or App Store readiness. Keep `LIVE_COMMERCE=false` until the later commerce/release gates permit it.
