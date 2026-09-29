/**
 * The recipe format. A recipe is a runnable WORKFLOW.md plus the bindings that
 * turn its step ids into tools and inject live capabilities. Core owns the
 * shape (and the engine that runs it); which recipes exist is a plugin
 * concern, registered into the {@link RecipeRegistry}.
 *
 * `tools` is opaque here (`ToolHandle` values from the agentproto tool package):
 * core never inspects them, only hands them to the workflow compiler, so this
 * type stays assignable from a descriptor built with `defineTool`.
 */

import type { DriverHandle } from "@agentproto/driver"
import type { Bindings, RuntimeWorkflow } from "@agentproto/workflow-runtime"

/**
 * A live capability the host injects onto the run input under a fixed key:
 * `session` -> `input.page`, `keys` -> `input.keys`, `deliver` -> `input.deliver`,
 * `model` -> `input.model` (optional enhancement), `sessions` -> `input.sessions`,
 * `synthesize` -> `input.synthesize` (injected only for server-enforced recipes).
 */
export type WorkflowCapKind =
  | "session"
  | "sessions"
  | "keys"
  | "deliver"
  | "model"
  | "synthesize"

/** Per-run monetization. Absent on a descriptor means free forever. */
export interface WorkflowPrice {
  /** Per-run price in displayed credits (100 cr = $1). */
  credits: number
  author: "house" | { id: string; name: string }
  /** Fraction of `credits` remitted to a non-house author (0..1). */
  revShare?: number
  /** "server": a hosted finalize step is load-bearing. "honor": fully local. */
  enforcement: "server" | "honor"
  /** First run per (account, recipe) is free. Default true. */
  firstRunFree?: boolean
}

/** One data input field: drives `workflow list` docs + required-flag checks. */
export interface WorkflowInputField {
  flag: string
  doc: string
  required?: boolean
}

/** A registered, runnable recipe. */
export interface WorkflowDescriptor {
  /** Stable run id, e.g. `hackernews-top`. */
  id: string
  name: string
  description: string
  /** The WORKFLOW.md source string. */
  manifest: string
  /** Tool registry the manifest's step ids resolve against. */
  tools: Record<string, unknown>
  /** Injects each tool step's live capability from the run input. */
  contextFor: (toolId: string, bindings: Bindings) => unknown
  /** Default driver candidate set the resolver dispatches over. */
  candidates: readonly DriverHandle[]
  /** Alternative candidates swapped in when the run input carries `source: "wttj"`. */
  wttjCandidates?: readonly DriverHandle[]
  /** Candidates used in offline mode instead of {@link candidates}. */
  offlineCandidates?: readonly DriverHandle[]
  /** Canned payload the offline session replays through `readNextData`. */
  offlineSeed?: unknown
  /** Host caps this recipe's `contextFor` reads off the run input. */
  caps: readonly WorkflowCapKind[]
  inputs: readonly WorkflowInputField[]
  /** Build the DATA portion of the run input from a parsed flag map. */
  inputFromFlags: (flags: Record<string, string>) => Record<string, unknown>
  compile: (candidates?: readonly DriverHandle[]) => RuntimeWorkflow
  price?: WorkflowPrice
}
