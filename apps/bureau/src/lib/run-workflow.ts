/**
 * Headless workflow runner — the host-neutral core of `bureau workflow run`,
 * shared by the CLI command and the `bureau_workflow_run` MCP tool so the two
 * surfaces never drift on how a workflow is compiled, how its live caps are
 * built, or how its input is assembled.
 *
 * What stays OUT of here on purpose: how a delivery channel is built (the CLI
 * renders a PDF + sends WhatsApp; the MCP tool returns the messages in its
 * response) and how flags/args are parsed. The caller owns transport — it
 * passes a ready {@link ChannelPort} when the workflow declares the `deliver`
 * cap, and a flat input record. Everything else — session resolution (offline /
 * saved-session / anonymous live), key vault, candidate selection, compile, and
 * the actual run — is identical and lives here.
 */

import { runWorkflow } from "@agentproto/workflow-runtime"
import { fromCamofoxSession, openHumanSession } from "./human-session.js"
import type { WorkflowDescriptor } from "./recipe-types.js"
import type { HumanSession, KeyVault, ChannelPort } from "./ports.js"
import { sessionResolver, bureauSessionDeps } from "./sessions.js"
import { getWorkflowHooks } from "./workflow-hooks.js"

/** True when a descriptor's payoff is enforced server-side (its load-bearing
 *  step runs on Bureau Cloud behind the paid hold). */
export function isServerEnforced(desc: WorkflowDescriptor): boolean {
  return desc.price?.enforcement === "server"
}

/** A fake session that replays a fixed payload — offline mode (generic). */
export function fakeSession(nextData: unknown): HumanSession {
  return {
    navigate: async () => {},
    evaluate: async () => undefined,
    gotoPaced: async () => {},
    scroll: async () => {},
    acceptConsent: async () => true,
    type: async () => {},
    click: async () => {},
    press: async () => {},
    isBlocked: async () => false,
    readNextData: async () => nextData as never,
  }
}

/** How the run's live `session` cap is satisfied. Exactly one of the three
 *  drives `input.page`; a workflow with no `session` cap ignores all of them. */
export interface WorkflowSessionOpts {
  /** Replay a parsed JSON payload via a fake session (no browser/network). */
  offline?: unknown
  /** Drive a saved, logged-in identity by id. */
  sessionId?: string
  /** Open an anonymous live camofox tab at this URL (no saved login). */
  liveUrl?: string
  /** Camofox base url for the anonymous live session (defaults to local). */
  camofox?: string
  /**
   * Run a self-heal pre-flight before resolving a saved session (default: on).
   * Pass `false` to skip — e.g. `--no-heal` CLI flag or `heal:false` via MCP.
   * No-op when `offline` or `liveUrl` is used (only applies to `--session` runs).
   */
  heal?: boolean
}

/** True when the run should use the workflow's offline DRIVER stubs. */
export function isOffline(opts: WorkflowSessionOpts): boolean {
  return opts.offline !== undefined
}

/**
 * Build the live capability bag the descriptor's `contextFor` reads off the run
 * input. `deliver` is injected by the caller (transport-owned) — we only place
 * it under the cap key and fail loudly when a delivering workflow gets none.
 */
export async function buildWorkflowCaps(
  desc: WorkflowDescriptor,
  session: WorkflowSessionOpts,
  deliver?: ChannelPort,
  runId?: string
): Promise<Record<string, unknown>> {
  const caps: Record<string, unknown> = {}

  if (desc.caps.includes("session")) {
    if (session.offline !== undefined) {
      // `offline: true` is the "replay the workflow's own canned seed" sentinel
      // (a dependency-free dry run); any other value is an explicit payload the
      // caller supplied (e.g. the CLI's `--offline <data.json>`). MCP clients
      // routinely stringify booleans, so accept "true" as the same sentinel —
      // else it would be replayed verbatim as the seed data and blow up downstream.
      const wantsSeed = session.offline === true || session.offline === "true"
      const seed = wantsSeed ? desc.offlineSeed : session.offline
      caps.page = fakeSession(seed)
    } else if (session.sessionId) {
      // Pre-flight: heal a stale/auth-walled session before wasting a run on it.
      // Default-on; skip only when the caller opts out via heal:false/--no-heal.
      const { ensureHealthy } = getWorkflowHooks()
      if (session.heal !== false && ensureHealthy) {
        const heal = await ensureHealthy(session.sessionId)
        if (heal.abortMessage) throw new Error(heal.abortMessage)
      }
      caps.page = await sessionResolver(bureauSessionDeps()).resolve(
        session.sessionId
      )
    } else if (session.liveUrl) {
      const live = await openHumanSession({
        base: session.camofox,
        userId: new URL(session.liveUrl).hostname.replace(/^www\./, ""),
        url: session.liveUrl,
        injectCookies: false,
      })
      caps.page = fromCamofoxSession(live)
    } else {
      throw new Error(
        `workflow "${desc.id}" needs a session: pass offline, session, or liveUrl`
      )
    }
  }

  if (desc.caps.includes("keys")) {
    const vault: KeyVault = { get: name => process.env[name] }
    caps.keys = vault
  }

  // `model` is OPTIONAL: injected only for live runs, and only when a plugin
  // supplies a resolver. With none (or no resolvable model) the cap stays absent
  // so optional judgment steps degrade to a no-op instead of failing. `runId`
  // is set only for a priced run with a placed hold.
  const hooks = getWorkflowHooks()
  if (desc.caps.includes("model") && !isOffline(session) && hooks.resolveModel) {
    const model = await hooks.resolveModel(runId ? { runId } : {})
    if (model) caps.model = model
  }

  // `sessions` is a resolver over all locally-saved bureau sessions — always
  // constructible (may resolve nothing if no sessions saved, but never throws
  // at cap-build time). Social tools resolve per-platform by session name.
  if (desc.caps.includes("sessions")) {
    caps.sessions = sessionResolver(bureauSessionDeps())
  }

  if (desc.caps.includes("deliver")) {
    if (!deliver) {
      throw new Error(
        `workflow "${desc.id}" declares a delivery channel but none was provided`
      )
    }
    caps.deliver = deliver
  }

  // Server-enforced payoff (§4): build the SynthesizePort so `remoteDistillDriver`
  // runs the load-bearing step on Bureau Cloud behind the paid hold. Gated on
  // ENFORCEMENT (not desc.caps) — an honor/free run never builds it. Skipped for
  // an offline dry run (no hold, no network → local stub distill).
  if (isServerEnforced(desc) && !isOffline(session)) {
    // Fail-closed invariant: a server-enforced run ALWAYS carries a runId
    // (priced ⇒ authorize placed a hold ⇒ `proxyRunId(charge)` is defined). A
    // missing runId means the billing gate never ran — REFUSE rather than
    // silently distilling locally for free.
    if (!runId) {
      throw new Error(
        `workflow "${desc.id}" is server-enforced but has no runId — refusing to ` +
          "run (the billing hold is missing; it would otherwise distill locally)."
      )
    }
    const port = await hooks.resolveSynthesize?.({ runId, workflowId: desc.id })
    if (!port) {
      throw new Error(
        `workflow "${desc.id}" is server-enforced but no cloud link is configured ` +
          "— run `bureau link` to connect a cloud account."
      )
    }
    caps.synthesize = port
  }

  return caps
}

/**
 * Compile + run a workflow. `inputs` is the flat DATA record (the descriptor's
 * `inputFromFlags` maps it to the run input); `caps` is the bag from
 * {@link buildWorkflowCaps}. Returns the workflow's structured output.
 */
export async function executeWorkflow(
  desc: WorkflowDescriptor,
  inputs: Record<string, string>,
  caps: Record<string, unknown>,
  opts: { offline: boolean }
): Promise<unknown> {
  let candidates =
    opts.offline && desc.offlineCandidates
      ? desc.offlineCandidates
      : desc.candidates
  // Multi-source: swap in WTTJ candidates when the run input asks for it.
  if (!opts.offline && desc.wttjCandidates && inputs.source === "wttj") {
    candidates = desc.wttjCandidates
  }
  // Server-enforced live run: prepend `remoteDistillDriver` so it wins
  // `corpus.distill` by cost-0 (§4). The `corpus.distill` local body is never
  // invoked — the fail-closed remote driver produces the artifact or throws.
  // Not applied offline (a dry run has no hold and uses the local stubs).
  const extra = getWorkflowHooks().serverEnforcedDrivers
  if (!opts.offline && isServerEnforced(desc) && extra?.length) {
    candidates = [...extra, ...candidates]
  }
  const workflow = desc.compile(candidates)
  const { output } = await runWorkflow({
    workflow,
    input: { ...desc.inputFromFlags(inputs), ...caps },
  })
  return output
}
