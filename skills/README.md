# Skills

Agent skills for Bureau, in the standard `SKILL.md` format.

## What ships in the open pack

| Skill | Ships | Notes |
| --- | --- | --- |
| `bureau` | yes | Drives Bureau itself: the daemon, sessions, capture, workflows. |
| `browser` | decide | The foundation skill for "do X in a browser as me". Refers to a host app, a tunnel and a daemon that are not part of this repository, and to a launchd label. Ship after those references are made generic, or keep it private. |

Not shipped: `local-browser` (decided: not shipped — it depends on a
non-public host stack).

## What stays private

Site- and platform-specific recipes (per-network capture adapters and their SOPs),
hosted-service runbooks, and anything that names a private product or
infrastructure. They plug in through the plugin seam and live outside this repo.

## Rule for anything added here

A skill in this folder must pass `pnpm scan` and must work with only what this
repository and the public packages provide. If it needs a private component, it
belongs to the private pack.
