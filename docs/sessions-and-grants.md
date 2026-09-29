# Sessions and grants

A session is a saved browser identity: the cookies and storage of a login, kept
by Bureau so an agent can use it without ever seeing a password.

```bash
bureau session scan                     # list Chrome profiles that look like identities
bureau session list                     # saved sessions, then grants
bureau session show <id>
bureau session rm <id>
```

## Consent grants

```bash
bureau session import --from chrome --domains github.com,x.com --yes
bureau session import --from chrome --domains github.com     # asks per domain
bureau session revoke github.com                             # or a grant id
```

`import` grants Bureau the cookies of the named domains only. Without `--yes` it
asks per domain on a terminal; without a terminal it fails unless both
`--domains` and `--yes` are given. Wildcards and `all` are rejected. `list` shows
domains, granted-at and the device fingerprint, never cookie values. `revoke`
deletes the derived cookie material and appends a row to the hash-chained consent
ledger. The agent (MCP) surface cannot add a domain or change the profile; such
attempts are refused and recorded as `deny` rows.

Grants are scoped per paired device (see [pairing.md](pairing.md)). Importing a
whole Chrome profile is possible only with `--full-profile` and a recorded grant.

## Session lease

`session_lease` lends only the granted domains' session cookies, for one run
(default 300 s, at most 900 s), to a paired device. It needs a human approval,
made in a terminal:

```bash
bureau session lease-approve --session ID --device FP --domains a.com,b.com
```

There is no `--yes`. The approval is an ed25519 signed record (AIP-7 shape:
request, payload, signature; `signerKind: user`, `click_through`) signed by a
local approver key in the Bureau home. A lease is refused for a domain the
approval or the device's active grant does not cover, a replayed or expired
approval, a bad signature, or a call with no approval id. `session_lease_revoke`
ends a lease. Each issue, use, revoke, expiry and deny is a row in a hash-chained
`lease-ledger.jsonl` (ids, domains, counts, a fixed code; never a cookie value).

Receiver contract: keep the returned cookies in memory only, never write them to
disk, a log or a cache; call `session_lease` with the `leaseId` before each use;
drop them on any refusal, at `expiresAt`, and after a revoke. Revoking the
consent grant also ends the lease. The lease tools exist only where a consent
host does (the pairing flavour).

## Live view

`GET /live/<session>` streams screenshots of an already open session as MJPEG
(`multipart/x-mixed-replace`), viewable in a plain `<img>` and forwarded by the
pairing tunnel. It uses the same authorizer as `/mcp` (401 with no detail) and the
per-device grant check (403). It is read only: every method but GET is 405, it
never opens a session (404), frames are at least 250 ms apart, a device gets at
most 3 streams, and a stream ends after 10 minutes or when the grant is revoked.
Takeover (input from the viewer) is not in v1.
