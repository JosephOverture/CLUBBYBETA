# Trust boundaries and acceptance obligations

| Boundary / threat | Required control | Gate |
| --- | --- | --- |
| Web/iOS input changes price, owner, role or stock | Validated allowlisted DTOs; derive authority, money and inventory on server | M2–M6 |
| Session/guest-link theft or cross-tenant record access | Expiry, hashed credentials, per-resource authorization, revocation, CSRF/origin protections | M2 |
| Competing checkout or duplicate callback | Row locks/unique constraints, scoped idempotency, signed inbox events, replay-safe fulfilment | M4–M6 |
| Credential scanned twice, transferred during scan or refunded | Atomic state transitions scoped to event and assigned operator | M4/M7 |
| Provider timeout and late payment | Persist attempt, reconcile; never free ambiguous paid allocations without compensation | M4 |
| Process/database failure between commit and delivery | Transactional outbox, leased jobs, retry/dead-letter, handler receipt, recovery rehearsal | M1/M8 |
| Secret/PII leakage through logs/config/media | Redact logs, allowlist public projections, private media quarantine, no secrets in clients | All |
| Chat abuse and removed members | Current membership checks, block/report/filter/moderation with audit | M6 |
| Staff changes sold terms or redirects clients | Versioned approvals, purchased snapshots, scoped actions, URL validation, audit reasons | M3–M7 |
| Production accidentally uses demo providers/data | Explicit environment validation and fail-closed provider readiness; seeding guard | All |
| Corrupt or incomplete deployment/migration | Serialized checksum migrations, readiness schema checks, frozen lockfile, rollback/restore tests | M1/M8 |

Security testing must include different real DB connections, users, organizations and client channels; a mock repository is insufficient evidence for transactional invariants. No broad audit conclusion is implied by a passing unit suite.
