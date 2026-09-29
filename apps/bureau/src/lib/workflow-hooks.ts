/**
 * Extension points of the workflow engine. Core ships free-only defaults (a
 * priced recipe fails closed); a plugin swaps in billing, session self-heal, a
 * hosted model proxy and the server-enforced payoff driver via
 * `ctx.workflow.set(...)` inside `BureauPlugin.entries`.
 */

import type { DriverHandle } from "@agentproto/driver"
import type { WorkflowDescriptor } from "./recipe-types.js"
import type { ModelPort, SynthesizePort } from "./ports.js"

/** Local price classification: the only money fact the client owns. */
export type BillingKind =
  | { free: true }
  | { free: false; priceCredits: number; firstRunFree: boolean }

/** A recipe with no price (or a non-positive one) is free forever. */
export function resolveBilling(desc: WorkflowDescriptor): BillingKind {
  const p = desc.price
  if (!p || p.credits <= 0) return { free: true }
  return {
    free: false,
    priceCredits: p.credits,
    firstRunFree: p.firstRunFree !== false,
  }
}

/** Opaque billing state carried from `preRun` to capture/release. */
export type WorkflowCharge = object

export type PreRunOutcome =
  | { proceed: true; charge: WorkflowCharge }
  | { proceed: false; message: string }

export interface WorkflowBilling {
  /** Gate + authorize a run; never runs the recipe itself. */
  preRun(
    desc: WorkflowDescriptor,
    opts: {
      approve: (priceCredits: number, firstRunFree: boolean) => Promise<boolean> | boolean
    }
  ): Promise<PreRunOutcome>
  /** The run id to stamp on hosted-proxy calls, when a hold is placed. */
  proxyRunId(charge: WorkflowCharge): string | undefined
  captureOnSuccess(charge: WorkflowCharge): Promise<void>
  releaseOnFailure(charge: WorkflowCharge): Promise<void>
}

export interface WorkflowHooks {
  billing: WorkflowBilling
  /** Pre-flight for a saved-session run; `abortMessage` set means refuse to run. */
  ensureHealthy?: (sessionId: string) => Promise<{ abortMessage?: string }>
  /** Model port for recipes that list the optional `model` cap. */
  resolveModel?: (opts: { runId?: string }) => Promise<ModelPort | undefined>
  /** Remote-compute port for server-enforced recipes. */
  resolveSynthesize?: (opts: {
    runId: string
    workflowId: string
  }) => Promise<SynthesizePort | undefined>
  /** Drivers prepended to the candidates of a live server-enforced run. */
  serverEnforcedDrivers?: readonly DriverHandle[]
}

/** Core default: free recipes run, anything priced is refused. */
export const freeOnlyBilling: WorkflowBilling = {
  async preRun(desc) {
    const billing = resolveBilling(desc)
    if (billing.free) return { proceed: true, charge: {} }
    return {
      proceed: false,
      message:
        `"${desc.id}" is a paid recipe (${billing.priceCredits} cr) and this ` +
        "Bureau has no billing plugin loaded. Load one with --plugin to run it.",
    }
  },
  proxyRunId: () => undefined,
  captureOnSuccess: async () => {},
  releaseOnFailure: async () => {},
}

let current: WorkflowHooks = { billing: freeOnlyBilling }

export function getWorkflowHooks(): WorkflowHooks {
  return current
}

/** Merge hooks over the current set (later calls win). */
export function setWorkflowHooks(patch: Partial<WorkflowHooks>): void {
  current = { ...current, ...patch }
}

/** Restore the free-only defaults (tests). */
export function resetWorkflowHooks(): void {
  current = { billing: freeOnlyBilling }
}
