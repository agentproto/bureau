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
