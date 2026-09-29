# License and plugins

Bureau is Apache-2.0 (see `LICENSE`). A hosted or paid product sits on top of the
open core through the plugin seam. The core ships the port and a safe default for
each hook; none of them can block the core.

## Plugins

`bureau serve` and `bureau start` load plugins named by `--plugin <path|pkg>`
(repeatable) or `BUREAU_PLUGINS=a,b`. A plugin default-exports a `BureauPlugin`:

```ts
import type { BureauPlugin } from "bureau-sh/plugin"

export default {
  name: "my-plugin",
  entries: ctx => [/* MCP tool entries */],
  httpRoutes: (req, res) => false,
  commands: {/* extra CLI subcommands */},
} satisfies BureauPlugin
```

A plugin that fails to load aborts with a non-zero exit before anything runs. A
tool name that is registered twice is an error. Other fields: `browsers` and
`toolCapabilities` ([providers.md](providers.md)), `sessionSources`, `authorize`
([pairing.md](pairing.md)), `usage`, `license`.

`bureau-sh/sdk` exports the building blocks a plugin needs: the entry helpers,
the workflow and recipe registries, the session-source and notifier factories,
and `registerPlatformKit` for per-site knowledge. With no kit registered, generic
`--url` flows keep working and no site is special-cased. The workflow engine
(`bureau_workflow_list`, `bureau_workflow_run`) is in core with two sample
recipes; site recipes are not.

## Usage meter

A `UsageMeter` receives one `start`, then a `heartbeat` every minute, then one
`stop` for the browser instance and for each live session. An event holds only
ids, the browser id, a duration and the paired device fingerprint (never a URL,
cookie or token). The default is a noop.

- `--usage-file <path>` (or `BUREAU_USAGE_FILE`) turns on a JSONL sink: append
  only, file `0600`, directory `0700`.
- `--usage-heartbeat-ms <n>` (or `BUREAU_USAGE_HEARTBEAT_MS`) changes the
  heartbeat; default 60000.
- A plugin can set `usage: { record, browser }` to meter its own way. It wins over
  the file sink. At most one plugin may set it.

## License check

A plugin may set `license`, a check run once when it loads. `createLicenseCheck`
verifies a compact token: `<header>.<payload>.<signature>`, base64url, header
`{"alg":"EdDSA","typ":"bureau-license"}`, payload `{sub, exp, features[],
tier?}`, signature ed25519 over `<header>.<payload>`. The public key is the
plugin's. An unsigned, expired or tampered token refuses that plugin with a
message that never echoes the token; the refusal is logged and listed in
`/health` as `licenseRefusals`, and the core keeps serving. Bureau ships no
signer.
