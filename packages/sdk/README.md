# @agentproto/bureau-sdk

Typed client for a **Bureau** capability server — the local browser stack that
exposes its sessions, tabs and actions as MCP tools.

`@agentproto/bureau-mcp` is the **server** (produces the tools). This is the
**client**: validated reads plus a one-shot snapshot, over an **injected
transport** so the same code serves every surface.

```ts
import { createBureauClient, createHttpTransport } from "@agentproto/bureau-sdk"

// Local mode — the packaged app talks to its own Bureau:
const bureau = createBureauClient(
  createHttpTransport({ baseUrl: "http://127.0.0.1:8830" })
)
const { connected, sessions, tabs } = await bureau.snapshot()

// Tunnel mode — a connected cloud forwards over the daemon reverse-tunnel:
const bureau = createBureauClient({
  callTool: (toolName, args) =>
    bridge.callImportedMcp({
      userId,
      alias: "bureau",
      toolName,
      args: args ?? {},
    }),
})
```

## React

```tsx
import { useBureau } from "@agentproto/bureau-sdk/react"

const fetchStatus = useCallback(
  () =>
    fetch("/api/v1/me/bureau/status", { credentials: "include" }).then(r =>
      r.json()
    ),
  []
)
const { status, loading, error, reload } = useBureau(fetchStatus)
```

The hook owns load/error/refresh; the host owns the fetch and the rendering.

## Contract notes

- **Metadata only.** Cookies and credentials never cross the transport — the
  Bureau tools return identities by name, never their bytes.
- `connected` is liveness (the daemon answered); `configured` is host-decided (a
  Bureau is linked at all) and wraps a snapshot host-side.
- Vendor-neutral: no app-specific imports, no styling.
