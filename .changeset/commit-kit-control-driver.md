---
"@agentproto/bureau": patch
---

Fix: `src/lib/browser-registry.ts` (committed in e182d07) imports
`./kit-control-driver.js`, a file that was never committed to git — a `git
add` omission that left the module missing from history. Add
`src/lib/kit-control-driver.ts` (+ its test), restoring the build. This is
the kit-control bridge that lets a supervised chrome/chromium browser drive
the `browser_*` control tools directly over the kit's CDP port, instead of
falling back to the camofox REST driver which doesn't support them.
