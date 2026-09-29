# Contributing

Thanks for helping. Bureau is small on purpose: a browser capability server, an
SDK and a plugin seam.

## Setup

Requirements: Node.js 22.13 or newer and pnpm (the version in `packageManager`).

```bash
pnpm install
pnpm build
```

Bureau depends on `@agentproto/*` packages for pairing and browser drivers. If
your checkout cannot resolve them from the registry yet, link local copies with an
uncommitted `.pnpmfile.cjs` override; never commit that file or the lockfile.

## Checks

```bash
pnpm typecheck                # tsc --noEmit in every package
pnpm test                     # vitest, offline (fakes only, no live browser)
pnpm scan                     # release scan: paths, secrets, private names
node scripts/quickstart-check.mjs   # the README quickstart on a temp HOME with a fake Camofox
```

Tests must not need a live browser, a real profile, the Keychain or the network.
Use the existing fakes. Bug fixes come with a test that fails without the fix.

## Code

- TypeScript, no `any`. Validate untrusted input at the edge with zod.
- Never print or log a bearer, cookie or key. The `no-static-token` test guards
  the auth surface: keep it green.
- Keep the plugin seam (`BureauPlugin`) the only place business hooks attach.

## Changes and commits

- One focused change per pull request. Add a changeset for anything users of a
  published package would notice: `pnpm changeset`.
- Commit subjects are short and imperative with a type prefix, for example
  `fix: refuse a lease past the approval expiry` or `docs: pairing page`.
- Do not use em dashes in README, docs or other user-facing copy.

## No private names

This repository must not contain names of private products, internal package
scopes, personal names or emails, absolute machine paths, hostnames of
private infrastructure, or credentials. `pnpm scan` and CI check this and fail
closed. If a legitimate string trips the scan, change the string, not the scan.

## Security issues

Do not file them as public issues. See [SECURITY.md](SECURITY.md).
