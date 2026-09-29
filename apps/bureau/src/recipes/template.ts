import { definePageRecipe } from "./page-recipe.js"

/**
 * Empty recipe template: copy this file, rename the id, fill in `inputs`,
 * `parseInput` and `read`, then register it (a plugin does
 * `ctx.recipes.register(myRecipe)`). It is deliberately NOT registered by core.
 */
export const recipeTemplate = definePageRecipe({
  id: "template",
  name: "Recipe template",
  description: "Replace with what this recipe reads and returns.",
  inputs: [],
  parseInput: () => ({}),
  offlineSeed: {},
  read: async page => {
    await page.gotoPaced("https://example.com/")
    return { title: await page.evaluate<string>("document.title") }
  },
})
