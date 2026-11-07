# Cryptography and TLS breaking changes (.NET 11)

Official articles: https://learn.microsoft.com/dotnet/core/compatibility/cryptography/11/
and the Networking entries of https://learn.microsoft.com/dotnet/core/compatibility/11
(snapshot 2026-11-07).

## Obsoletions

- **SYSLIB0065 — the `set` accessor of `AsnEncodedData.RawData`** (Preview 6). Build the
  value through the constructor of the right type; for mutation use
  `AsnEncodedData.CopyFrom(AsnEncodedData)`.
- **SYSLIB0064 — `RSACryptoServiceProvider.Encrypt/Decrypt(byte[], bool)`**: pass an
  `RSAEncryptionPadding` (see `core-libraries`).

## DSA removed from macOS

`DSA.Create()` and DSA signing/verification throw on macOS (Windows and Linux keep it,
as a legacy algorithm). Move to ECDSA (`ECDsa.Create()`), RSA, or Ed25519 where the
platform offers it. Data already signed with DSA must be verified on another OS or
re-signed.

## Certificate chains and TLS

- **`SslStream` server-side AIA certificate downloads are disabled by default.** A
  server validating **client** certificates (mTLS) no longer fetches missing
  intermediates over the network. Install the full chain on the server, have clients
  send their intermediates, or, deliberately, set
  `CertificateChainPolicy = new X509ChainPolicy { DisableCertificateDownloads = false }`
  in the `SslServerAuthenticationOptions`.
- **Linux: AIA fetching limited to two fetches per chain build.** Chains that need more
  intermediates downloaded than that fail to build: ship the intermediates.

## Implementation switches (behavioral)

- **HKDF on Windows uses the CNG implementation.**
- **Composite ML-DSA on Windows uses the native implementation.**

Same API, different backend: results are identical for valid inputs; error types and
edge cases (unsupported parameters, key sizes) may differ. Run the crypto tests on
Windows.
