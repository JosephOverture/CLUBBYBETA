# Clubby — shared iOS and website backend

One TypeScript/NestJS backend serves the iOS app, customer website, sellers, door staff and platform administrators. PostgreSQL owns identity, catalogue, inventory, orders, ticket/table/group bookings and financial records; independent workers handle durable background work. The web and iOS clients share API contracts and customer records.

Clubby supports venue/organizer sales with a platform commission and external listings that redirect to another seller. External purchases do not create Clubby tickets. Stripe, email, Apple and hosting accounts must be configured and their release journeys verified before public launch. Local preparation does not claim App Store approval or live payment readiness.

Use Node.js 24 and the pinned pnpm version. Run `pnpm install --frozen-lockfile`, then `pnpm local --web`. On Windows x64 this starts an isolated persistent database, API, worker and development website without Docker. Local sign-in messages are written to `.local-data/mail`; no real email or payment is sent. See [local development](docs/runbooks/local-development.md) for configuration and other platforms.

`pnpm check` runs both typechecks, real PostgreSQL tests and backend builds. The restore test also requires PostgreSQL 17 `pg_dump`/`pg_restore`; configure `PG_BIN_DIR` as described in [operations](docs/runbooks/operations.md). Run `pnpm --filter @clubby/mobile export:web` and `export:ios` for client exports, then `pnpm audit`. An iOS export verifies bundling, not Apple signing or device behavior.

Current evidence: [W01–W24 workstreams](docs/acceptance/workstreams.md), [phase register](docs/acceptance/phases.json), [M8 review](docs/acceptance/M8.md), [architecture decisions](docs/architecture/decisions.md), [deployment preparation](docs/runbooks/deployment.md) and [release journey matrix](docs/release/launch-verification.md). The [implementation plan](BACKEND-IMPLEMENTATION-PLAN.md) and [prototype audit](BACKEND-READINESS.md) preserve the original baseline.

`pnpm gate M8` checks recorded local completion. `pnpm gate M8 --release` deliberately fails while external release obligations remain. Live commerce also requires an approved manifest matching the artifact and environment. Credentials and generated local data are excluded from Git.

The original root prototype below remains unchanged as a design reference. The backend-connected client is in `apps/mobile`; its production website container excludes the original HTML prototype.

## Original prototype — reference only
Open `index.html` in any modern browser, or serve the folder:

```bash
python -m http.server 8000
# then visit http://localhost:8000
```

Or enable **GitHub Pages** (Settings → Pages → deploy from `main` / root) to get a shareable link.

## Prototype files
- `index.html` — the whole app (UI, logic, styles)
- `milanmap.js` — real Milan geometry (OpenStreetMap-derived: city boundary + 88 NIL districts)
- `qrcode.js` — QR code generation for tickets

## Simulated prototype features
- **Map-led discovery** on a real, stylised map of Milan with venue markers, live search and filter chips
- **Venue & event pages** with editorial layout, photography-style visuals, tags and availability
- **Ticket booking** — tier selection, drink-voucher add-ons, guest checkout, and a real scannable **QR ticket** (+ wallet buttons)
- **3D table booking** — drag-to-rotate floor plan, table info, and **group payments** with a live progress bar and group chat
- **Door-staff scanner** — Valid / Invalid / Refunded results
- **Light & dark themes** (Profile → Settings → Appearance), persisted across sessions
- **Multi-city location system** — 25 destinations across 13 countries, with a location selector and per-city filtering
- **Role workspaces** — Guest, Venue Manager, Organizer, Door Staff, and a **God Mode** admin console
  (Signed vs Unsigned clubs, Eventbrite redirects, venues grouped by location, destination management)

## Roles (demo)
Open **Profile → switch role** to explore the Venue, Organizer, Door and God Mode interfaces.

## Notes
- Prototype: bookings, payments and analytics are simulated client-side (no real backend); state resets on reload.
- Built with Claude. Milan map data © OpenStreetMap contributors · Comune di Milano (NIL).
