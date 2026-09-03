# Google wallet pairing for Lasso

## Current trust boundary

The Dashboard Google wallet is not a server-custodied key. Google Identity
Services supplies an ID token to Dashboard's backend, which returns a
user-specific wrapping key. A separate Google Drive OAuth token remains in the
browser and lets the browser download the encrypted wallet blob from the
account's private `appDataFolder`. The browser combines the blob and wrapping
key and is the only component that sees the decrypted wallet.

Consequently, Lasso cannot safely log in to Dashboard and request the private
key from a backend endpoint. The backend does not possess it. Adding such an
endpoint would require moving either the Drive token, ciphertext, or plaintext
key into server custody and would invalidate the existing trust split.

## Proposed user flow

1. The user runs `/login` in Lasso.
2. Lasso creates a one-time P-256 ECDH keypair and asks Dashboard to create a
   pairing record. The private half stays in memory in Lasso.
3. Lasso prints a short verification code and opens the returned Dashboard
   pairing URL in the system browser.
4. Dashboard requires an authenticated wallet session and an explicit
   "Connect this wallet to Lasso" action. A Google wallet must run its existing
   Google identity, account-pinned Drive authorization, download, and decrypt
   flow again; merely having an old browser session is insufficient.
5. The browser displays the same verification code, the wallet address, and
   the Lasso client identity. After confirmation it encrypts only the 32-byte
   private key to Lasso's ephemeral public key.
6. Dashboard relays the encrypted envelope. It never receives plaintext key
   material and must not log the envelope, browser secret, or polling token.
7. Lasso polls with a separate high-entropy token, decrypts the envelope,
   derives the address locally, checks it against the authenticated address in
   the envelope, and shows the address before changing project configuration.
8. Lasso imports the key through `cowboy wallet import --hex` using stdin. It
   creates a new permission-locked key file and never overwrites the active key
   or changes `key_file` without a final local approval.
9. After the key is durably imported, Lasso acknowledges delivery and zeroes
   its ephemeral private key and plaintext key bytes.

The recovery phrase is not transferred. It is unnecessary for signing and
would increase the impact of a pairing compromise.

## Pairing API boundary

The pairing records should live in Redis with a ten-minute TTL; no durable
database row is needed.

### Create

`POST /api/console/pairings`

Request:

```json
{
  "clientInstanceId": "uuid",
  "clientBuild": "0.4.3",
  "publicKeyJwk": {},
  "projectLabel": "canyon-playground"
}
```

Response:

```json
{
  "pairingId": "uuid",
  "browserUrl": "https://dashboard.canyon.cowboylabs.net/console/connect#...",
  "pollToken": "high-entropy secret",
  "verificationCode": "eight characters",
  "expiresAt": "RFC3339"
}
```

The browser secret and poll token are distinct and only their hashes are
stored. Creation is rate-limited by IP and client identity.

### Complete in the browser

`POST /api/console/pairings/:id/complete`

This requires the browser secret, a matching authenticated wallet session,
fresh wallet reauthentication, and an allowed Dashboard origin. The payload is
an encrypted envelope containing the private key, address, pairing ID, client
identity, and expiry. Pairing ID, wallet address, client identity, and protocol
version are also authenticated as AES-GCM additional data.

Completion is single-writer: a second completion attempt is rejected.

### Poll and acknowledge in Lasso

`GET /api/console/pairings/:id` returns `pending`, `completed`, `expired`, or
`cancelled`. A completed response includes the encrypted envelope and the
authenticated wallet address. The poll token is required and responses use
`Cache-Control: no-store`.

`POST /api/console/pairings/:id/ack` deletes the completed record after Lasso
has imported the key. Until acknowledgement, polling is repeatable so a lost
HTTP response cannot destroy the only delivery. Expiry deletes unacknowledged
records automatically.

## Cryptographic envelope

- P-256 ECDH for broad WebCrypto and Node compatibility.
- HKDF-SHA-256 over the ECDH secret with a random 32-byte salt.
- AES-256-GCM with a random 12-byte nonce.
- Canonical additional data binds protocol version, pairing ID, expiry,
  client instance ID, and wallet address.
- Lasso rejects unknown versions, expired envelopes, address mismatches,
  malformed keys, and any envelope not bound to its current pairing.

The short verification code is not a cryptographic secret. It lets the user
detect a wrong or intercepted browser flow by comparing the terminal and
browser displays.

## Implementation order

1. Dashboard backend pairing store, routes, rate limits, redaction, and
   contract tests.
2. Dashboard `/console/connect` page using the existing WalletProvider Google
   unlock path plus a dedicated non-rendering key export for pairing.
3. Lasso pairing client, `/login`, browser launch, bounded polling, envelope
   decryption, local approval, and stdin-only wallet import.
4. Cross-product integration test with a synthetic wallet and browser envelope.
5. Canyon smoke test for Google restore, pairing, Lasso restart, wallet proof,
   and Cattle Guard admission.

## Explicit non-goals

- No raw private key response from Dashboard's backend.
- No Google Drive token in Lasso or Dashboard's backend.
- No private key in a URL, command-line argument, log, clipboard, or analytics.
- No automatic replacement of an existing project wallet.
- No background or unattended Google key export.
