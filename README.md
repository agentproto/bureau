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
- A running Camofox server, reachable
  through `CAMOFOX_URL` (default `http://127.0.0.1:9377`). `bureau start` can
  launch it for you.
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
stays open and returns `{"ok":true,"tools":N}`. A missing or invalid bearer gets
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
