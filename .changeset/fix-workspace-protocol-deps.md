---
"@agentproto/bureau": patch
"@agentproto/bureau-mcp": patch
"@agentproto/bureau-drivers": patch
---

Fix: the published 0.1.0 tarballs for these packages still carried the
literal `workspace:*` protocol on their internal dependencies, which a plain
`npm install` or `pnpm add` cannot resolve outside this workspace. Pin those
dependencies to resolved `^0.1.0` ranges instead. CI now fails on any
`workspace:` range left in a publishable package.json.
