**Clubby — backend development and readiness plan**

**Historical audit:** the findings and unchecked items below describe the original prototype at the reviewed commit, before implementation. For the current implemented scope, design decisions, test evidence and remaining external release gates, read [the workstream completion record](docs/acceptance/workstreams.md) and [the phase register](docs/acceptance/phases.json). The original checklist is preserved as the baseline, not a live status dashboard.

Repository: [P4210/Project-Clubby](https://github.com/P4210/Project-Clubby). Reviewed commit: `e121114ac6e3a1262de3958e86774371966cf7b8`, branch `main`. Analysis date: 23 September 2026.

Implementation sequence for a shared iOS and website backend: [Backend implementation plan](C:/Users/enric/OneDrive/Documentos/ChatGPT/Project-Clubby/BACKEND-IMPLEMENTATION-PLAN.md).

This plan covers the GitHub prototype downloaded into `Project-Clubby`. It does not assess or give implementation credit to the separate local `Clubby` Expo/NestJS project. “Complete” means the backend supports the customer, venue, organizer, door, and platform-admin features represented here, including their failure paths and operation in production. Features visible only as labels or success messages are identified as intended scope, not working integrations.

**What exists today**

All five tracked files were inspected: `index.html`, `milanmap.js`, `qrcode.js`, `README.md`, and `.gitignore`. The first contains application state, fixtures, rendering, and business simulations. The second contains static Milan geometry. The third is a QR encoder, not a ticket validation service. There is no server, database schema, API client, authentication integration, payment integration, background worker, deployment configuration, or test suite in this commit.

Extracting the fixture declarations confirmed 25 destinations in 13 countries, six currency codes, eight venues, nine events, 21 ticket tiers, and 88 Milan districts. All existing venue content belongs to Milan. The generated floor plan always has 14 tables, despite different venue descriptions.

Inline JavaScript parsed successfully. An isolated execution of the actual purchase function confirmed that buying eight tickets leaves stock at 120, creates one ticket record with quantity eight, and gives the QR payload a different identifier from the ticket record. The QR library generates an SVG successfully. The same numeric amount renders as `€100` in Milan and `£100` after switching to London. These checks exercised extracted functions in memory; they were not browser, payment-provider, or production integration tests.

**Repository evidence and consequences**

| Observed behavior | Source in reviewed commit | Backend consequence |
| --- | --- | --- |
| Catalogue and business records are JavaScript arrays and `S` state. Only theme and destination preferences use local storage. | [Data and state](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L719) | Persist and query authoritative records across users, sessions, devices, and restarts. |
| Anyone can enter every workspace; managers can select every venue. | [Role selector](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L1788), [venue selector](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L2094) | Authenticate users and authorize every operation for its organization, venue, event, or owned record. |
| Checkout checks only a name/email and optionally a nonempty password; clicking Pay immediately creates a ticket. | [Checkout and purchase](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L1317) | Real identity handling, server validation, inventory holds, payment verification, and fulfilment. |
| Purchase never decrements tier stock; QR and ticket IDs differ; a quantity order has one `used` boolean. | [completePurchase](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L1360) | Atomic inventory, durable order-to-ticket relationships, and individual admission entitlements. |
| Table availability is random on each new table flow; reservations have no event/date slot. | [floorplan](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L861), [table flow](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L1402) | Persistent layouts and table inventory per occurrence or service period, with exclusive booking guarantees. |
| Group members and contributions are fabricated; only one group exists in state; the funding deadline is display text. | [Group payment](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L1488) | Real memberships, invitations, individual payments, deadlines, multiple groups, and funding state transitions. |
| Scanner buttons choose a result; a valid scan changes a local boolean. | [Scanner](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L1844) | Server validation, concurrent redemption protection, event/staff scope, and audit records. |
| Email confirmation, wallet additions, transfers, staff invitations, and directions are messages, not integrations. | [Success](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L1367), [transfer](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L1743), [staff invite](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L2205) | Implement services and connect their frontend flows; directions can be a client deep link using authoritative coordinates. |
| Proposal approval creates an event then removes the proposal; rejection also removes it. | [Approval interactions](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L2195), [approveProposal](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L2390) | Preserve workflow history, change requests, ownership, decisions, and the proposal-to-event link. |
| Sales figures are hardcoded or random; “trending” is array order. | [Discover](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L1683), [eventRow](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L2059) | Define and collect the underlying metrics before presenting them as live data. |
| Events store day/month and display text, while money formatting uses the current browsing city. | [Currencies](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L715), [event creation](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L2414) | Full timestamps, timezones, occurrence IDs, and fixed transaction currencies and price snapshots. |
| Switching a venue to unsigned promises to preserve existing tickets; hiding venues promises to preserve bookings. | [Visibility](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L2293), [integration change](https://github.com/P4210/Project-Clubby/blob/e121114ac6e3a1262de3958e86774371966cf7b8/index.html#L2360) | Separate discoverability, permission to make new purchases, and validity of existing entitlements. |

**Development checklist — 24 workstreams**

The checklist describes work to build or integrate. Using a managed authentication, payment, messaging, or storage provider can satisfy parts of it; Clubby still needs the business rules, permission checks, integrations, and verification.

**01. Backend application, database, and API foundation**

- [ ] Create a backend application with separate modules for identity, catalogue, commerce, admissions, collaboration, and administration.
- [ ] Define a relational schema with stable IDs, relationships, unique/check constraints, indexes, created/updated times, and ownership fields.
- [ ] Add migrations, development fixtures, production data import, and safe schema upgrade procedures. Do not treat demo fixtures as production sales history.
- [ ] Define versioned API contracts, validated inputs, bounded pagination, filters, consistent error codes, and request IDs.
- [ ] Add concurrency/version checks to staff edits so one manager cannot silently overwrite another manager's changes.
- [ ] Define domain events and reliable background delivery for changes that trigger email, ticket issuance, reports, or other side effects.

**02. Customer identity and guest checkout**

- [ ] Registration, login, logout, verification, recovery, session expiry/revocation, and account suspension; select an identity provider or implement these controls.
- [ ] Customer profile with verified contact details and the minimum age-related information needed for the chosen admission policy.
- [ ] Guest checkout with a durable purchaser record and a secure way to recover bookings after closing the page or changing devices.
- [ ] Verified ownership before attaching past guest orders to an account; knowing an email address alone must not grant access.
- [ ] Enforce the platform's account-required setting at the API, including access to group invitations and contributions.
- [ ] Provide session/device management and stronger authentication for privileged accounts.

**03. Organizations, roles, venue access, and staff invitations**

- [ ] Model venue businesses and organizer organizations separately from individual users; support one user having several memberships.
- [ ] Define permissions for customers, organizers, venue managers, door staff, platform admins, and any narrower bar/support/finance access required.
- [ ] Scope permissions to specific organizations, venues, events, shifts, and records; check them on every read/write/export and realtime subscription.
- [ ] Implement invitations, acceptance, expiry, revocation, and membership states such as pending, active, suspended, and removed.
- [ ] Build authorized workspace/venue switching and a list of the resources the signed-in user actually manages.
- [ ] Prevent staff role escalation and restrict sensitive operations such as payout-account changes, force publishing, refunds, and access grants.

**04. Venue/organizer onboarding and commercial status**

- [ ] Persist organizer applications, business profiles, contact information, review evidence, approval/rejection reasons, and suspension history.
- [ ] Establish and verify who is allowed to manage a venue; support admin assignment or a venue-claim workflow.
- [ ] Represent signed/native and unsigned/external booking modes explicitly, including native-payment readiness and effective dates.
- [ ] Store agreements, commission arrangements, payment-provider account references, and relevant business/tax details under restricted access.
- [ ] Enable native sales only when the business and payment account satisfy the chosen onboarding requirements.
- [ ] On commercial-status changes, stop unauthorized new sales while preserving already-issued tickets, reservations, refunds, and operational staff access needed to honor them.

**05. Destinations, geography, currencies, and timezones**

- [ ] Store countries, destinations, stable IDs/slugs, publication state, currency, timezone, coordinates, map bounds, and display configuration.
- [ ] Validate coordinates, supported currency/timezone values, and uniqueness; preserve links and references when a slug changes.
- [ ] Store actual venue coordinates and support geographic/radius or viewport queries and real distance calculation.
- [ ] Serve only published destinations and eligible content to public queries, including direct-ID requests and search results.
- [ ] Handle event dates that cross midnight and daylight-saving changes using full timestamps and the venue's timezone.
- [ ] Keep each order's currency independent of the user's current destination. Multi-currency reporting must keep currencies separate or use an explicit conversion policy.
- [ ] Provide geographic content/configuration for additional cities. Rendering a multi-city map remains frontend work; the existing asset covers Milan only.

**06. Venue catalogue, opening hours, and media**

- [ ] Venue creation/editing, address, neighborhood, type, description, atmosphere, genres/tags, contact links, minimum age, and price band.
- [ ] Structured opening schedules, exceptional closures, event-specific overrides, and derived “open now,” “opens soon,” and “open tonight” status.
- [ ] Draft, published, hidden, suspended, and archived states with clear public visibility rules and authorized previews.
- [ ] Photo/artwork upload, ownership, file limits/type validation, storage, processing, thumbnails, delivery URLs, and deletion rules.
- [ ] Version changes that affect published bookings; historic purchases retain the venue/event information and terms that were sold.
- [ ] Catalogue import tools with validation, duplicate detection, source identifiers, and a review step before publishing imported records.

**07. Events, occurrences, and organizer proposals**

- [ ] Model event identity separately from each scheduled occurrence/session, including start/end, doors, cutoff times, lineup, genres, description, and artwork.
- [ ] Create, save drafts, edit, publish, unpublish, cancel, and reschedule events, with permission and completeness checks.
- [ ] Proposal workflow: draft, submitted, changes requested, resubmitted, approved, rejected, and withdrawn; retain comments and decision history.
- [ ] Link the approved proposal to its resulting event and preserve organizer ownership. Repeated approval must not create duplicate events.
- [ ] Decide whether approval automatically publishes or creates an approved draft; material later changes may require renewed approval.
- [ ] Protect existing sales when staff change dates, prices, capacities, admission terms, or ownership; trigger affected-customer workflows.
- [ ] Support distinct sessions where needed, such as the prototype's 21:00 and 23:00 seated shows, rather than one ambiguous display string.

**08. Search, map discovery, editorial content, and saved venues**

- [ ] Catalogue search over venue names, neighborhoods, genres, artists, and event titles with stable ranking and pagination.
- [ ] Filters for destination, type, price band, music, neighborhood, distance, opening status, new venues, and actual table availability.
- [ ] Shared visibility and booking-eligibility rules across map, search, discover, venue detail, and direct links.
- [ ] Editorial picks and newly-opened selections that administrators can maintain.
- [ ] A defined “trending” calculation with measurement windows and abuse controls, or explicitly label a manually curated list.
- [ ] Per-customer saved venues and retrieval; optionally merge anonymous device saves after account verification.
- [ ] Cache public catalogue reads with invalidation when staff publish, hide, reschedule, or change availability.

**09. Ticket products, inventory, and temporary holds**

- [ ] Ticket tiers with stable IDs, capacity, price/currency, sale windows, entry conditions, included benefits, and per-order limits.
- [ ] Free-entry/guest-list products with proper capacity control and zero-payment fulfilment; support zero prices without defaulting them to €20.
- [ ] Drink add-ons with per-ticket limits, prices, inclusion rules, and separate redeemable entitlements.
- [ ] Event-level capacity and tier allocations so selling several tiers cannot exceed the physical capacity. Define whether table guests also consume that capacity.
- [ ] Atomic allocation and expiring checkout holds that prevent two customers from buying the last inventory simultaneously.
- [ ] Hold release on abandonment/failure and a defined settlement policy for payments still processing near expiry; never assume a timeout proves a payment failed.
- [ ] Safe capacity/availability overrides: blocked, held, sold, and available are different states. Staff must not reopen an already-booked entitlement by toggling a boolean.

**10. Orders, checkout, prices, and policies**

- [ ] Durable orders and line items linked to purchaser, venue, organizer/seller, event occurrence, products, holds, and currency.
- [ ] Server-generated quotes and authoritative recalculation of quantities, prices, drinks, fees, taxes if applicable, and eligibility.
- [ ] Store monetary values in currency-appropriate minor units with explicit rounding; preserve immutable price, policy, fee, and tax snapshots.
- [ ] Validate the prototype's maximum eight tickets per order and two extra drinks per ticket, plus chosen age, sale-window, and contact rules.
- [ ] Idempotent order submission and checkout recovery so retries/double clicks do not create duplicate orders or charges.
- [ ] Explicit order and fulfilment statuses; retain purchase history independently of subsequent catalogue edits.
- [ ] Record which applicable purchase/refund terms the buyer accepted and when. Model buyer and attendee separately where the product requires it.

**11. Payment processing and provider events**

- [ ] Integrate a payment provider using its hosted checkout or tokenized payment components; replace the prototype's ordinary card-input fields.
- [ ] Create provider payment sessions/intents from server-side order totals; handle required customer authentication, pending processing, declines, cancellation, and retry.
- [ ] Receive and authenticate provider webhooks, deduplicate events, tolerate out-of-order delivery, and make fulfilment idempotent.
- [ ] Confirm successful payment with the provider before issuing paid entitlements; a browser success screen is not authoritative.
- [ ] Coordinate successful payment with inventory fulfilment. If late payment arrives after an allocation is lost, record and execute the chosen compensation/refund path.
- [ ] Reconcile provider payments against local records and repair cases where payment succeeded but ticket issuance or local processing failed.
- [ ] Store provider customer/payment-method references for the profile's saved-payment-method feature, with ownership checks and user-controlled removal.
- [ ] Implement full/partial refunds, dispute events, failed refunds, and support visibility into unresolved transactions.

Stripe is one candidate, not a provider choice already made. Its documentation confirms webhook retries, duplicate deliveries, and non-guaranteed event ordering; these integration behaviors must be handled. [Provider reference](https://docs.stripe.com/webhooks).

**12. Accounting, commissions, settlements, and payouts**

- [ ] Decide the commercial money flow: who sells the ticket, who receives each payment, how venue and organizer shares work, and who funds refunds/disputes.
- [ ] Record a durable financial ledger linking charges, refunds, provider fees, platform fees, seller allocations, transfers, payouts, and corrections.
- [ ] Track deposits, group contributions, unpaid door balances, and cash/card payments collected at the venue without conflating them.
- [ ] Implement payment-account onboarding/status synchronization and seller payout-account administration using the selected provider's supported model.
- [ ] Calculate commissions/revenue splits from versioned agreements; handle rounding, currency restrictions, negative balances, and refunds after payout.
- [ ] Produce seller statements, receipts/invoices as required by the chosen commercial setup, tax/accounting exports, and payout reconciliation.
- [ ] Handle payout schedules, failures, holds, beneficiary changes, and finance permissions/audit trails.

For a marketplace model, a provider such as Stripe Connect supplies account onboarding and movement of money between parties; Clubby's allocation, reconciliation, and business rules remain necessary. [Provider reference](https://docs.stripe.com/connect). Country-specific tax, invoicing, and seller obligations are implementation inputs to confirm with the business and its advisers, not facts inferred from this prototype.

**13. Ticket issuance, QR credentials, transfers, and wallets**

- [ ] Issue a durable admission entitlement for each attendee/ticket, linked to the paid or valid free order line. If a shared group QR is retained, implement an explicit remaining-admissions count and partial use.
- [ ] Generate opaque, unpredictable server-issued credentials or signed credentials with a defined validation model; do not encode an unverified client claim as proof of purchase.
- [ ] Keep credential identifiers consistently linked to the ticket, and avoid personal data in QR payloads.
- [ ] Manage issued, used, refunded, revoked, expired, and transferred states with event-validity rules and a full history.
- [ ] Transfer invitation, recipient verification/acceptance, ownership update, token rotation/revocation, and cancellation of pending transfers; enforce event transfer policies.
- [ ] Provide authenticated/secure guest retrieval, resend, downloadable ticket output if wanted, and recovery after lost emails/devices.
- [ ] Generate and deliver real Apple Wallet passes and Google Wallet event-ticket objects, including updates for reschedules, transfers, or voided tickets.
- [ ] Manage signing keys/certificates and wallet credentials securely; the admission API remains authoritative even when a displayed wallet pass is stale.

Apple documents signed pass packages; Google provides event-ticket issuance and update APIs. These are distinct integrations from rendering a QR SVG. [Apple reference](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/Creating.html), [Google reference](https://developers.google.com/wallet/tickets/events).

**14. Floor plans and table reservations**

- [ ] Persist venue floor-plan versions, zones, table identifiers, positions, dimensions, capacity, accessibility notes if collected, and inclusions.
- [ ] Bind table offers to an event occurrence or explicit date/service period, with price/currency, minimum spend, deposit policy, and booking cutoff.
- [ ] Distinguish table admission, a reservation fee, minimum-spend credit, and included bottles/services; settle on what the purchase actually buys.
- [ ] Implement availability, hold, reserved, blocked, checked-in, cancelled, and no-show states and the allowed transitions.
- [ ] Enforce one active booking allocation per table/slot with database constraints or equivalent transactional protection.
- [ ] Full payment, deposit payment, remaining balance, due times, failed payment, cancellation, and no-show handling.
- [ ] Record authorized door settlement with payment method, staff member, timestamp, receipt/reference, and auditable corrections.
- [ ] Preserve the sold layout/offer version; staff layout edits cannot move or change existing commitments silently. Table rotation/zoom remains frontend rendering.

**15. Group invitations and shared table funding**

- [ ] Persist multiple groups with owner, reservation intent, table/slot, members, capacity, funding target, currency, deadline, and lifecycle state.
- [ ] Generate secure expiring/revocable invitation links and verified acceptance, with member-specific access to the group.
- [ ] Allow unequal contributions using a real payment record per contributor; only confirmed payments count toward funding.
- [ ] Prevent concurrent contributions from overcharging the remaining target; handle pending authorizations and any unavoidable late excess under an explicit refund policy.
- [ ] Reserve inventory according to the agreed group-hold rules so a funded group has a real table allocation.
- [ ] Implement partially funded, deposit satisfied, fully funded, committed balance at door, confirmed, expired, cancelled, and failed states as appropriate.
- [ ] Run deadlines in the venue timezone; notify members and either confirm, release, or refund according to the chosen rules.
- [ ] Define the responsible party for unpaid balance, departure of a member, chargebacks, owner transfer, and cancellation. A commitment to pay later is not a captured payment.
- [ ] Allocate refunds back to the actual contributors and synchronize group totals with payment/refund/chargeback outcomes.

**16. Group chat and realtime updates**

- [ ] Persist group conversations/messages with authenticated sender identity, server timestamps, ordering, and pagination.
- [ ] Restrict message access and subscriptions to current authorized group members; revoke access when membership ends.
- [ ] Add message length/rate limits, safe text rendering, reporting/moderation tools proportionate to launch scope, and retention rules.
- [ ] Deliver payment progress, reservation changes, new messages, and relevant inventory updates through authenticated realtime channels or appropriate polling.
- [ ] Implement reconnect/resume and missed-event recovery; avoid duplicate messages/actions on client retries.
- [ ] Keep financial events separate from chat text. A message saying “paid” must never update a group balance.

**17. Door admission, drink redemption, and venue operations**

- [ ] Admission API validates credential, venue, occurrence/session, staff assignment, time window, ticket state, and admission entitlement.
- [ ] Atomically redeem entry so scanning the same ticket on two devices admits it once; include request idempotency for network retries.
- [ ] Return explicit valid, already used, wrong event/venue, not-yet-valid, expired, refunded, revoked, and unknown responses.
- [ ] Record every scan attempt with staff/device, time, outcome, and reason; restrict access to attendee details.
- [ ] Handle table guest check-in, group arrivals, guest-list lookup, authorized manual lookup/override, and outstanding door balances.
- [ ] Track individual drink-voucher redemption separately from entry and prevent repeated bar redemption; decide whether staff issue physical vouchers or redeem digitally.
- [ ] Produce actual admission totals and shift activity. Current occupancy needs departures/re-entry tracking or a declared estimate; queue waiting time needs separate operational data.
- [ ] Decide the connectivity policy. Offline scanning is an optional additional subsystem with device synchronization and an explicit double-admission risk policy; it is not provided by a signed QR alone.
- [ ] Frontend work must replace the simulated scan buttons with a camera/QR reader and accessible error/retry states.

**18. Customer bookings, cancellations, refunds, and support**

- [ ] Unified booking history for tickets and tables, with details, attendees, purchased terms, currency, payments, balances, and support references.
- [ ] Derive upcoming/past/cancelled/refunded status from dates and lifecycle, not solely a `used` boolean.
- [ ] Enforce booking ownership for customers and secure guest links; preserve access when a venue or city is hidden.
- [ ] Handle customer cancellation requests and authorized staff refunds, including eligibility, cutoff, full/partial amounts, vouchers, and audit records.
- [ ] Event cancellation/rescheduling workflow with affected-booking lists, notices, refunds or rebooking rules, and admission updates.
- [ ] Align scan eligibility, pending transfers, inventory release, wallet status, and seller balances with refund/cancellation transitions.
- [ ] Support-case integration or a small case system tied to order/payment/ticket IDs; include resend and failed-fulfilment recovery tools.

**19. Notifications and customer preferences**

- [ ] Transactional email for account verification/recovery, booking confirmation, tickets, failed payment, refunds, event changes, invitations, and approvals.
- [ ] Group deadline/payment reminders and remaining-balance notifications; schedule against occurrence timezones.
- [ ] Notification preferences and consent records, separating transactional messages from optional marketing.
- [ ] Durable delivery queue with retries, duplicate suppression, provider delivery/bounce feedback, templates, and delivery history.
- [ ] Push or SMS integration only if selected for the product, including device/phone verification and opt-in management.
- [ ] Persist profile preferences that need cross-device synchronization; local-only theme/recents can remain on the device if that is the chosen behavior.

**20. Analytics and operational reporting**

- [ ] Define sold tickets, gross sales, net revenue, platform revenue, refunds, conversion, repeat buyers, table utilization, and event sell-through precisely.
- [ ] Build financial and sales reports from authoritative order/payment/refund records, with organization/venue/event access controls.
- [ ] Instrument discovery-to-checkout conversion separately from server transactions; filter duplicates/test data and define attribution and privacy rules.
- [ ] Venue and organizer dashboards for event performance, tables, admissions, staff activity, revenue, and payout status.
- [ ] Platform reports by destination, period, seller, and currency; avoid adding unrelated currencies together.
- [ ] Exports, scheduled aggregation, backfill/reconciliation, and freshness indicators so “live” means something measurable.
- [ ] The displayed NPS requires a survey and response data if retained; waiting time requires queue measurement. Remove or label unsupported metrics until those inputs exist.

**21. Platform administration, configuration, and external booking links**

- [ ] Admin APIs for destinations, venues, events, organizers, users, permissions, bookings, payments, and support operations with granular access.
- [ ] Versioned controls for account-required checkout, theme settings, high-demand banner, and selected feature availability; publish safe public configuration separately from secrets.
- [ ] Organizer approval, event force-publish, hiding/reopening content, access revocation, and inventory interventions with reasons and audit history.
- [ ] Explicit rules for hidden destinations/venues: preserve history and existing bookings, and decide what happens to direct public links and in-progress checkouts.
- [ ] Server-enforced native-versus-external booking mode, with event Eventbrite link overriding the venue fallback where configured.
- [ ] Validate external URLs and supported hosts/schemes; handle missing links and track outbound clicks if needed.
- [ ] Keep externally purchased tickets, payments, and attendance outside native sales metrics unless a separate authorized integration supplies those facts.
- [ ] Read-only/controlled customer previews that do not bypass real financial or permission rules.

The repository implements Eventbrite redirects only. Importing Eventbrite orders, availability, refunds, or scans is an additional integration decision, not an existing capability.

**22. Security, privacy, and abuse resistance**

- [ ] Threat-model the concrete attack paths: unauthorized venue edits, viewing another user's bookings, forged QR codes, replayed scans, stock hoarding, and payment tampering.
- [ ] Server-side object ownership checks, input validation, safe output handling, parameterized database queries, request-size limits, and rate limits.
- [ ] Secure sessions/cookies or token lifecycle, HTTPS, appropriate CSRF/CORS policies, secret storage, key rotation, and restricted database/service access.
- [ ] Protect personally identifiable and financial data in logs, exports, backups, support tools, and analytics. Do not store raw card numbers or CVC in Clubby.
- [ ] Fix frontend insertion of untrusted strings into HTML before accepting persisted user/staff content; database storage does not make chat or catalogue text safe.
- [ ] Record applicable privacy/terms notices and consent; implement verified access, correction, export, and deletion/restriction requests.
- [ ] Define data retention and anonymization with business/legal inputs, preserving only the records required for the chosen accounting/dispute obligations.
- [ ] Support account/member suspension, invitation/token revocation, abuse investigation, dependency updates, and audit-log protection.

The European Commission identifies access, rectification, erasure, and portability among the rights businesses must handle; the backend needs workflows and records to support applicable requests. [Primary reference](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/dealing-requests-individuals_en). This does not determine the specific retention, tax, or admission rules for each of the 13 countries.

**23. Hosting, background processing, and operational reliability**

- [ ] Separate development/test/staging/production configurations and data, with managed secrets and access permissions.
- [ ] Deploy API services, durable database, worker/scheduler, asset storage, and delivery infrastructure; automate migrations and deploys with rollback procedures.
- [ ] Reliable jobs for hold expiry, funding deadlines, reminders, ticket/email/wallet delivery, payment reconciliation, and report aggregation.
- [ ] Use a durable outbox or equivalent so a committed purchase cannot silently lose its follow-up issuance/notification job; workers must tolerate retries.
- [ ] Health checks, structured logs, metrics/traces, request correlation, alerts, and operational dashboards.
- [ ] Monitor payment-to-ticket delays, webhook failures, inventory conflicts, failed refunds/payouts, scan latency, queue backlog, and suspicious admin actions.
- [ ] Backups, point-in-time recovery where selected, verified restores, retention, and documented recovery objectives.
- [ ] Capacity/load planning for onsale bursts and simultaneous door scans; explicit availability/latency targets and provider outage procedures.
- [ ] Runbooks for stuck orders, delayed payment events, event cancellation, email outage, database failure, and compromised staff credentials.

**24. Frontend integration, automated verification, and launch readiness**

- [ ] Replace authoritative `VENUES`, `PROPOSALS`, `ORG_APPS`, `S.tickets`, `S.reservations`, group balances, and client admin mutations with API-backed data/actions.
- [ ] Replace fake success messages with actual service responses and pending/error/retry states; handle expired sessions, stale prices, and sold-out inventory.
- [ ] Remove public role selection as an authorization mechanism; show workspaces and actions returned by verified permissions.
- [ ] Update frontend dates/currencies/quantities and admission states to reflect the real backend contracts; implement real camera scanning and wallet flows.
- [ ] Test booking/payment/permission workflows end to end, including multiple users and separate staff devices.
- [ ] Run database concurrency, provider sandbox, webhook replay/order, inventory expiry, refund, reschedule, and restore tests.
- [ ] Verify published/hidden and signed/unsigned behavior across every public endpoint and existing-customer workflow.
- [ ] Seed reviewed real catalogue data separately from demos, verify live-provider configuration, and rehearse a complete customer-to-door-to-payout journey.

**Suggested architecture**

Start with one modular backend and separately runnable workers, backed by a relational database. PostgreSQL is a reasonable fit for related orders, inventory, payments, and permissions. Use spatial indexing/extensions if geographic queries require them. Database transactions and locking should enforce booking invariants; caches and realtime delivery must not be the only source of truth. PostgreSQL documents row locking that can protect concurrent updates. [Database reference](https://www.postgresql.org/docs/current/explicit-locking.html).

Use object storage for catalogue media and generated documents/passes, an identity integration, a payment integration, a transactional email integration, and authenticated realtime delivery where the product benefits. A cache or dedicated search engine can be added when measured query/load needs justify it. These 24 workstreams are modules and capabilities, not a requirement for 24 microservices. Reusing components from the separate local Clubby project would require a follow-up implementation audit; this report assumes only the reviewed GitHub code.

**Core data model to design**

These are conceptual record families, not a mandated number of database tables.

| Domain | Records and relationships |
| --- | --- |
| Identity | User, verified identity/contact, session, customer profile, guest purchaser, preference, consent/policy acceptance |
| Access | Organization, membership, permission grant, venue assignment, event/shift assignment, invitation |
| Business onboarding | Organizer application, venue claim/assignment, commercial agreement, payment account, verification status |
| Geography/catalogue | Country, destination, neighborhood, venue, opening schedule/exception, genre/tag, media asset, publication revision |
| Programming | Event, occurrence/session, lineup, proposal, revision, review/decision, organizer-to-event relationship |
| Products | Ticket tier, sale window, add-on, entry condition, entitlement definition, event capacity |
| Inventory | Inventory pool/allocation, stock hold, expiry, block, release, table-slot allocation |
| Commerce | Quote, order, line item, price/policy snapshot, payment attempt, provider event, fulfilment job |
| Finance | Ledger account/entry, fee/split, refund, dispute, transfer, payout, settlement, receipt/invoice |
| Admission | Ticket, QR credential/version, transfer invitation, check-in/scan attempt, drink entitlement/redemption |
| Tables | Floor-plan version, zone, table, service slot/offer, reservation, deposit, balance, door settlement |
| Groups | Booking group, membership/invite, contribution, funding commitment, deadline, conversation, message |
| Operations | Notification/delivery, device subscription, support case, audit event, public setting, analytics event/aggregate, job/outbox |

Every financial/booking record needs a stable currency, relevant occurrence/timezone, ownership, and traceable state history. Prefer IDs over names/slugs as foreign keys. Mutable venue/event records must not be the sole historical record of what someone bought.

**API surface to specify**

The following are endpoint families to design, not APIs that exist today.

| Surface | Required operations |
| --- | --- |
| Identity | Register/login/verify/recover/logout, sessions, profile, guest booking recovery/claim |
| Access | Organizations/workspaces, memberships, role grants, staff invitations and venue/event assignments |
| Catalogue | Destinations, venue/event detail, occurrences, search/filter/map feeds, availability, editorial picks, saved venues |
| Seller catalogue | Venue/media/layout changes, schedules, events/tiers, proposals, reviews, publication transitions |
| Commerce | Quote, stock/table hold, create/read order, start/retry payment, booking history |
| Payment callbacks | Authenticated provider-event ingestion, reconciliation, refunds/disputes, account/payout status |
| Tickets | Retrieve entitlements, transfer/accept/revoke, wallet issue/update, resend |
| Tables/groups | Slot availability, reserve/cancel, deposit/balance, group invitation/join/contribute/commit, messages |
| Operations | Scan/redeem, voucher redemption, door settlement, guest lookup, authorized override |
| Management | Admin review/configuration, support cases, audit logs, finance statements, scoped reports/exports |
| Realtime | Authorized group messages/funding, booking transitions, selected operations updates |

Use explicit commands for transitions such as approve, publish, redeem, refund, or transfer rather than letting clients write arbitrary `status` values. Money/inventory operations require request idempotency and clear retry behavior.

**State and consistency rules that need explicit specifications**

| Lifecycle | States/transitions to define |
| --- | --- |
| Proposal | Draft → submitted → changes requested/resubmitted → approved or rejected; approval links to one event |
| Event occurrence | Draft/approved → published → sales closed → completed; cancellation/rescheduling are audited workflows |
| Inventory hold | Active → consumed, released, or expired; payment processing and late settlement have defined coordination rules |
| Order | Draft/quoted → awaiting payment → paid → fulfilled; separate failed/cancelled and partial/full refund states |
| Ticket | Issued → redeemed or expired; refund/revocation and accepted transfer update credential validity |
| Table | Available → held → reserved → checked in/completed; blocked/cancelled/no-show follow policy |
| Group | Open → partially funded → deposit/full target satisfied → confirmed; expiry/cancellation/refund paths are explicit |
| Money | Payment, refund, dispute, transfer, payout, and cash collection retain separate histories; one status field cannot describe all of them |

Admission and financial state should be related but not collapsed into one boolean. The database transaction commits local changes atomically; a payment provider and the database are separate systems, so reconciliation and compensating actions are required around external failures.

**Business decisions needed before implementation can be finalized**

1. Who is the contracting seller and payment recipient for tickets and tables? How are venue, organizer, and platform shares determined?
2. Is the first launch Milan/EUR only, or are all listed countries/currencies operational at launch?
3. Is guest checkout allowed? How are group members identified, and how are guest purchases recovered or claimed?
4. Does each paid quantity create an individual ticket, or must one QR support partial group admission? Are name changes and transfers allowed?
5. Is a table sold per event, session, or nightly service slot? Does it include entry, bottles, spend credit, or a separate reservation fee?
6. When is a table guaranteed for a group: when the group opens, when a deposit is reached, or when fully funded? How long does the allocation last?
7. Is the 20% deposit and 20:00 deadline universal, or configurable per offer? Who owes the balance, and what happens at expiry or no-show?
8. What are cancellation/refund/reschedule rules, including group contributions, consumed vouchers, provider fees, and already-paid-out sellers?
9. Do venue approvals publish immediately? What changes require another review? What admin overrides are allowed?
10. Must the door work offline? What re-entry, manual admission, and drink-redemption workflows are needed?
11. Do unsigned venues only redirect, or must Clubby synchronize external sales? Are wallet passes required for first launch?
12. Which taxes/invoice requirements, age checks, retention periods, privacy roles, and country-specific rules apply to the actual operating model?

These are specification inputs, not requests for permission to finish the analysis. A smaller launch can defer capabilities only by explicitly disabling the corresponding product promises.

**Dependency-based delivery sequence**

| Stage | Deliverable and exit condition |
| --- | --- |
| 0 — Decisions and model | Resolve money flow, booking units, inventory/admission rules, policies, and first markets; agree API and state contracts. |
| 1 — Foundation and catalogue | Identity, scoped workspaces, persisted catalogue/media, event proposals, publication, discovery, admin/audit, staging and observability work together. |
| 2 — Complete ticket journey | Real hold → checkout → verified payment → ticket → email/retrieval → door scan → refund → seller accounting/payout path passes failure and concurrency checks. Required before native paid ticket launch. |
| 3 — Complete table journey | Versioned layout/slot → exclusive hold → full/deposit payment → reservation → door balance/check-in → cancellation/no-show handling. Required before table launch. |
| 4 — Group journey | Verified invitations → concurrent contributions → deadline/confirmation → chat/updates → correct contributor refunds. Required before enabling shared funding. |
| 5 — Full represented product | Wallets/transfers, saved methods/preferences, all retained dashboards, external-link controls, supported markets, support/privacy operations, and production recovery checks are complete. |

Security, permissions, tests, audit trails, and reliability start in stage 1 and continue throughout; they are not a final-stage add-on. Marketplace settlement/accounting must be operational before accepting live money on that model. If a feature is deferred, remove or disable its success claims and controls until it is actually supported.

**Definition of ready — scenarios that must pass**

- [ ] Two buyers compete for the last ticket or same table/slot; at most one allocation succeeds and nobody is silently charged without an entitlement or tracked compensation.
- [ ] Payment succeeds while the customer closes the browser; the order fulfils and the customer can recover the ticket.
- [ ] Payment callbacks arrive twice, late, and in a different order; no duplicate charge, ticket, refund, ledger allocation, or notification results.
- [ ] A worker crashes after database commit but before sending email/issuing a pass; retry recovers without duplicating fulfilment.
- [ ] Two staff devices scan the same ticket concurrently; one redemption wins and retries return the already-recorded outcome.
- [ ] A quantity-eight order supports the chosen admission and voucher model correctly, including separate arrivals and partial use if allowed.
- [ ] A customer changes browsing city/currency after purchasing; the original amount, currency, event timezone, and rights remain unchanged.
- [ ] An unauthorized user guesses another booking, organization, venue, group, or refund ID; reads and writes are denied.
- [ ] Membership revocation ends staff/API/realtime access promptly; the guest UI cannot grant admin rights.
- [ ] Hiding a venue/city or switching to unsigned stops the defined new-sale paths while existing bookings, scans, and refunds still work.
- [ ] A proposal is reviewed twice and edited concurrently; its history remains available and only the allowed event/version is published.
- [ ] A group receives simultaneous final contributions, a failed payment, a member cancellation, and a deadline expiry; totals, allocation, liability, and refunds remain correct.
- [ ] A refund, transfer, dispute, or event cancellation interacts with scanning; the specified admission policy is applied without inconsistent states.
- [ ] Editing a floor plan, event price/date, or seller agreement does not rewrite the historical purchase or silently invalidate a commitment.
- [ ] Reports reconcile to payment/ledger records and handle refunds, deposits, door collections, and currency separation correctly.
- [ ] Catalogue/media/message input cannot execute code in customer or staff pages; malformed requests and excessive retries are bounded.
- [ ] Backup restore and a deployment rollback/recovery rehearsal succeed; staff can investigate and recover an unresolved order from its audit trail.
- [ ] A real pilot booking is purchased, delivered, retrieved on another device, scanned, refunded where applicable, and reconciled through the actual seller-payment setup.

The repository is a useful product prototype and source of intended workflows. Backend readiness requires implementing the authoritative transactions and operations above, then integrating the frontend against them; persisting the existing JavaScript objects alone would preserve the prototype's inconsistencies.
