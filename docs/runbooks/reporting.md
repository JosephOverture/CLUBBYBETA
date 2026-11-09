# Reporting definitions and operations

Web and iOS consume the same reporting endpoint and shared response contract. Seller reports require `finance.read`; venue restrictions apply to every panel and export. Platform reports require active `admin` or `finance` access. Support and door roles cannot read finance reports. Results contain aggregate figures and public event metadata, without customer names, emails, credentials or provider secrets.

Each calculation uses a PostgreSQL repeatable-read snapshot. Reports query authoritative historical records directly, so older activity is included without an aggregation backfill or replay-based counter. Payment/refund journal reference uniqueness prevents duplicate financial activity when provider events replay. The requested interval is inclusive at `from` and exclusive at `to`, is limited to 366 days, and accepts an explicit IANA timezone for daily ledger buckets. Event timestamps also retain their own timezone. Monetary amounts are integer strings in currency minor units; currencies are never converted or combined. `generatedAt` states the database snapshot time.

| Panel | Definition |
| --- | --- |
| Captured sales | Positive `provider-collected` postings in `sale:` journals recorded in the window. Group contributions count; the uncharged parent reservation does not. |
| Refunds | Reversal of `provider-collected` postings in confirmed `refund:` journals recorded in the window. A queued refund is not a completed cash movement. |
| Net commission | Negative of platform commission postings, including confirmed commission reversals. Provider-side return processing may still be pending. |
| Net online collections | All commerce `provider-collected` postings, including refunds, chargeback loss and recovery. This is not a bank balance or a payout promise. |
| Seller net before provider fees | Seller gross allocation less net chargeback loss. Tax is included in the booking price; this is not tax-exclusive revenue. |
| Door collections | Signed cash/external-card collection postings, including reversals. These funds do not pass through Clubby's online payment account. |
| Table receivable movement | Signed change in contracted unpaid table balances during the window, including collections, cancellation and no-show waiver. The reconciliation panel separately shows the current lifetime balance. |
| Checkout conversion | Paid checkouts divided by checkouts created in the interval, using their current outcomes. Includes contributions; excludes uncharged group reservations. This is not visitor-to-purchase or external-seller conversion. |
| Repeat buyers | Distinct paid checkout buyers with a prior paid order before that checkout, within the same authorized venue/event/currency scope. No buyer identifiers are returned. |
| Door activity | Successful admission/manual-admission and drink scan events recorded in the interval; rejected scans are counted separately. |
| Event utilization | Occurrences starting in the interval; current valid paid admissions and recorded admitted holders compared with occurrence capacity. Refunded/void/review/disputed/cancelled bookings are excluded from active admissions. Table confirmation/no-show counts are shown separately. |
| Current reconciliation | Lifetime captured order and succeeded-refund amounts compared with their commerce journal postings in the selected scope. Unallocated provider refunds and orders under review remain visible even when arithmetic differences are zero. |
| Provider activity | Independently imported account balance transactions in the provider's creation-time window, with fees/net separately shown. Only available for unrestricted account/platform reports. Payouts use their arrival-date window and current status. |
| Provider freshness | Last matched reconciliation, most recent attempt and its status. A previous match does not imply that a later review or failed run succeeded. |

NPS, physical queue duration, visitor conversion and external-provider purchases are not fabricated. The operational client displays only measured metrics. The original static prototype remains reference material, not a production dashboard.

Exports are durable `report.generate` jobs. Requests are idempotent and limited to ten per hour per user. Generation records an encrypted snapshot and rechecks current authorization. Subsequent reads/downloads are owner-bound and recheck scope; narrowing a membership cannot expose an older broader snapshot. Repeated jobs preserve a completed snapshot. At seven days, downloads stop immediately and maintenance erases the encrypted result. Denied, expired, oversized and exhausted-job outcomes are explicit. CSV fields are escaped against spreadsheet formula interpretation; JSON and CSV use the same stored calculation. Web downloads a CSV file; the native client opens the system share sheet with CSV text. A report contains at most 5,000 events; narrower filters are required above that limit.

Tests exercise partial refunds, exact ledger agreement, real admission events, current cohort conversion, repeat buyers, EUR/GBP separation, IANA day buckets, venue/platform access, immutable snapshots, access revocation, expiration, failed jobs, provider reconciliation freshness and group-parent exclusion. Provider settlement accuracy still depends on successfully configured and reconciled real accounts.
