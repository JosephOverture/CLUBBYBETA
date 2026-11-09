# Group funding and moderation

The public website and iOS client use the same group APIs. The group owns exactly one table allocation. Every captured contribution belongs to its payer and the original connected seller; Clubby does not hold a pooled customer wallet.

## Create, join and fund

Choose an occurrence table, party size and full/deposit target. `POST /v1/groups` requires verified identity, current offer version, a name, an absolute deadline one to sixty minutes from now (before slot start), and acceptance of group terms and responsibility for the remaining balance. The current client selects a maximum twenty-minute window. One unfinished owner allocation is allowed at a time; completed groups and memberships remain independent. Creation and exclusive table hold commit together.

The owner creates email-bound invitations at `/v1/groups/:id/invitations`. A recipient reviews `/v1/group-invitations/preview` and accepts with the same verified email. Tokens are single-use, revocable and expire with funding. Membership cannot exceed the reserved guest count. Invite tokens are credentials: keep them out of logs, analytics and support screenshots.

`POST /v1/groups/:id/contributions` accepts an unequal integer minor-unit amount and terms acceptance, with an idempotency key. It returns a contribution order for the existing payment endpoint and web/native payment components. A contribution is at least 50 minor units and cannot leave an unfundable remainder below that bound. A pending payment reserves its entire portion of the target; a customer cannot create another unresolved contribution concurrently. Exact application-fee allocation is preserved across contributors. The group reservation itself cannot start a separate payment.

Only authoritative paid contributions count. Funding recorded before the deadline is honored if the worker wakes afterward. A still-unfunded deadline cancels provider intents and refunds captures before releasing inventory. Unknown results retain the allocation. A late success is compensated. Once funded, one credential is assigned to each joined member and the remaining guest credentials stay with the owner. Deposits do not mark the door balance paid.

## Withdrawals, ownership and financial review

Before confirmation, a contributor requests withdrawal at `/contributions/:id/withdraw`. Money becomes available for replacement funding only after an authoritative cancellation/refund. After confirmation, an unused group table is cancelled as a whole under its purchased refund cutoff. Refunds use the original contributor orders and payment methods; application-fee refunds are exact and separate. Parent reservation orders do not create another sale journal or duplicate seller gross sales.

Ownership changes are offered and explicitly accepted by an active member, including remaining-balance responsibility. Unassigned guest tickets move to the new owner; each member keeps their assigned ticket and own payment records. A funded member cannot be removed by an owner to take their place. Before confirmation, money must be withdrawn before membership ends. After confirmation, a member may leave the conversation while acknowledging the retained booking/payment. Losing conversation access does not revoke access to their own financial records or assigned ticket.

Unknown external refunds block group rights immediately. Allocate the actual provider refund to the contribution with an empty `ticketIds` list using the scoped external-refund workflow. A contribution has no standalone admissions. Its remaining refundable amount excludes already returned money and confirmed chargeback losses. Partially refunded unfinished contributions are returned completely before their reserved funding share reopens. Lost partial chargebacks refund only the undisputed remainder; the loss and any later recovery are journaled separately. A later recovery for an already cancelled group returns the recovered capture to its payer.

For an unused confirmed booking, a funding shortfall initiates cancellation. If guests already entered, or the reservation was marked no-show, it goes to seller review without automatically refunding other members' consumed service. `/v1/seller/group-financial-reviews` lists scoped cases; a seller manager may authorize remaining contributor refunds at `/v1/seller/groups/:id/refund-review` with a reason. Open disputes stay unresolved until provider authority allows the next action. Door collections remain a separate seller refund obligation; returns use the M5 correction workflow. Support must never invent a successful refund or release disputed money by editing SQL.

## Chat, updates and moderation

Messages are plain text, at most 2,000 characters, with server identity/time/order and a twenty-per-minute per-user limit. Sends are idempotent. `/messages?after=<cursor>` and `/updates?after=<cursor>` provide ordered, bounded pages. The client polls every five seconds and resumes on foreground/reconnection. Each request rechecks current membership; removed members cannot continue reading or subscribing. Clients deduplicate IDs and reload message content after moderation. Chat text cannot change paid totals.

User blocking filters incoming chat without hiding financial notices. Members report messages with reasons. Authorized support/admin users list `/v1/admin/message-reports` and resolve by hiding content or dismissing reports with an audited reason. The shared client includes moderation tools only for authorized users. Hidden text is excluded from history. Message bodies are erased in batches ninety days after the occurrence; financial records and audit evidence follow the separate retention policy. Authored messages, reports, blocks, membership terms and contribution orders are included in privacy exports.

## Worker operations

`group.reconcile` is a durable external job whose domain changes run in one database transaction under the same occurrence lock as payments/admissions. Minute maintenance schedules unfinished groups fairly by last check, sends deduplicated deadline notices and runs bounded message retention. Reconciliation is safe to repeat. The shared payment worker continues provider lookup, cancellation, refund and application-fee work; a provider failure is never treated as a settled contribution. Investigate review/dead-letter cases with group, contribution, order and provider references, not raw payment secrets or invite tokens.
