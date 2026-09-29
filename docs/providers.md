# Providers

A browser provider is a validated manifest (id, transport, capabilities, install
and launch requirements) plus an idempotent `launch`. The contract is the BROWSER
profile of the AIP family (provisional AIP-63, a draft, see the README).

## Choosing a browser

```bash
bureau start                                   # camofox (default)
bureau start --browser chrome --headless       # a fresh dedicated Chrome profile
bureau start --browser chromium --profile work # Playwright Chromium, dedicated profile "work"
bureau start --browser acme-browser            # any id a plugin registers
```

- **Chrome and Chromium never touch your Chrome profile.** `--profile` names a
  fresh dedicated directory under the Bureau home; the default Chrome
  user-data-dir and the profile name `Default` are refused. Using a whole profile
  needs `--full-profile <grant-id>` with an active recorded grant, and works only
  when Bureau's own pairing is in use.
- **Launch is idempotent.** A healthy browser is reused (`wasAlreadyRunning`),
  and Bureau never kills a browser it did not start.

Known limit: the tool catalogue still executes through the Camofox driver. The
browser you choose drives launch, supervision, `/health` and capability gating;
it does not yet re-target the tools.

## Capability errors

Each provider declares capabilities. One table (`CAPABILITY_TOOL_TABLE` in
`apps/bureau/src/lib/capability-gate.ts`) maps a capability to the tools that
need it: `cdp` (`browser_list_requests`, `browser_get_request_body`,
`browser_cdp_send`), `downloads` (`browser_download`), `stealth` (`scrape`,
`browser_act`). A tool whose capability the active browser lacks answers with
`code: "browser:unsupported"`, naming the capability, the active browser and the
browsers that have it. The check is by declared capability, never by provider id.

## Registering a third-party provider

A plugin default-exports a `BureauPlugin` with `browsers`. Load it with
`bureau start --plugin ./my-plugin.js --browser acme-browser` or
`BUREAU_PLUGINS=./my-plugin.js`.

```ts
import { defineBrowser } from "@agentproto/driver-browser"
import type { BureauPlugin } from "bureau-sh/plugin"

const acme = defineBrowser({
  id: "acme-browser",
  name: "Acme Browser",
  description: "A remote browser reached over HTTP.",
  version: "0.1.0",
  transport: "http",
  location: "remote",
  capabilities: { canCookies: true },
  async launch(options, ctx) {
    // Idempotent: return the running instance when one is healthy.
    // Must return a BrowserInstance: id, endpoints, wasAlreadyRunning,
    // health(), attach() (returns a BrowserDriver) and stop().
    throw new Error("implement launch for your browser")
  },
})

export default {
  name: "acme",
  entries: () => [],
  browsers: [acme],
  // Tools of this plugin that need a capability; the gate answers for them.
  toolCapabilities: { acme_capture: "cdp" },
} satisfies BureauPlugin
```

Capabilities are manifest flags. Process-level: `stealth`, `headless`, `headed`,
`persistentProfile`, `multiInstance`, `recording`, `cdp`, `downloads`. Page-level:
`canCaptureResponseBodies`, `canDispatchTrustedInput`, `canMultiTarget`,
`canThrottleNetwork`, `isUserVisible`, `canScreencast`, `canRecordVideo`,
`canStealth`, `canFullPageScreenshot`, `canAiActions`, `canCookies`. Unknown keys
are rejected, so a typo cannot silently declare nothing. The conformance suite in
`@agentproto/driver-browser` runs against a fake server; run it on your provider
before publishing.

The capability names are the kit's today and may be renamed to follow the AIP
draft (see the follow-ups in `LAUNCH-CHECKLIST.md`).
