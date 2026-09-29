# Security

## Reporting a vulnerability

Send a private report to `security@bureau.example` (placeholder until the
maintainers set the real address). Please include the version, what you did and
what happened. Do not open a public issue for an unfixed vulnerability. We aim to
acknowledge within 3 working days.

## Threat model

Bureau drives a browser that holds saved logins, so the thing to protect is
access to that browser and to those identities. Bureau is meant to run on the
machine of the person who owns the browser.

**Pairing is the only way in.** `/mcp` and `/live/*` accept a device bearer minted
by pairing (AIP-59) and nothing else: no static token, no shared secret, no
password. Requests with a missing or bad bearer get `401` and a body that reveals
nothing. Only `/health` is open, and it returns state and counts, never secrets.
`bureau install-mcp` mints a local device and writes its bearer into your MCP
client config with mode 0600; the bearer is never printed or logged.

**Loopback and Host/Origin guard.** The server listens on `127.0.0.1`. A Host and
Origin guard sits in front of every route, so a web page in your own browser
cannot reach it through DNS rebinding or a cross-origin request. Exposing Bureau
beyond loopback is not a supported configuration; use `bureau pair` for a remote
device, which goes through an end-to-end encrypted rendezvous and forwards only
`/mcp`, `/health` and `/live/*`.

**Per-device grants.** A saved session is usable only by devices that hold a
consent grant for it, and only for the granted domains. Revoking a device
(`bureau devices revoke`) or a grant takes effect on the next call.

**Session lease.** `session_lease` lends granted-domain cookies for a short run
after a human approval signed with a local ed25519 approver key. Limits you should
know: the approver key lives in the Bureau home, so an agent that can read and
run things as your OS user can in principle sign its own approval. The lease
protects against a paired remote agent, not against code already running as you.
Receivers must keep leased cookies in memory only.

**Live view.** `GET /live/<session>` is read only (screenshots as MJPEG). There is
no input path from the viewer in v1. It uses the same authorizer as `/mcp`.

## Known weak points in v1

- **The Camofox link is plain HTTP on loopback.** Bureau talks to Camofox over
  REST at `CAMOFOX_URL` (default `http://127.0.0.1:9377`). Any local process can
  call that port. Set `CAMOFOX_API_KEY` if your Camofox supports it, and do not
  point `CAMOFOX_URL` at another machine.
- **No encryption at rest.** Grants, the consent ledger, the lease ledger, the
  pairing store and the approver key are plain files (modes 0600 and 0700).
  Anyone with your OS account or your disk can read them. Encrypted storage is
  planned for v1.1.
- **Hosted rendezvous metadata.** With the default rendezvous, its operator can
  see when and how often devices connect (not the content). Run your own with
  `--rendezvous <url>` to avoid that.
- **macOS credential store.** The default credential store uses the `security`
  CLI, so it is macOS only.
- **The remote pairing path has been tested against an in-memory rendezvous, not
  against a second real machine.**

## What is out of scope

An attacker who already runs code as your OS user, physical access to an
unlocked machine, and vulnerabilities in Camofox, Chrome or Chromium themselves
(report those upstream).
