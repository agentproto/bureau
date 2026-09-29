/**
 * Credential store — platform sign-in secrets for the owned-session login flow,
 * kept entirely OUT of the orchestrator's context. The agent only ever names a
 * credential (platform + account); the secret is read here at runtime, typed
 * straight into the login page, and never logged or returned.
 *
 * Default backend = the macOS Keychain (`security`): encrypted at rest, per-user,
 * no extra deps, nothing in the repo. The port is swappable (a Linux libsecret /
 * file backend can register later) per the project's adapter convention.
 *
 * Sourcing precedence at login time (none of these surface the value to the LLM):
 *   1. --password-env VAR   — value read from the named env var
 *   2. the credential store — Keychain lookup by (platform, account)
 *   3. a hidden terminal prompt — the human types it at the CLI, never via argv
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { homedir } from "node:os"
import { join } from "node:path"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { createInterface } from "node:readline"

const exec = promisify(execFile)

export interface Credential {
  readonly account: string
  readonly password: string
}

export interface CredentialStorePort {
  /** Look up a stored secret. With no account, returns the only one for the platform. */
  get(platform: string, account?: string): Promise<Credential | null>
  set(platform: string, cred: Credential): Promise<void>
  remove(platform: string, account: string): Promise<void>
  /** The (platform, account) pairs on file — NEVER the secrets. */
  list(): Promise<Array<{ platform: string; account: string }>>
}

const SERVICE = (platform: string): string => `bureau-social-${platform}`
const indexPath = (): string =>
  join(homedir(), ".agentproto", "bureau", "creds-index.json")

/**
 * The (platform, account) index — what's stored, never the secrets. Keychain
 * itself has no clean "list by service prefix", so we keep this thin manifest
 * alongside it for `creds list` / multi-account disambiguation.
 */
async function readIndex(): Promise<Array<{ platform: string; account: string }>> {
  try {
    return JSON.parse(await readFile(indexPath(), "utf8"))
  } catch {
    return []
  }
}

async function writeIndex(
  entries: Array<{ platform: string; account: string }>
): Promise<void> {
  await mkdir(join(homedir(), ".agentproto", "bureau"), { recursive: true })
  await writeFile(indexPath(), JSON.stringify(entries, null, 2))
}

/** macOS Keychain credential store via the `security` CLI. */
export function keychainCredentialStore(): CredentialStorePort {
  return {
    async get(platform, account) {
      const idx = await readIndex()
      const acct =
        account ?? idx.find(e => e.platform === platform)?.account
      if (!acct) return null
      try {
        // -w prints ONLY the secret to stdout (consumed here, never logged).
        const { stdout } = await exec("security", [
          "find-generic-password",
          "-s",
          SERVICE(platform),
          "-a",
          acct,
          "-w",
        ])
        return { account: acct, password: stdout.replace(/\n$/, "") }
      } catch {
        return null
      }
    },

    async set(platform, cred) {
      // -U updates an existing item. The secret rides argv to `security` only
      // (a momentary, local exposure) — never to our stdout, logs, or the LLM.
      await exec("security", [
        "add-generic-password",
        "-U",
        "-s",
        SERVICE(platform),
        "-a",
        cred.account,
        "-w",
        cred.password,
        "-D",
        "bureau social login",
      ])
      const idx = await readIndex()
      if (!idx.some(e => e.platform === platform && e.account === cred.account))
        idx.push({ platform, account: cred.account })
      await writeIndex(idx)
    },

    async remove(platform, account) {
      await exec("security", [
        "delete-generic-password",
        "-s",
        SERVICE(platform),
        "-a",
        account,
      ]).catch(() => undefined)
      await writeIndex(
        (await readIndex()).filter(
          e => !(e.platform === platform && e.account === account)
        )
      )
    },

    list: readIndex,
  }
}

/** Read a line from the terminal with echo suppressed (passwords). */
export function promptHidden(label: string): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const out = process.stdout as NodeJS.WriteStream & { _writeToOutput?: unknown }
    // Mute echo: swallow everything but the first label write.
    let muted = false
    ;(out as unknown as { _writeToOutput: (s: string) => void })._writeToOutput =
      (s: string) => {
        if (!muted) {
          process.stdout.write(s)
          muted = true
        } else if (s.includes("\n")) process.stdout.write("\n")
      }
    rl.question(label, answer => {
      rl.close()
      resolve(answer)
    })
  })
}

export interface ResolveCredentialOptions {
  /** Env var holding the password (precedence 1). */
  passwordEnv?: string
  /** Fall back to a hidden terminal prompt when nothing else has it. */
  allowPrompt?: boolean
  store?: CredentialStorePort
}

/**
 * Resolve a credential for (platform, account) without ever exposing the secret
 * to the caller's logs or the model. Returns null when nothing supplies one.
 */
export async function resolveCredential(
  platform: string,
  account: string | undefined,
  opts: ResolveCredentialOptions = {}
): Promise<Credential | null> {
  if (opts.passwordEnv && process.env[opts.passwordEnv]) {
    if (!account)
      throw new Error("--account is required when using --password-env")
    return { account, password: process.env[opts.passwordEnv] as string }
  }
  const store = opts.store ?? keychainCredentialStore()
  const stored = await store.get(platform, account)
  if (stored) return stored
  if (opts.allowPrompt && process.stdin.isTTY) {
    const acct = account ?? "" // a bare prompt still needs the account named
    if (!acct) return null
    const password = await promptHidden(`${platform} password for ${acct}: `)
    return password ? { account: acct, password } : null
  }
  return null
}
