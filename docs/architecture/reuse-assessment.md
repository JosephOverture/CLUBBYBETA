# M0 reuse assessment

Baseline: original GitHub prototype remains at the root; separate local scaffold is outside this repository. Local `pnpm check` passed on 2026-09-23: all seven package typechecks, 24 test files, 123 tests (API 77, contracts 19, domain 2, consumer 14, seller 11). Those tests exercise mostly fixture behavior; SQL string assertions are not database integration evidence.

| Existing area | Decision | Reason / required adaptation |
| --- | --- | --- |
| Nest/Fastify shell and explicit dependency injection | Adapt | Add database-only production configuration, readiness, validated errors, request IDs, redaction, migrations and bounded shutdown. |
| Catalogue DTO/repository separation | Adapt | Existing shape hard-codes categories/currency, static distances and availability; keep boundary pattern, extend canonical public projection. |
| Fixture venues/artwork | Review individually | Prototype IDs differ: `bluenote` vs `blue-note`, `terrazza` vs `terrazza-aperol`, `magazzini` vs `magazzini-generali`. No wholesale import or inferred duplicate records. Facts/dates require owner review. |
| Existing SQL migrations | Replace for this new repository | Quote/booking tables lack authenticated ownership and payment/ledger references; no live data is present here. Preserve neighboring database untouched. |
| SQL transaction helper | Adapt | Add timeouts, rollback-error preservation and connection cleanup. |
| Inventory repository | Rewrite with race tests | Keep short row-lock transactions as a design. Ticket availability is read in the locking query's snapshot; test competing snapshots with separate DB clients. Simulated `paid_cents` is not a payment. |
| Booking/controller | Replace | No authenticated per-user scope; global listing and confirmation without provider charge. Fixture cancellation only. |
| Manager capability rules | Adapt | Useful deny-by-default actor/organization/venue scopes. Expand door, support, finance and platform roles; use durable memberships and real authentication. |
| Manager persona issuer and directory | Do not expose | Intentionally local test authentication with file storage and process-local sessions. Never migrate as production identity. |
| Manager booking policy helpers | Adapt after policy configuration | Existing deterministic tests are useful but rules are not integrated into checkout and fixed deposit values are not approved terms. |
| Studio publishing | Rewrite persistence, adapt rules | File-backed global state; preserve sold-term protections, add optimistic versions, tenancy and transactional history. |
| Prototype profile/groups/chat | Replace | One global synthetic profile, local JSON, no member-scoped identity or real contribution accounting. Unreadable storage may reset; unacceptable for commerce. |
| Recommendation/hotspot pure engines | Adapt in M7 | Good deterministic tests; replace simulated-confirmed orders and synthetic friends with scoped, consented authoritative facts. |
| Consumer/seller Expo screens and media | Candidate for later port | UI reuse does not make simulated checkout/identity complete. Only port after shared API contracts and access model are verified; retain independent consumer/staff navigation. |
| QR library | Presentation only | Encodes payload; does not authorize tickets or prevent replay. Use server-issued opaque credentials and atomic redemption. |
| Local DB scripts / compose | Adapt | Lock migrations, detect checksum drift, separate environment credentials, use real multi-connection tests, verify restore. No automatic destructive reset. |

Migration order: establish shared foundation; identity/tenancy; canonical catalogue; then commerce. All state migration requires an explicit reviewed manifest with source hashes, stable IDs, relation mapping, dry-run counts and rollback plan. Do not import `.env`, `.local-data`, `node_modules`, generated output, preset persona credentials or presumed paid bookings.
