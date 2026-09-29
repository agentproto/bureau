# Bureau

Bureau is an installable browser capability server. It drives a real (stealth)
browser and exposes what it can do as MCP tools over HTTP, so an agent can
navigate, capture, evaluate and download through a browser that holds real,
saved identities.

```
agent ──MCP over HTTP :8830──▶ bureau serve ──▶ Camofox (stealth Firefox) :9377
```

This repository is the open core: the server and CLI, the plugin seam, the
driver and router libraries, the typed client SDK and the agent skill pack.
Site-specific recipes (per-platform login forms, account switching, capture
adapters) are not part of core. They plug in through the platform kit and the
plugin seam described below.

## Layout

| Path                | Package                        | What it is                                                   |
| ------------------- | ------------------------------ | ------------------------------------------------------------ |
| `apps/bureau`       | `bureau-sh`                    | `bureau` CLI and `serve` entrypoint, plugin host, `bureau-sh/sdk` |
| `packages/core`     | `@agentproto/bureau-core`      | Driver port, sessions, recordings, notifier, page-eval contracts |
| `packages/drivers`  | `@agentproto/bureau-drivers`   | Camofox and external-MCP browser driver backends             |
| `packages/mcp`      | `@agentproto/bureau-mcp`       | The browser MCP tool catalogue                               |
| `packages/router`   | `@agentproto/bureau-router`    | Tiered scrape router (HTTP, chromium, camofox, agent)        |
| `packages/purify`   | `@agentproto/bureau-purify`    | HTML to clean markdown                                       |
| `packages/sdk`      | `@agentproto/bureau-sdk`       | Typed client and React hooks for a Bureau server             |
| `skills/`           |                                | Agent skills: `bureau`, `browser`, `local-browser`           |

Saved-session modelling (the cookie jar, profile bridging and consent grants)
lives in `@agentproto/browser-profiles`, which this repository depends on.

## Requirements

- Node.js 22.13 or newer and pnpm.
- A browser: Camofox (default, reachable through `CAMOFOX_URL`, default
  `http://127.0.0.1:9377`), Chrome or Chromium. `bureau start` launches it for
  you. Any other browser a plugin registers works too (see
  [Choosing a browser](#choosing-a-browser)).
- macOS for the default credential store, which uses the `security` CLI.

## Quick start

```bash
pnpm install
pnpm build
node apps/bureau/dist/index.js start        # Camofox + server together
node apps/bureau/dist/index.js session scan # list Chrome profiles that look like identities
```

`bureau session list | show <id> | rm <id>` manage what is saved under
`~/.agentproto/bureau/sessions` (override with `BUREAU_SESSIONS_DIR`).

## Choosing a browser

```bash
bureau start                                   # camofox (default)
bureau start --browser chrome --headless       # a fresh dedicated Chrome profile
bureau start --browser chromium --profile work # Playwright Chromium, dedicated profile "work"
bureau start --browser acme-browser            # any id a plugin registers
bureau start --detach                          # background; writes <BUREAU_HOME>/bureau-run.json
bureau stop                                    # stops only what bureau start began
```

Flags: `--browser camofox|chrome|chromium|<id>` (`camoufox` is accepted, and the
old positional `bureau start camofox` still works; `BUREAU_BROWSER` sets the
default), `--headless | --headed`, `--profile <name>`, `--port` (Bureau),
`--browser-port`, `--camofox-cmd`, `--timeout <seconds>`, `--detach`.

- **Idempotent.** A Bureau or browser that already answers `/health` is reused,
  never respawned. `bureau start` with a different `--browser` than the running
  one refuses and points at `bureau stop`.
- **`bureau stop`** signals only a Bureau that wrote the state file and answers
  `/health` on its recorded port. A browser Bureau merely found running is left
  running.
- **Chrome and Chromium never touch your Chrome profile.** `--profile` names a
  fresh dedicated directory under the Bureau home; the default Chrome
  user-data-dir and the profile name `Default` are refused. Using a whole
  profile needs `--full-profile <grant-id>` with an active recorded grant, and
  works only when Bureau's own pairing is in use.
- **Third-party browsers** register through the plugin seam
  (`BureauPlugin.browsers`, kit providers) and are selected by id. Plugins may
  also declare which of their tools need which capability
  (`BureauPlugin.toolCapabilities`).

Tool execution limitation: the tool catalogue still runs through the Camofox
driver. The browser you choose drives launch, supervision, `/health` and
capability gating; it does not yet re-target the tools themselves.

### Capability errors

Each browser declares capabilities. Tools that need one the active browser lacks
answer with a typed error (`code: "browser:unsupported"`) that names the
capability, the active browser and the browsers that have it, for example:
`"browser_cdp_send" needs the "cdp" capability, which the active browser
"camofox" does not have. Restart Bureau with one that does: bureau start --browser chrome | chromium.`
One table (`CAPABILITY_TOOL_TABLE` in `lib/capability-gate.ts`) maps capability
to tools: `cdp` (`browser_list_requests`, `browser_get_request_body`,
`browser_cdp_send`), `downloads` (`browser_download`), `stealth` (`scrape`,
`browser_act`). A test walks the table against every provider.

### Health

`GET /health` stays open and keeps `ok` and `tools`. It adds:

| field | meaning |
| --- | --- |
| `browser` | id of the active browser |
| `state` | `starting`, `healthy`, `degraded`, `crash-looping` or `stopped` |
| `restarts` | relaunches since Bureau started |
| `wasAlreadyRunning` | Bureau reused a browser it did not start |
| `since` | ISO time the current state began |

Bureau's own `/health` always answers HTTP 200, so a crashing browser never
takes Bureau down; read `state`. Only the Camofox server itself answers 503 when
it is launching or crash-looping. Retries stop once the supervisor reports
`crash-looping` (3 launch failures in 5 minutes by default). Run `bureau start`
again to reset it; that restarts the Bureau it started. `--no-browser` reports
`stopped` (nothing is managed).

## Doctor

```bash
bureau doctor [--browser ID] [--profile NAME] [--keychain] [--json]
```

Prints a checklist with a fix hint per failure and exits 1 if any check fails:
browser availability, Camofox reachability and its `/health` mapping, Chrome
`Local State`, Full Disk Access (an `EPERM` names the binary that needs it), the
pairing store and consent ledger being mode 0600, the ledger's hash chain
verifying, and how `authorize` is configured. `--keychain` also probes the
macOS Keychain and may show a prompt.

## Consent grants

```bash
bureau session import --from chrome --domains github.com,x.com --yes
bureau session import --from chrome --domains github.com     # asks per domain
bureau session list                                          # saved sessions, then grants
bureau session revoke github.com                             # or a grant id
```

`import` grants Bureau the cookies of the named domains only. Without `--yes` it
asks per domain on a terminal; without a terminal it fails unless both
`--domains` and `--yes` are given. Wildcards and `all` are rejected. `list`
shows domains, granted-at and the device fingerprint, never cookie values.
`revoke` deletes the derived cookie material and appends a row to the consent
ledger. The agent (MCP) surface cannot add a domain or change the profile; such
attempts are refused and recorded as `deny` rows.

## Plugins

`bureau serve` loads plugins named by `--plugin <path|pkg>` (repeatable) or
`BUREAU_PLUGINS=a,b`. A plugin is a module that default-exports a
`BureauPlugin`:

```ts
import type { BureauPlugin } from "bureau-sh/plugin"

export default {
  name: "my-plugin",
  entries: ctx => [/* MCP tool entries */],
  httpRoutes: [/* extra HTTP routes */],
  commands: {/* extra CLI subcommands */},
} satisfies BureauPlugin
```

`bureau-sh/sdk` exports the building blocks a plugin needs: the entry helpers,
the workflow and recipe registries, the session-source and notifier factories,
and `registerPlatformKit` for per-site knowledge. With no kit registered,
generic `--url` flows keep working and no site is special-cased.

## Pairing (the only auth)

`/mcp` accepts one credential: a device bearer minted by pairing (AIP-59).
There is no static token, no shared secret env var and no password. `/health`
stays open and returns `{"ok":true,"tools":N}` plus the browser fields below. A missing or invalid bearer gets
`401` with `WWW-Authenticate: Bearer realm="bureau"` and a body that says
nothing about why. The Host and Origin guard stays on in front of both.

State lives in `~/.agentproto/bureau` (override with `BUREAU_HOME`):
`pairings.json` (mode 0600), `identity.json`, `grants.json`, and a control
socket the CLI uses to talk to the running server.

### Local: your own MCP host

```bash
bureau install-mcp                # claude (default)
bureau install-mcp --client cursor
```

This mints a local device (no QR) and writes its bearer into the host's MCP
config. It is idempotent: re-running replaces its own entry, revokes the
superseded device and never duplicates. The bearer is never printed.

### Remote: another machine or phone

```bash
bureau pair                       # prints a QR and a URL (server must be running)
bureau pair --no-qr --ttl 300
bureau devices list
bureau devices revoke <id|name>   # takes effect on the very next request
```

The peer connects over an end-to-end encrypted rendezvous. The paired channel
is forwarded to your local `/mcp` and `/health` only (any other path is `403`),
with a credential injected by Bureau. The peer's own `Authorization` header
never reaches the local server.

**Hosted rendezvous.** Unless you pass `--rendezvous <url>` (a rendezvous you
run yourself), pairing uses the hosted default. Traffic is end-to-end
encrypted, but the operator of a hosted rendezvous can see connection metadata
such as when and how often devices connect. `bureau pair` prints this warning
every time it applies.

### Per-device grants

Consent grants (browser-profiles) are keyed by the paired device fingerprint.
A session that has grants is usable only by devices those grants serve, and for
the domains they cover: device A granted `github.com` can use the session
there, device B cannot. A grant with no device serves every device.

### Studio flavour

A plugin may supply its own `authorize` (`BureauPlugin.authorize`), which
replaces pairing. The studio flavour does this with the exported
`allowLoopback` to keep its loopback-open default. Only one plugin may do so.

## Development

```bash
pnpm install
pnpm build        # tsup in every package, dependency order
pnpm typecheck    # tsc --noEmit everywhere
pnpm test         # vitest, offline (fakes only)
pnpm scan         # release scan: paths, secrets, private names
```

Tests never touch a live browser. `pnpm scan` is fail-closed and must exit 0
before anything is published.

## License

Apache-2.0. See [LICENSE](./LICENSE).
