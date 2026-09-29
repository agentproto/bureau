/**
 * Recipe registry: the set of runnable recipes a Bureau can list and run by id.
 * Core registers its sample recipes; plugins register theirs from
 * `BureauPlugin.entries(ctx)` via `ctx.recipes`.
 */

import type { WorkflowDescriptor } from "./recipe-types.js"

export interface RecipeRegistry {
  /** Add (or replace, by id) a recipe. */
  register(...recipes: readonly WorkflowDescriptor[]): void
  get(id: string): WorkflowDescriptor | undefined
  list(): readonly WorkflowDescriptor[]
}

export function createRecipeRegistry(): RecipeRegistry {
  const byId = new Map<string, WorkflowDescriptor>()
  return {
    register(...recipes) {
      for (const r of recipes) byId.set(r.id, r)
    },
    get: id => byId.get(id),
    list: () => [...byId.values()],
  }
}

/** The process-wide registry the composition root and the CLI share. */
export const recipeRegistry: RecipeRegistry = createRecipeRegistry()
