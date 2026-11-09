# Website and iOS launch verification

The Expo app produces website and iOS bundles using one API. A JavaScript/Hermes export is not a signed iOS application, a TestFlight run or App Store approval. This Windows workspace verifies types, exports, database-backed API behavior and browser interactions; signing/device/provider evidence requires the owner's accounts and a macOS or EAS build path.

Set public `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_WEB_URL` separately for each EAS environment, plus the configured `EAS_PROJECT_ID`. Production builds refuse missing origins/project identity. `com.clubby.app` and the `clubby` URL scheme must match registered Apple identifiers. Configure Apple sign-in's grouped native App ID/website Services ID, approved redirect and relay sender domain. Enable Apple Pay only with the registered `EXPO_PUBLIC_APPLE_MERCHANT_ID`; the server still selects the connected seller and price. Verify Stripe merchant setup for the actual Connect model. Configure push certificates/keys and use production APNs for TestFlight, App Store and distribution builds; the simulator profile does not establish push support.

`app.config.js` adds the associated website domain. Website builds with `APPLE_TEAM_ID` emit `/.well-known/apple-app-site-association` with the team/bundle identifier and `/bookings/*`, `/tickets/*`, `/groups/*`, `/support/*` paths. The static host serves this file directly as JSON without redirects. The app accepts only that configured HTTPS origin or recognized `clubby:` paths and validates resource IDs. Links select a screen; the API still checks ownership. Test initial launch, resumed app, signed-out entry, denied access, expired records and browser fallback. A link must never grant authorization.

## Required journey matrix

Record artifact revision, signed build/version, environment, device/OS/browser, tester, time, provider references and evidence URL for every row. Do not record raw payment, login, QR or device secrets in screenshots/logs. Use isolated test customers and sellers. Repeat security-sensitive rows on every supported released v1 client before backend rollout; no previous released Clubby build exists yet, so the first signed pilot becomes the compatibility baseline. v1 remains additive and unknown fields/statuses must not grant permissions or money.

| Journey | Expected evidence |
| --- | --- |
| Web purchase → iOS booking → two staff devices | Same order/currency/ticket; one admission; retry returns the recorded result. |
| iOS payment → bank authentication → app terminated | Resumed booking resolves from server/provider state; no duplicate order or charge. |
| Quantity tickets, extra drinks, free admission, promotion | Exact server price/tax/fee snapshots; individual tickets/vouchers; no charge for a free order. |
| Web refund → native/Wallet/door | Correct refund amount and ledger; affected rights invalid everywhere; unaffected rights retained. |
| Two devices race for final ticket/table | One allocation; explicit loser; late paid losers compensated and visible to support. |
| Group members on web and iOS | Invites, privacy, contribution totals, responsibility transfer, deadline, messages and contributor refunds agree. |
| Transfer/refund/dispute/scan races | Valid transition wins atomically; recipient identity verified; old credential rejected. |
| Seller proposals/publication/reschedule/cancellation | Correct seller versus host authority; paid snapshots preserved; customer/support notifications and refunds reconcile. |
| External seller and hidden/paused venue | Correct third-party URL; no Clubby order/admission; existing native bookings remain retrievable. |
| Email/Apple identity, relay, linking, logout, revocation | Verified ownership and recent sensitive authentication; revoked sessions fail on both clients; delayed callbacks cannot restore logout. |
| Account deletion/export/legal restriction | Customer can start in-app deletion; progress/recovery works; provider tokens/cards and personal data erased; restricted records follow approved policy. |
| Notifications, camera/photos denied, poor connectivity | Functional email/web retrieval without push; scanner/image picker denial is recoverable; uncertain writes never silently replay. |
| Operations and disaster recovery | Real cloud alert delivered; worker loss and duplicate provider events safe; restore/reconciliation and artifact rollback observed. |
| Accessibility | VoiceOver and keyboard labels/order/focus, text scaling, contrast, error announcements, reduced motion and accessible payment SDK flow on signed devices/browsers. |

Exercise Safari on current/previous supported iOS, desktop Safari/Chrome/Edge, physical iPhones at the supported minimum/current OS and at least two door devices. Record camera permission denial, offline transition during scanning, revoked membership while a screen is open, expired login/recovery links and notification navigation after sign-out. The present client refreshes access on foreground and periodically; the server rejects revoked grants immediately.

## Store submission and data inventory

Prepare a stable privacy-policy URL, support URL/contact, terms/refund information, screenshots of the actual signed app, age-rating responses and export-compliance review. The app declares standard/exempt encryption; the owner must verify that declaration against the final generated binary and actual SDK set. Inspect generated native privacy manifests and required-reason APIs from Expo/React Native/Stripe/secure storage/camera/notifications/image picker. Do not fabricate tracking disclosures or copy another application's labels.

| Data/process | Purpose, handling and release review |
| --- | --- |
| Verified email, name, Clubby/Apple identity IDs | Account access and customer support; linking verified; profile access scoped; deletion lifecycle implemented. |
| Orders, seller agreements, tax/fee/refund/dispute ledgers | Authoritative commerce; immutable purchased terms; pseudonymous financial retention requires approved jurisdictional policy. |
| Card/provider customer references | Stripe-hosted/tokenized collection; Clubby stores provider IDs and limited method display fields, never raw card numbers/CVC. |
| Ticket credentials, wallet/push tokens, login/delivery payloads | Encrypted at rest and excluded from logs; credentials revoked/removed with lifecycle rules. |
| Seller images | Explicit user selection, private validation/processing, metadata-stripped derivatives, publication-aware delivery and deletion. |
| Group/support messages, moderation evidence, invitations | Participant/staff scope, reporting/blocking, privacy export/erasure, bounded retention and legal holds. |
| Coordinates supplied for nearby search | Query processing; no background location tracking or device-location permission is requested by current discovery UI. Maps directions open the chosen external app. |
| Aggregate sales/admissions reporting, technical request IDs | No advertising SDK or cross-app tracking is implemented. Operational logs omit bodies/credentials; edge access-log collection is not enabled by this reference stack. |

Processors to review in the final deployment: AWS infrastructure/storage/logs/secrets, Stripe/Connect, Resend email, Apple identity/APNs/Wallet and optional Google Wallet. Expo/EAS performs builds; review any subsequently enabled updates/telemetry separately. App Store privacy labels must reflect the final enabled services, SDK behavior, purposes and retention. Approve financial retention and backup-erasure reconciliation before launch; the code cannot choose legal retention periods for the business.

Provide reviewer credentials through App Store Connect's protected review notes, never source control. Supply clear steps to browse, obtain a test booking, retrieve its QR, test the assigned door workflow and initiate account deletion. Keep review customers/venues in the designated review environment and explain how payments are exercised; do not misrepresent sandbox transactions as production. Public registration must not grant staff/admin roles. Complete TestFlight and the real seller-to-payout pilot before submitting the release approval manifest.
