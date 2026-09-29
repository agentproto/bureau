/**
 * Workflow bindings: a saved overlay that pre-fills a recipe's session +
 * standing input args so a configured run isn't re-typed each call. A binding is
 * partial application of a recipe, resolved in the SAME id-space as raw recipes.
 *
 * Invariants enforced here:
 *   - secret-free: a binding holds a session NAME, resolved at run time.
 *   - can't pre-arm a side-effect: mode/safety flags ({@link RESERVED_DEFAULT_KEYS})
 *     are rejected from defaults, so `live` stays a fresh per-call decision.
 *   - call wins: anything passed at run time overrides the binding.
 *
 * Host wiring (directory + default store + default registry) is at the bottom.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

import { recipeRegistry, type RecipeRegistry } from "./recipe-registry.js"
import type {
  WorkflowDescriptor,
  WorkflowCapKind,
  WorkflowPrice,
} from "./recipe-types.js"

/**
 * Flag keys a binding's `defaults` may NOT carry — the mode/safety switches that
 * turn a preview into an irreversible or money-spending action. Keeping these
 * out of a saved file is what preserves "live is always an explicit per-call
 * decision" for bound processes.
 */
export const RESERVED_DEFAULT_KEYS = ["live", "confirmPaid"] as const

/** A saved binding — `id` is authoritative; a host's file store derives the
 *  filename from it (one source of truth, mirroring the session store). */
export const WorkflowBindingSchema = z
  .object({
    /** The binding's runnable id, e.g. `weekly-airbnb`. Shares the workflow
     *  id-space (a `run <id>` resolves a binding before a raw workflow). */
    id: z.string().min(1),
    /** Registry id of the workflow this binds, e.g. `lodging-report`. */
    workflow: z.string().min(1),
    /** Saved session ref to attach (a pointer; cookies stay in the session
     *  store, resolved at run time). Omit for a defaults-only binding. */
    session: z.string().min(1).optional(),
    /** Standing flag values merged UNDER the call's inputs (call wins). DATA
     *  args only — {@link RESERVED_DEFAULT_KEYS} are rejected. */
    defaults: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((b, ctx) => {
    for (const key of Object.keys(b.defaults ?? {})) {
      if ((RESERVED_DEFAULT_KEYS as readonly string[]).includes(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["defaults", key],
          message:
            `"${key}" is a mode/safety flag and can't be a binding default — ` +
            `it must stay an explicit per-call decision`,
        })
      }
    }
  })

export type WorkflowBinding = z.infer<typeof WorkflowBindingSchema>

/**
 * Validate a binding against the live catalogue (the checks the zod schema can't
 * make on its own). Returns a list of human-readable errors — empty when valid.
 * Used by an authoring command (hard fail) and by the store's read path
 * (skip + warn).
 */
export function validateAgainstCatalog(
  b: WorkflowBinding,
  registry: RecipeRegistry = recipeRegistry
): string[] {
  const errors: string[] = []
  const desc = registry.get(b.workflow)
  if (!desc) {
    errors.push(
      `unknown workflow "${b.workflow}" (registered: ${
        registry.list().map(w => w.id).join(", ") || "none"
      })`
    )
  }
  // The binding id can't collide with a raw workflow id — resolution checks
  // bindings first, so a collision would shadow the workflow.
  if (registry.get(b.id)) {
    errors.push(
      `binding id "${b.id}" collides with a registered workflow of the same name`
    )
  }
  // Every default must name a real input flag of the bound workflow (catches
  // typos that would otherwise silently do nothing).
  if (desc) {
    const known = new Set(desc.inputs.map(f => f.flag))
    for (const key of Object.keys(b.defaults ?? {})) {
      if (!known.has(key)) {
        errors.push(
          `default "${key}" is not an input of ${desc.id} (inputs: ${
            desc.inputs.map(f => f.flag).join(", ") || "none"
          })`
        )
      }
    }
  }
  return errors
}

/** Persisted store of bindings — the host injects one (a local-file store now,
 *  a multi-tenant adapter later), mirroring {@link SessionStorePort}. */
export interface BindingStore {
  save(binding: WorkflowBinding): Promise<void>
  load(id: string): Promise<WorkflowBinding | null>
  list(): Promise<WorkflowBinding[]>
  remove(id: string): Promise<void>
}

/** Local-file adapter: one `<id>.json` per binding under `dir`. Read paths
 *  validate and skip invalid files loudly rather than crash a list. */
export function fileBindingStore(dir: string): BindingStore {
  const fileFor = (id: string) =>
    join(dir, `${id.replace(/[^\w.-]/g, "_")}.json`)
  const parse = (raw: string): WorkflowBinding =>
    WorkflowBindingSchema.parse(JSON.parse(raw))
  return {
    async save(binding) {
      const parsed = WorkflowBindingSchema.parse(binding)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(fileFor(parsed.id), JSON.stringify(parsed, null, 2))
    },
    async load(id) {
      try {
        return parse(readFileSync(fileFor(id), "utf8"))
      } catch {
        return null
      }
    },
    async list() {
      if (!existsSync(dir)) return []
      const out: WorkflowBinding[] = []
      for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) {
        try {
          out.push(parse(readFileSync(join(dir, f), "utf8")))
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            `⚠ skipping invalid binding ${f}: ${
              e instanceof Error ? e.message : String(e)
            }`
          )
        }
      }
      return out
    },
    async remove(id) {
      rmSync(fileFor(id), { force: true })
    },
  }
}

/** The flat run input + session ref after a binding's defaults/session are
 *  merged under the call (call always wins). */
export interface ResolvedRun {
  inputs: Record<string, string>
  sessionId?: string
}

/**
 * Merge a binding's standing config under the call — the whole behavioural
 * change. With no binding it is the identity (today's behaviour byte-for-byte).
 * Mode/per-call concerns (offline, liveUrl, send) are NOT binding fields, so the
 * caller keeps reading those from the call directly.
 */
export function resolveRun(
  binding: WorkflowBinding | undefined,
  call: { inputs: Record<string, string>; sessionId?: string }
): ResolvedRun {
  return {
    inputs: { ...(binding?.defaults ?? {}), ...call.inputs },
    sessionId: call.sessionId ?? binding?.session,
  }
}

/** A resolved runnable: the workflow descriptor + the binding it came from (if
 *  the id named a binding rather than a raw workflow). */
export interface Runnable {
  desc: WorkflowDescriptor
  binding?: WorkflowBinding
}

/**
 * Resolve a runnable id in the unified id-space: a binding name first (merging
 * its workflow + config), else a raw workflow id. `undefined` when neither
 * matches, or when a binding points at a workflow that's since been unregistered.
 */
export async function resolveRunnableIn(
  id: string,
  store: BindingStore,
  registry: RecipeRegistry
): Promise<Runnable | undefined> {
  const binding = await store.load(id)
  if (binding) {
    const desc = registry.get(binding.workflow)
    return desc ? { desc, binding } : undefined
  }
  const desc = registry.get(id)
  return desc ? { desc } : undefined
}

/** One entry in the unified runnable list — a raw workflow, or a binding shown
 *  as a pre-configured entry that asks only for the inputs it hasn't pre-filled. */
export interface RunnableEntry {
  id: string
  name: string
  description: string
  caps: readonly WorkflowCapKind[]
  /** The workflow id this binds — present only for bindings. */
  boundFrom?: string
  /** Whether a session is pre-attached — present only for bindings. */
  sessionAttached?: boolean
  /** Per-run monetization (inherited from the bound workflow). Absent ⇒ free. */
  price?: WorkflowPrice
  /** Inputs the caller still supplies (a binding's pre-filled defaults removed). */
  inputs: { flag: string; doc: string; required: boolean }[]
}

function rawEntry(w: WorkflowDescriptor): RunnableEntry {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    caps: w.caps,
    ...(w.price ? { price: w.price } : {}),
    inputs: w.inputs.map(f => ({
      flag: f.flag,
      doc: f.doc,
      required: Boolean(f.required),
    })),
  }
}

function boundEntry(
  b: WorkflowBinding,
  registry: RecipeRegistry
): RunnableEntry | undefined {
  const w = registry.get(b.workflow)
  if (!w) return undefined
  const prefilled = new Set(Object.keys(b.defaults ?? {}))
  return {
    id: b.id,
    name: w.name,
    description: w.description,
    caps: w.caps,
    ...(w.price ? { price: w.price } : {}),
    boundFrom: w.id,
    sessionAttached: Boolean(b.session),
    // Only what's still needed: a default-covered input is satisfied, so it
    // drops out of the list (a required one is no longer "missing").
    inputs: w.inputs
      .filter(f => !prefilled.has(f.flag))
      .map(f => ({ flag: f.flag, doc: f.doc, required: Boolean(f.required) })),
  }
}

/**
 * The unified runnable list both surfaces (a CLI `workflow list`, the
 * `bureau_workflow_list` MCP tool) render — raw workflows plus bound entries —
 * so the two never drift.
 */
export async function listRunnableIn(
  store: BindingStore,
  registry: RecipeRegistry
): Promise<RunnableEntry[]> {
  const raw = registry.list().map(rawEntry)
  const bound = (await store.list())
    .map(b => boundEntry(b, registry))
    .filter((e): e is RunnableEntry => e !== undefined)
  return [...raw, ...bound]
}

export function bindingsDir(): string {
  return (
    process.env.BUREAU_BINDINGS_DIR ??
    join(homedir(), ".agentproto", "bureau", "bindings")
  )
}

/** The default local-file binding store for this Bureau. */
export function bindingStore(dir: string = bindingsDir()): BindingStore {
  return fileBindingStore(dir)
}

/** Resolve a runnable id (binding first, else raw recipe) over the default store + registry. */
export function resolveRunnable(
  id: string,
  store: BindingStore = bindingStore(),
  registry: RecipeRegistry = recipeRegistry
): Promise<Runnable | undefined> {
  return resolveRunnableIn(id, store, registry)
}

/** The unified runnable list (raw recipes + bound entries) over the default store + registry. */
export function listRunnable(
  store: BindingStore = bindingStore(),
  registry: RecipeRegistry = recipeRegistry
): Promise<RunnableEntry[]> {
  return listRunnableIn(store, registry)
}
