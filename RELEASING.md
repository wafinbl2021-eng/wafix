# Releasing Daltoon X

Official releases are built locally and published by Wafi. CI verification builds are unsigned and their installers are not uploaded. See the [automated release verification gates](RELEASE-VERIFICATION.md) for required local tools and checks.

1. Save a source checkpoint. Update package.json, its lockfile, src-tauri/Cargo.toml, its lockfile and src-tauri/tauri.conf.json to the same new version. Update catalog counts, translated copy and release notes when behavior changes.
2. Run TypeScript, translation coverage and quality, lint, formatting, frontend tests, backend tests and the site build. Run the complete Rust suite on the disposable Windows CI runner. Run the explicitly ignored native power test there as well: it creates and deletes an inactive plan and verifies AC restoration, unchanged DC policy and unchanged active plan.
3. Test paid-event handling against an isolated PostgreSQL schema, with synthetic events and a fake email provider. Verify live Stripe prices and endpoint configuration separately. Never send synthetic paid events to the production webhook or create a real charge for an automated test.
4. Build the exact tested commit locally. Supply the Tauri updater private key through the process environment, never through source or logs. `scripts/build-signed.ps1` is the supported way to do this: it refuses a key stored inside the repository and refuses a key whose minisign ID does not match the `plugins.updater.pubkey` compiled into the app, because signing with the wrong key produces artifacts every installed client rejects. Run it with `-DryRun` first to check the key without building. Authenticode signing is not configured: `bundle.windows` carries no `certificateThumbprint`, `digestAlgorithm`, `timestampUrl` or `signCommand`, so `tauri build` produces unsigned artifacts. Daltoon X 1.0.0 is released that way by decision — see the Authenticode policy below. The updater signatures are a separate mechanism and are unaffected: they remain mandatory, and they are what protects updates. When a certificate is acquired, commit the signing configuration together with the executable metadata it depends on, and sign the release that follows; that metadata must be settled before the final signature, so it cannot be retrofitted onto an artifact that has already shipped.
5. Verify the updater signature of every published artifact against the public key compiled into the app; the .sig file's presence alone is insufficient. Inspect the bundled application and uninstaller, not just the outer setup file. There is no Authenticode step for an unsigned release: do not record a publisher, a signing timestamp or a signature status for these artifacts, because none of those exist.
6. Produce latest.json using scripts/make-latest-json.mjs with the release notes file. Check its exact versioned URL and signature. Record SHA-256 hashes of every public artifact. Never replace an already published version with different installer bytes.
7. Deploy the tested backend and website. For a Lifetime campaign, set LIFETIME_CAMPAIGN_ID, LIFETIME_CAMPAIGN_STARTS_AT and LIFETIME_CAMPAIGN_ENDS_AT together. Use a single absolute UTC interval of exactly 48 hours. Keep expired campaign values in place; removing all three restores ordinary Lifetime availability. Confirm the offer endpoint and real checkout before announcing the campaign.
8. Publish the new Git tag and GitHub release with signed EXE, MSI, updater signatures, latest.json and checksums. Existing release workflows publish stable download aliases. WinGet is out of scope until a package is actually published — see below.
9. Download the public artifacts and compare hashes with the verified local files. Verify stable aliases, updater manifest, website and backend. Do not claim WinGet availability unless a catalog listing exists for this product.

## Recovery and commerce checks

- Failed setting writes retain recovery records. Unsupported targets and overlapping or ambiguous legacy records must fail before mutation.
- New DNS snapshots preserve automatic versus static configuration. Old records without that information require manual review.
- New power controls preserve the original plan and effective AC value. They leave battery policy unchanged and must not recreate a deleted plan.
- Duplicate and out-of-order subscription events must not overwrite Lifetime. License delivery depends on a verified paid event and the account's signed entitlement.
- Purchase emails enter a durable queue before webhook acknowledgment. Provider outages are retried. Delivery is at-least-once: a crash after provider acceptance can duplicate a receipt, but cannot duplicate a charge.
- Retain prior source and signed artifacts for rollback. Do not restore an old database dump over new purchases.

## Trust wording

Authenticode establishes publisher identity and file integrity. Tauri signatures protect updater packages. Neither is Microsoft endorsement, a performance guarantee or a promise that SmartScreen will never warn. Older releases may be unsigned; identify the version whenever making a signing claim.

## Authenticode: unsigned for 1.0.0

Daltoon X 1.0.0 ships without an Authenticode signature. This is a decision rather than an oversight, and it is a warning and a later improvement — not a release blocker. Nothing about it stops a release.

In practice: Windows SmartScreen may show an unknown-publisher warning on first run, and the installer and application executable carry no publisher identity. Say so plainly wherever the download is announced, rather than letting a user discover it at the prompt.

What is signed, and must stay signed, is the updater payload. Every artifact published for the updater carries a minisign signature verified against the `plugins.updater.pubkey` compiled into the application. That is a different mechanism, it already works, and it is what protects users from a tampered download. Never describe an unsigned 1.0.0 as unverified: verify the updater signature instead, and be precise about which of the two you mean.

When a certificate is acquired, commit the `bundle.windows` signing configuration and the executable metadata it depends on in one change, then sign from the next release onward.

## WinGet: not published

There is no WinGet package for this product, so no WinGet badge, `winget install`
instruction or catalog link may appear in the README, the website or the backend.
The catalog entry carrying the previous product's identifier is a different
application — linking it would send users to the wrong download.

`.github/workflows/winget-publish.yml` still carries the previous product's
identifier and must not be run for this project. It is inert while its PAT
secret is unset. Publishing a package is a separate step that has not been
taken, and must not be implied in copy before it happens.
