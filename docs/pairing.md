# Pairing

`/mcp` accepts one credential: a device bearer minted by pairing (AIP-59). There
is no static token, no shared secret environment variable and no password.
`/health` stays open. A missing or invalid bearer gets `401` with
`WWW-Authenticate: Bearer realm="bureau"` and a body that says nothing about
why. The Host and Origin guard stays on in front of both.

## Local: your own MCP host

```bash
bureau install-mcp                # claude (default)
bureau install-mcp --client cursor
bureau install-mcp --config <path> --url <mcp-url> --name <key> --device <label>
```

This mints a local device (no QR) and writes its bearer into the host's MCP
config (mode 0600), keeping every other key. It prints the config diff with the
bearer replaced by a placeholder; the bearer is never printed or logged.

It is idempotent. If the entry already holds a valid device for the same URL,
nothing changes and no diff is printed. If the entry is missing, points at a
different URL or holds a revoked device, it writes a new device, revokes the
device the old entry held and prints the diff. `--rotate` forces a fresh device.
A config that is not valid JSON is left untouched.

## Remote: another machine or phone

```bash
bureau pair                       # prints a QR and a URL (the server must be running)
bureau pair --no-qr --ttl 300
bureau devices list
bureau devices revoke <id|name>   # takes effect on the very next request
```

The peer connects over an end-to-end encrypted rendezvous. The paired channel is
forwarded to your local `/mcp`, `/health` and `/live/*` only (any other path is
`403`), with a credential injected by Bureau. The peer's own `Authorization`
header never reaches the local server.

**Hosted rendezvous.** Unless you pass `--rendezvous <url>` (a rendezvous you
run yourself), pairing uses the hosted default. Traffic is end-to-end encrypted,
but the operator of a hosted rendezvous can see connection metadata such as when
and how often devices connect. `bureau pair` prints this warning every time it
applies.

## Per-device grants

Consent grants are keyed by the paired device fingerprint. A session that has
grants is usable only by devices those grants serve, and only for the domains
they cover: device A granted `github.com` can use the session there, device B
cannot. A grant with no device serves every device. See
[sessions-and-grants.md](sessions-and-grants.md).

## Embedding: replacing the authorizer

A plugin may supply its own `authorize` (`BureauPlugin.authorize`), which
replaces pairing. The exported `allowLoopback` keeps a loopback-open default for
an embedding that has its own trust boundary. Only one plugin may do so, and with
it there is no consent host, so no grants and no lease tools.
