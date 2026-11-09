# Account privacy and deletion

One workflow serves the website and iOS app. Account settings provides data export, deletion with explicit consequences, and a private receipt that can check status after sessions are revoked. Guest accounts can use the same endpoints. Recent authentication is required for request creation and administrative retention/retry/access commands.

## Processing

`POST /v1/privacy/requests` accepts `kind: export | delete`; deletion additionally requires `confirmConsequences: true`. Concurrent requests deduplicate per user/kind. Exports are limited to three daily, encrypted in the database, downloadable only by their subject, and expire after seven days. A pending export is suppressed when account deletion has begun.

The worker first disables the account and revokes all sessions, push sessions, organization memberships and platform grants. `privacy.erase` then removes connected-account Stripe Customers/saved methods and revokes each stored Apple refresh grant outside database transactions. It marks uploaded media deleted and removes originals and derivatives from storage before completing. Failed provider calls retry through the outbox; exhausted attempts enter the privacy operations queue. Operators resolve the provider problem and submit a reasoned, version-checked retry. Completion is never recorded on provider failure.

Erasure clears email/name, identity mappings, Apple grants, preferences, saved venues, buyer contact copies, push tokens, invitation contact copies, notification contents, authored chat/support text, venue-claim evidence, generated reports and prior privacy exports. A tombstone UUID preserves ledger and booking references. Database guards reject new personal records and profile restoration after account disabling, including stale authenticated requests. Media processors clean up output if deletion wins their race. Provider Customer creation and erasure share an idempotency key to converge on one deleted Customer.

`POST /v1/privacy/receipt` accepts the request UUID and a 256-bit receipt secret in the JSON body, never a URL. It returns status, target date and completion date only. It cannot authenticate, retrieve an export or recover an account. iOS stores the receipt in SecureStore; web uses session storage. Users can export or forget it. The operational target is 30 days; operators must monitor overdue requests and meet any shorter applicable obligation. This target is an operational setting of this implementation, not a statement of legal deadlines.

## Financial and shared rights

Deleting an account does not request a purchase refund, erase a debt or rewrite a journal. Unused admissions still owned by the deleted account stop working because holder status is checked at admission. Tickets already transferred to another active user remain theirs. Held personal orders are cancelled through provider reconciliation, including late-capture compensation.

Unconfirmed groups owned by the deleted account are queued for their existing cancellation/refund workflow. Confirmed groups and contributions remain intact. An active member can explicitly accept vacant ownership and the remaining balance through `POST /v1/groups/:id/ownership/recover`. The command locks the group, checks that the previous owner is deleted/deleting, and uses the existing audited ownership transition. It never automatically assigns financial responsibility. Deleted members' conversation text is erased.

Deletion of the last active seller owner pauses new sales (`privacy_sales_paused`) while existing staff retain their scoped admission, refund and support operations. An administrator verifies succession using the normal ownership request and the incoming verified user explicitly accepts. Only acceptance clears that pause. Existing seller policies and purchased terms remain unchanged. If the sole platform administrator deletes their account, use the documented administrator bootstrap procedure to restore an authorized operator; account deletion is not denied to preserve an administrator account.

## Retention and access

Pseudonymous financial records, purchased seller terms, provider transaction IDs, consent evidence and append-only audit records remain for accounting, dispute handling and integrity. Organization catalogue/application records belong to the business, rather than the erased personal profile. Free-text business documents and audit reasons must not contain unnecessary personal information. A jurisdiction-specific production retention schedule and backup lifecycle still require approval before launch; this implementation does not invent a universal tax retention period or claim that UUID-linked records are anonymous.

Specific personal data may be retained only through a documented administrative restriction: `POST /v1/privacy/users/:id/holds` requires scope (`profile`, `support`, `chat`), legal basis, case reference and expiry within one year. It does not block ordinary account erasure. The selected data is copied into an encrypted retention record as erasure completes, then removed from the ordinary product tables. New restrictions cannot recreate already erased data.

`POST /v1/privacy/holds/:id/access` requires an active administrator, recent authentication and an access reason; access is audited. Expired/released copies are immediately inaccessible even before maintenance. Release or expiry erases ciphertext. The administrative interface lists restrictions and supports early release; use the audited access endpoint for an authorized case disclosure. A restriction is not authority to reuse the data for product activity or marketing.

Database backups must have a bounded, approved expiry. A restore into a quarantined environment must replay the deletion ledger and expired restrictions before any traffic or notification delivery is enabled. Retention of immutable financial/audit records and offline backup destruction are deployment-policy obligations tracked in the final release gate.

## Verification and external evidence

`tests/privacy.database.test.ts` covers concurrent requests and receipt isolation, paid customer/card deletion, unchanged ledger entries, transferred admission preservation, expiry, legal restriction access, provider failure/retry, shared group recovery, seller succession and rejection of late personal writes. Existing identity tests cover session invalidation and subject-only export access.

Production Apple revocation, Stripe Customer deletion, object-store deletion/version lifecycle and signed-device receipt/export behavior require configured services and device evidence. See [Apple’s account deletion requirements](https://developer.apple.com/support/offering-account-deletion-in-your-app/) and the Apple identity runbook. These are explicit release checks, not implied by test doubles.
