# Vendored tarn-client

Single-file ESM bundle of [tarn-client](../../../../../tarn/client/) produced
with esbuild. Imported by `public/js/core/tarn_service.js`; everything else
in Bookish goes through that wrapper.

## Distribution choice

**Option 1 — bundle.** Picked over the importmap and copy-and-flatten
alternatives because:

- Matches Bookish's existing static-asset deploy (no module resolver needed).
- One file to ship, one file to invalidate via the SW version bump.
- Bookish already has `esbuild` as a devDependency — no new toolchain.

The trade-off is that the bundle includes the sharing / share-log primitives
plus their HPKE + X25519 dependencies even though Bookish doesn't use them
yet. That's roughly an extra ~80 KB minified — acceptable as a one-time cost
that disappears the moment Bookish ships its sharing UX.

Current sizes (minified): ~188 KB on disk, ~62 KB gzipped over the wire.

## Rebuilding the bundle

When tarn-client gets a release that Bookish needs:

```bash
npm run build:tarn
```

This runs:

```bash
esbuild ../tarn/client/src/tarn.js --bundle --format=esm \
  --outfile=public/js/lib/tarn/tarn-client.bundle.js \
  --target=es2022 --legal-comments=none --minify
```

The build script is checked in (`package.json` → `scripts.build:tarn`). It
expects the Tarn repo to be a sibling directory (`../tarn/`).

After rebuilding:

1. Verify nothing in `tarn_service.js` needs to change for the new SDK.
2. Bump the SW version (the publish-dev.sh deploy does this automatically,
   but rebuild + commit on its own should still bump if shipping).
3. Smoke-test register / login / CRUD against `api.tarn.dev` before merging.

## Dependencies

Pinned in the root `package.json` as devDependencies — they only run at
bundle time, not at app runtime:

| Package | Why |
|---|---|
| `hash-wasm` | Argon2id KDF (WASM, lazy-loaded by the SDK at runtime). |
| `@scure/bip39` | 24-word recovery phrase generation + validation. |
| `@hpke/core` | HPKE primitives for the connection-request handshake. Pulled in by `sharing.js` even though Bookish doesn't use sharing yet. |
| `@noble/curves` | X25519 keypair derivation for the sharing protocol. Same caveat. |

If a future tarn-client release drops or replaces any of these, update
`package.json` and rebuild.
