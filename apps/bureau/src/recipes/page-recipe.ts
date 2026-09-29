/**
 * Author a single-page recipe without the agentproto tool package: a recipe
 * that drives the injected `session` page and returns structured output. It is
 * the smallest useful {@link WorkflowDescriptor}: one `transform` step that
 * runs `read(page, input)` and returns its result.
 */

import type { Bindings, RuntimeWorkflow } from "@agentproto/workflow-runtime"
import type { HumanSession } from "../lib/ports.js"
import type {
  WorkflowDescriptor,
  WorkflowInputField,
} from "../lib/recipe-types.js"

export interface PageRecipeSpec<TInput extends Record<string, unknown>> {
  id: string
  name: string
  description: string
  inputs: readonly WorkflowInputField[]
  /** Parse the flat flag map into the typed run input (throw on bad input). */
  parseInput: (flags: Record<string, string>) => TInput
  /** Payload the offline (fake) session replays through `readNextData`. */
  offlineSeed?: unknown
  /** Drive the page and return the recipe's output. */
  read: (page: HumanSession, input: TInput) => Promise<unknown>
}

/** Read a value from the live page, or the offline seed when the fake session
 *  (which has no DOM) answers `undefined`. */
export async function readPage<T>(
  page: HumanSession,
  expression: string
): Promise<T | undefined> {
  const live = await page.evaluate<T | undefined>(expression)
  if (live !== undefined && live !== null) return live
  return (await page.readNextData<T | null>("(d => d)")) ?? undefined
}

function inputOf(b: Bindings): Record<string, unknown> & { page?: HumanSession } {
  return (b.input ?? {}) as Record<string, unknown> & { page?: HumanSession }
}

export function definePageRecipe<TInput extends Record<string, unknown>>(
  spec: PageRecipeSpec<TInput>
): WorkflowDescriptor {
  const compile = (): RuntimeWorkflow => ({
    id: spec.id,
    description: spec.description,
    steps: [
      {
        kind: "transform",
        id: "read",
        compute: b => {
          const input = inputOf(b)
          if (!input.page)
            throw new Error(`recipe "${spec.id}" needs the session capability`)
          return spec.read(input.page, input as unknown as TInput)
        },
      },
    ],
    output: b => b.steps.read,
  })
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    manifest: `# ${spec.name}\n\n${spec.description}\n`,
    tools: {},
    contextFor: () => undefined,
    candidates: [],
    caps: ["session"],
    inputs: spec.inputs,
    inputFromFlags: flags => spec.parseInput(flags),
    offlineSeed: spec.offlineSeed,
    compile,
  }
}
