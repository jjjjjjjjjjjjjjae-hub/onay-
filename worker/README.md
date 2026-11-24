# ONAY device pairing sync

The Android/WebView app uses a one-time pairing flow:

1. Phone 1 collects its local ticket/profile data, encrypts it in the browser with AES-GCM, and sends the encrypted envelope to `POST /v1/pair/create`.
2. The Worker stores the envelope in D1 for ten minutes and returns an eight-digit code. The code is displayed on phone 1.
3. Phone 2 sends that code to `POST /v1/pair/claim`. The Worker deletes the pairing row after a successful claim and returns the encrypted envelope.
4. Phone 2 decrypts the envelope locally and merges the ticket ledger and favorite routes into its local storage.

The code is a one-time transfer code, not an SMS. The payload remains encrypted in D1 and is not decrypted by the Worker. The current browser-side key derivation uses the eight-digit code, so this flow is intended for an intentional device transfer where both phones are in the user's possession.

Before deploying the Worker, apply `schema.sql` to the D1 database. It includes the `registered_phones` table, which is the server-side source of truth used to route unregistered numbers to registration and registered numbers to device pairing.

