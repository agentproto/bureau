/** Tiny argv helpers shared by the `bureau` subcommands. */

/** Minimal `--flag value` / `--flag=value` parser; positionals collected too. */
export function parseArgs(argv: string[]): {
  positionals: string[]
  flags: Record<string, string>
} {
  const positionals: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    // Trim so that shell `\ --flag` continuation artifacts (leading space) are
    // still recognised as flags, not silently dropped into positionals.
    const a = argv[i].trim()
    if (!a) continue
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const next = argv[i + 1]?.trim()
        if (next && !next.startsWith("--")) {
          flags[a.slice(2)] = next
          i++
        } else {
          flags[a.slice(2)] = "true"
        }
      }
    } else {
      positionals.push(a)
    }
  }
  return { positionals, flags }
}

export function out(s: string): void {
  // eslint-disable-next-line no-console
  console.log(s)
}

/**
 * Typed boolean env reader — the one place a process.env flag is read, so
 * callers (e.g. the rate-limiter kill-switch) never touch `process.env`
 * directly. Accepts "1"/"true" (case-insensitive) as true; anything else,
 * or an unset var, falls back to `defaultValue`.
 */
export function boolEnv(name: string, defaultValue = false): boolean {
  const raw = process.env[name]
  if (raw == null) return defaultValue
  return /^(1|true)$/i.test(raw.trim())
}

/**
 * Typed integer env reader — parses `name` as a base-10 int, falling back to
 * `defaultValue` when the var is unset or not a finite integer. Keeps callers
 * (e.g. the screen-gate rate budget) off raw `process.env`.
 */
export function numEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw == null) return defaultValue
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(n) ? n : defaultValue
}

/**
 * Screen-CUA kill switch — `BUREAU_SCREEN_ACT=off` disables ALL gated screen
 * actuation (click/type/key). Any other value (or unset) leaves it enabled.
 * The one place this env is read for the gate's default `killed`.
 */
export function screenActKilled(): boolean {
  return (process.env.BUREAU_SCREEN_ACT ?? "").trim().toLowerCase() === "off"
}

/**
 * Max gated screen actions per rolling 60s window — `BUREAU_SCREEN_MAX_PER_MIN`
 * (int, default 20). The gate's default `maxPerMin`.
 */
export function screenMaxPerMin(): number {
  return numEnv("BUREAU_SCREEN_MAX_PER_MIN", 20)
}
