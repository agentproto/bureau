# Launch checklist

Everything here needs the maintainer's explicit go. **Delete this file before the
repository goes public** (it is internal; it names the local dev setup).

## Decisions and identity

- [ ] Confirm the org and repo name `agentproto/bureau` (used in every package.json `repository`, README and CI). Change: search and replace, then re-run `pnpm scan`.
- [ ] Legal entity name for the license holder. `LICENSE` and every package `author` currently say `Agentik` as a placeholder.
- [ ] Security contact address. `SECURITY.md` has the placeholder `security@bureau.example`; set a real, monitored address and mailbox.
- [ ] AIP number for the BROWSER profile once assigned (README and docs say "provisional AIP-63", draft PR `agentproto/agentproto#53`). Update wording when accepted.
- [ ] Rewrite git history authorship before the first push: two of the four local commits carry a personal name and email. Use `git filter-repo --mailmap <file>` (or squash to one commit) and re-run the scan on the rewritten history. New commits already use the neutral `Bureau <noreply@bureau.sh>`.

## Dependencies (must land first)

- [ ] Merge the `agentproto/ts` PRs in G1 order (#1606, then #1607 to #1613) and publish the `@agentproto/*` packages Bureau depends on (`adapter-browser-camofox`, `-chrome`, `-chromium`, `browser-profiles`, `driver-browser`, `pairing-host`, and the version bumps for `browser-process`, `driver`, `secrets`, `workflow-runtime`). Then replace the `^0.0.0` placeholder ranges in `apps/bureau/package.json` with the real published versions and delete the local `local-links.json` and `.pnpmfile.cjs` links. CI cannot pass on a clean runner before this.
- [ ] Note for local machines only: `pnpm-workspace.yaml` carries a local skip-worktree edit (a machine-specific `virtualStoreDir`). It is not in any commit. Never `git update-index --no-skip-worktree` and commit it; the release scan on `git archive HEAD` is the check that matters.

## Publish

- [ ] Reserve the npm names: unscoped `@agentproto/bureau` and the `@agentproto` scope packages `bureau-core`, `bureau-drivers`, `bureau-mcp`, `bureau-router`, `bureau-purify`, `bureau-sdk`.
- [ ] Add the `NPM_TOKEN` repo secret (or configure trusted publishing) and enable branch protection on `main`.
- [ ] Install `@changesets/cli` (`pnpm install`); the initial changesets bump to 0.1.1. For the very first release publish 0.1.0 as is: `pnpm build && pnpm changeset publish` from a clean checkout, then let the changesets flow take over.
- [ ] Flip `PUBLISH_DRY_RUN` to `"false"` in `.github/workflows/publish.yml` in a reviewed commit (there is intentionally no manual switch).
- [ ] Make the repository public; first push: `git remote add origin git@github.com:agentproto/bureau.git && git push -u origin main`.
- [ ] Run gitleaks (and trufflehog) on the real history before the first push: `gitleaks detect --source . --config .gitleaks.toml --redact`. Neither tool was available when this checklist was written, so this is unverified.
- [ ] Run `export/scan.sh` on a `git archive HEAD` export of the release commit one more time.
- [ ] Known leftover: the default launchd label for Camofox (`com.agentik.camofox` in `apps/bureau/src/lib/browser-registry.ts` and `ensure-camofox.ts`, also named in two skills). Decide on a neutral default (for example `sh.bureau.camofox`) and migrate the local launchd job together.

## Downstream

- [ ] Add thin shims in the private tree that re-export the public packages, then flip the private flavour of Bureau to consume them, keeping `authorize: allowLoopback` there.
- [ ] Decide the skill pack split in `skills/README.md` (`browser` and `local-browser` are marked "decide").
- [ ] Announcement: post, changelog entry, and the link to the spec draft.

## Code follow-ups (v1 known limits)

- [ ] Re-target the tool catalogue through the kit driver so `--browser chrome|chromium` runs the tools, not only launches and gates them.
- [ ] Add a `download` verb to the driver port (`browser_download` is gated but has no port implementation).
- [ ] Remove the legacy `resolveCmd` in the `agentproto/ts` chromium browser adapter that still references a private browser-service package.
- [ ] Reconcile the kit capability names with the names in the BROWSER AIP draft.
- [ ] Encryption at rest for grants, ledgers and the pairing store (v1.1).
- [ ] Live view takeover (input from the viewer); exercise real-device rendezvous on a second machine.
