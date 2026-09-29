# Bureau

Bureau is an installable browser capability server. It drives a real browser
(stealth Firefox by default, or Chrome or Chromium) and exposes what it can do
as MCP tools over HTTP, so an agent can navigate, evaluate, capture and
download through a browser that holds saved identities. Every client is a
paired device: pairing is the only way in, and each device only gets the
sessions and domains you granted it.

```
agent (MCP client) --HTTP :8830, device bearer--> bureau serve --REST--> Camofox (stealth Firefox) :9377
                                                       |
                                                       +-- supervises Chrome / Chromium / any registered browser
```

Status: v1, pre-release. See [Known limits in v1](#known-limits-in-v1).

## Quickstart (5 minutes)

Requirements: Node.js 22.13 or newer. The default browser is Camofox, a
separate server (the `camofox-browser` project); Bureau launches it for you
when a launch command is configured, or reuses one that already answers on
`CAMOFOX_URL` (default `http://127.0.0.1:9377`).

**1. Install.** Once the packages are published:

```bash
npm install -g bureau-sh
```

From a checkout instead: `pnpm install && pnpm build`, then use
`node apps/bureau/dist/index.js` wherever this page says `bureau`.

**2. Start the server and the browser.**

```bash
bureau start                    # camofox by default; add --browser chrome --headless for Chrome
bureau doctor                   # checklist with a fix hint per failure
```

Bureau listens on `127.0.0.1:8830`. `GET /health` is open; everything else
needs a paired device.

**3. Pair your MCP client.** This mints a local device (no QR) and writes its
bearer into the client config. It prints the config diff with the bearer
redacted, and running it again changes nothing:

```bash
bureau install-mcp                    # Claude Code (~/.claude.json)
bureau install-mcp --client cursor    # Cursor (~/.cursor/mcp.json)
```

Restart the client. For a phone or another machine use `bureau pair` (QR and
URL); see [docs/pairing.md](docs/pairing.md).

**4. First call.** In the client, ask the agent to call `browser_navigate` with
a URL, then `browser_evaluate` with `document.title`. Or script it with the SDK:
[examples/navigate.mjs](examples/navigate.mjs).

`scripts/quickstart-check.mjs` runs steps 2 to 4 for real on a fresh temp HOME
(with a fake Camofox) and writes [docs/quickstart-run.txt](docs/quickstart-run.txt).

## Providers

A browser provider says how to launch a browser and which capabilities it has
(`cdp`, `downloads`, `stealth`, and so on). Tools that need a capability the
active browser lacks answer with a typed `browser:unsupported` error naming the
capability and the browsers that have it.

| Provider | Use | Notes |
| --- | --- | --- |
| `camofox` (alias `camoufox`) | `bureau start` | Default. Stealth Firefox behind a REST server. |
| `chrome` | `bureau start --browser chrome [--headless]` | A fresh dedicated profile. Never your own Chrome profile. |
| `chromium` | `bureau start --browser chromium --profile work` | Playwright Chromium, dedicated profile. |
| any id | `bureau start --browser <id>` | Registered by a plugin (`BureauPlugin.browsers`). |

Registering your own provider through the plugin seam, with a working sketch, is
in [docs/providers.md](docs/providers.md).

## Spec

The provider contract is the BROWSER profile of the AIP family (`defineBrowser`,
provisional number AIP-63). It is a **draft**: the number and field names can
still change before it is accepted. Draft PR:
<https://github.com/agentproto/agentproto/pull/53>.

## Examples

- [examples/mcp-client.json](examples/mcp-client.json): the MCP client entry
  `bureau install-mcp` writes, with a placeholder bearer.
- [examples/navigate.mjs](examples/navigate.mjs): a scripted `browser_navigate`
  and `browser_evaluate` with the SDK and the device bearer.

## Documentation

- [Getting started](docs/getting-started.md): install, start, layout, health, doctor
- [Pairing](docs/pairing.md): local and remote devices, revoking
- [Providers](docs/providers.md): choosing a browser, capability errors, registering one
- [Sessions and grants](docs/sessions-and-grants.md): saved identities, consent, leases, live view
- [License and plugins](docs/license-and-plugins.md): plugin API, usage meter, license check
- [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), [skills/README.md](skills/README.md)

## Layout

| Path | Package | What it is |
| --- | --- | --- |
| `apps/bureau` | `bureau-sh` | `bureau` CLI and server, plugin host, `bureau-sh/sdk` and `bureau-sh/plugin` |
| `packages/core` | `@agentproto/bureau-core` | Driver port, sessions, recordings, notifier, page-eval contracts |
| `packages/drivers` | `@agentproto/bureau-drivers` | Camofox and external-MCP browser driver backends |
| `packages/mcp` | `@agentproto/bureau-mcp` | The browser MCP tool catalogue |
| `packages/router` | `@agentproto/bureau-router` | Tiered scrape router (HTTP, chromium, camofox, agent) |
| `packages/purify` | `@agentproto/bureau-purify` | HTML to clean markdown |
| `packages/sdk` | `@agentproto/bureau-sdk` | Typed client and React hooks for a Bureau server |
| `skills/` | | Agent skills for the open pack |

This is the open core. Site-specific recipes and hosted services plug in through
the plugin seam and are not part of this repository.

## Known limits in v1

- **Tools still run through the Camofox driver.** `--browser chrome|chromium`
  launches, supervises and capability-gates, but the tool catalogue is not
  re-targeted to that browser yet. The quickstart therefore needs Camofox.
- **`download` has no driver-port verb yet.** `browser_download` is gated by the
  `downloads` capability but has no port-level implementation.
- **No encryption at rest.** Grants, the consent ledger and the pairing store are
  plain files with modes 0600 and 0700. Encrypted storage is planned for v1.1.
- **Live view is read only.** No takeover (input from the viewer) in v1.
- **Real-device rendezvous is not exercised.** The remote pairing path is proven
  over an in-memory rendezvous fake, not against the hosted rendezvous or a
  second machine.
- **macOS only for the default credential store** (`security` CLI).

## Development

```bash
pnpm install
pnpm build        # tsup in every package, dependency order
pnpm typecheck    # tsc --noEmit everywhere
pnpm test         # vitest, offline (fakes only)
pnpm scan         # release scan: paths, secrets, private names
```

Tests never touch a live browser. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).
