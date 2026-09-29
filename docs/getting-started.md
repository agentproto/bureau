# Getting started

## Requirements

- Node.js 22.13 or newer (and pnpm to build from source).
- A browser. Camofox (default) is a separate server reachable at `CAMOFOX_URL`
  (default `http://127.0.0.1:9377`); Chrome and Chromium are launched by Bureau.
- macOS for the default credential store, which uses the `security` CLI.

## Install

```bash
npm install -g bureau-sh        # once published
# or from a checkout:
pnpm install && pnpm build
node apps/bureau/dist/index.js start
```

## Start and stop

```bash
bureau start                                   # camofox (default) plus the server
bureau start --browser chrome --headless       # a fresh dedicated Chrome profile
bureau start --detach                          # background; writes <BUREAU_HOME>/bureau-run.json
bureau stop                                    # stops only what bureau start began
bureau serve --no-browser                      # the server only; the browser is managed elsewhere
```

Flags: `--browser camofox|chrome|chromium|<id>`, `--headless | --headed`,
`--profile <name>`, `--port` (Bureau), `--browser-port`, `--camofox-cmd`,
`--timeout <seconds>`, `--detach`, `--plugin <path|pkg>`. `BUREAU_BROWSER` sets
the default browser, `BUREAU_PORT` or `PORT` the port, `BUREAU_HOST` the bind
address (default `127.0.0.1`).

`bureau start` is idempotent: a Bureau or browser that already answers `/health`
is reused, never respawned. `bureau start` with a different `--browser` than the
running one refuses and points at `bureau stop`. `bureau stop` signals only a
Bureau that wrote the state file and answers `/health` on its recorded port; a
browser Bureau merely found running is left running.

## State

Bureau state lives in `~/.agentproto/bureau` (override with `BUREAU_HOME`):
`pairings.json` (0600), `identity.json`, `grants.json`, the consent and lease
ledgers, and `bureau-run.json`. Saved sessions live under
`~/.agentproto/bureau/sessions` (override with `BUREAU_SESSIONS_DIR`).

## Health

`GET /health` is open. It returns `ok` and `tools`, plus:

| field | meaning |
| --- | --- |
| `browser` | id of the active browser |
| `state` | `starting`, `healthy`, `degraded`, `crash-looping` or `stopped` |
| `restarts` | relaunches since Bureau started |
| `wasAlreadyRunning` | Bureau reused a browser it did not start |
| `since` | ISO time the current state began |
| `licenseRefusals` | only when a plugin was refused by its license: `[{plugin, reason}]` |

Bureau's own `/health` always answers HTTP 200, so a crashing browser never takes
Bureau down; read `state`. Retries stop once the supervisor reports
`crash-looping` (3 launch failures in 5 minutes by default). Run `bureau start`
again to reset it.

## Doctor

```bash
bureau doctor [--browser ID] [--profile NAME] [--keychain] [--json]
```

Prints a checklist with a fix hint per failure and exits 1 if any check fails:
browser availability, Camofox reachability and its `/health`, Chrome `Local
State`, Full Disk Access (an `EPERM` names the binary that needs it), the pairing
store and consent ledger being mode 0600, the ledger hash chain verifying, and
how `authorize` is configured. `--keychain` also probes the macOS Keychain and
may show a prompt.

## Verify the whole flow

`scripts/quickstart-check.mjs` starts the built server on a temp HOME, pairs with
`install-mcp` twice, calls `tools/list` and `browser_navigate`, and records the
timings in [quickstart-run.txt](quickstart-run.txt). It uses a fake Camofox.
