import type { RecipeRegistry } from "../lib/recipe-registry.js"
import { githubRepo } from "./github-repo.js"
import { hackerNewsTop } from "./hackernews-top.js"

export { githubRepo, hackerNewsTop }
export { recipeTemplate } from "./template.js"
export { definePageRecipe, readPage } from "./page-recipe.js"
export type { PageRecipeSpec } from "./page-recipe.js"

/** The two harmless recipes core ships (public pages, no login). */
export function registerSampleRecipes(registry: RecipeRegistry): void {
  registry.register(hackerNewsTop, githubRepo)
}
