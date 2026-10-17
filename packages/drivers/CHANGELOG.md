# @agentproto/bureau-drivers

## 0.1.1

### Patch Changes

- 9c2867f: Fix: the published 0.1.0 tarballs for these packages still carried
  the literal `workspace:*` protocol on their internal dependencies, which a
  plain `npm install` or `pnpm add` cannot resolve outside this workspace. Pin
  those dependencies to resolved `^0.1.0` ranges instead. CI now fails on any
  `workspace:` range left in a publishable package.json.
- 66e89f6: Initial public release: Camofox and external-MCP browser driver
  backends.
- Updated dependencies [66e89f6]
  - @agentproto/bureau-core@0.1.1
