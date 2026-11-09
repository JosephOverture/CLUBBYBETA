# Apple identity integration

Apple sign-in is disabled until `APPLE_SIGN_IN_ENABLED=true` and all required credentials are configured. Register the native App ID and website Services ID in the same Apple grouping so they identify the same Apple user. Set the iOS client ID to the signed app's bundle identifier, configure an HTTPS website return URI, and include that website origin in the API origin allowlist. Mount the private `.p8` key through the deployment secret store. Web/native client IDs are public; the team private key and signed client secrets stay on the server. The email sign-in option remains available independently.

Native uses Expo's system Apple Authentication button and request. The installed module passes the supplied nonce to `ASAuthorizationAppleIDRequest` directly. Web uses Apple's hosted JavaScript SDK and its standard button, popup flow, state and nonce. The SDK is loaded only when Apple sign-in is enabled. The return URI must be registered with Apple; localhost exports do not prove that the provider popup or a signed device works.

The API stores short-lived, single-use challenges bound to a verifier, state, nonce, channel and optional linking account. Expiry is checked using the database clock. The provider authorization code is exchanged server-side with a five-minute ES256 client secret. Returned identity tokens require Apple's issuer, the specific channel's audience, RS256 signature, issue/expiry times and matching nonce. Both Boolean and string `true` values are accepted for Apple's verified-email claim; string `false` is not. Provider access/refresh tokens are never returned to the client. Only encrypted refresh credentials needed for revocation are stored, separately for each client ID.

New registrations require a verified provider email. An existing email does not automatically merge accounts: users first sign into Clubby, then explicitly link Apple from account settings using recent authentication. Each Clubby account has at most one Apple subject. Repeat sign-in can succeed without receiving an email again. Account suspension/deletion blocks new sessions. Credential completion and logout are serialized in the shared client; stale popup/code completions are cancelled, and credentials issued by a late response are revoked before queued logout proceeds.

`AppleService.revokeUser` requires that the deletion workflow first disable the account. It revokes each stored client grant, leaves failed revocations available for retry, accepts Apple's HTTP 200 response for previously revoked tokens, and erases completed revocation credentials. Provider failures cannot be marked as successful erasure. The [privacy workflow](privacy.md) now invokes this adapter before final account erasure.

## Signed account notifications

Register `https://<api-domain>/v1/auth/apple/notifications` against the primary App ID's Sign in with Apple app grouping. The public POST endpoint accepts only `{payload: <Apple JWS>}` and returns HTTP 200 after committing verified effects. It validates RS256 against Apple's fixed JWKS endpoint, the Apple issuer, one of this deployment's configured client IDs, `iat`, `jti` and event contents. It validates expiry when supplied; Apple's current examples omit `exp`, so absence is supported with a maximum signed-token age of seven days. Future event times are rejected. Both object and serialized JSON event claims and second/millisecond timestamps are supported. Unknown types fail closed for operator review rather than performing a guessed action.

The current `account-deleted` type and legacy `account-delete` spelling are accepted. A matching consent revocation or account deletion immediately revokes Clubby sessions and enters account erasure. Both sign-in screens disclose this account policy before Apple authentication, including explicit linking of an existing Clubby account. Account deletion preserves other holders' rights and financial records under the privacy workflow. Apple-invalidated refresh grants are erased without calling revocation again. Pending local deletion requests are reused.

Per-subject serialization coordinates notifications with sign-in. A delayed event predating a newer verified authentication cannot erase the newly authorized account. A 30-day hashed revocation watermark also rejects old credentials when a notification arrives before the local identity is linked. Notifications use a 30-day deduplication inbox containing ID, hashes, type and timestamps; no JWT, email, raw subject or credential is retained there. Reusing an event ID with changed signed content is rejected. The seven-day validation window remains shorter than inbox retention.

Relay preference events only apply to the matching verified private-relay address. Timestamp ordering prevents older toggles from undoing newer choices; equal-time conflicts prefer disabling delivery. Re-enabling a relay does not grant marketing consent or clear bounce/complaint suppression. Deletion erases the relay-preference row. The worker prunes notification and revocation metadata. Configure an alert for invalid notifications and failed deletion work; do not log incoming JWTs.

Clients revalidate active sessions when returning to the foreground and periodically while visible. Confirmed unauthorized responses clear local credentials, push display and private screens; network errors do not falsely sign users out. Native credential-state checks on actual Apple devices and real notifications remain part of deployment/device evidence.

Tests verify cryptographic client-secret signing, audience/issuer/nonce validation, verified-email handling, HTTP-only web sessions, encrypted storage, one-time and expired challenges, explicit linking, failed/repeated revocation, and delayed browser/native responses racing logout. Production evidence still requires real grouped Apple identifiers, registered web domains, private email relay configuration, signed iOS devices and provider revocation tests.

References:

- [Apple account deletion requirements](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [Apple token validation](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens)
- [Apple token revocation](https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens)
- [Apple web integration](https://developer.apple.com/documentation/signinwithapple/configuring-your-webpage-for-sign-in-with-apple)
- [Expo Apple Authentication](https://docs.expo.dev/versions/latest/sdk/apple-authentication/)
- [Apple account-change notification format](https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts)
- [Enable server-to-server notifications](https://developer.apple.com/help/account/capabilities/enabling-server-to-server-notifications)
- [Apple token revocation and account deletion technical note](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple)
