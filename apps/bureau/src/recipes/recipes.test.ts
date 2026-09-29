/**
 * The two sample recipes core ships, run network-free: `offline: true` swaps
 * the live page for a fake that replays the recipe's own seed, both through the
 * engine directly and through the `bureau_workflow_run` MCP entry.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createRecipeRegistry } from "../lib/recipe-registry.js"
import { buildWorkflowCaps, executeWorkflow } from "../lib/run-workflow.js"
import { createWorkflowEntries } from "../lib/workflow-tools.js"
import { recipeRegistry } from "../lib/recipe-registry.js"
import type { WorkflowDescriptor } from "../lib/recipe-types.js"
import {
  githubRepo,
  hackerNewsTop,
  recipeTemplate,
  registerSampleRecipes,
} from "./index.js"

async function runOffline(
  desc: WorkflowDescriptor,
  inputs: Record<string, string>
): Promise<unknown> {
  const caps = await buildWorkflowCaps(desc, { offline: true })
  return executeWorkflow(desc, inputs, caps, { offline: true })
}

describe("sample recipes against the offline fake", () => {
  it("hackernews-top returns the seeded stories, limited", async () => {
    const out = (await runOffline(hackerNewsTop, { limit: "2" })) as {
      source: string
      stories: Array<{ id: string; title: string }>
    }
    expect(out.source).toBe("news.ycombinator.com")
    expect(out.stories.map(s => s.id)).toEqual(["1", "2"])
  })

  it("hackernews-top rejects an out-of-range limit", async () => {
    await expect(runOffline(hackerNewsTop, { limit: "99" })).rejects.toThrow(
      /limit/
    )
  })

  it("github-repo returns the seeded repo summary", async () => {
    const out = (await runOffline(githubRepo, { repo: "octocat/hello-world" })) as {
      fullName: string
      stars: number
    }
    expect(out.fullName).toBe("octocat/hello-world")
    expect(out.stars).toBe(1234)
  })

  it("github-repo requires an owner/name repo", async () => {
    await expect(runOffline(githubRepo, { repo: "nope" })).rejects.toThrow(
      /owner\/name/
    )
  })

  it("the empty template compiles and runs offline (it is not registered by core)", async () => {
    const out = await runOffline(recipeTemplate, {})
    expect(out).toEqual({ title: undefined })
    const registry = createRecipeRegistry()
    registerSampleRecipes(registry)
    expect(registry.list().map(r => r.id).sort()).toEqual([
      "github-repo",
      "hackernews-top",
    ])
  })
})

describe("sample recipes through bureau_workflow_list / bureau_workflow_run", () => {
  let dir: string
  const prior = process.env.BUREAU_BINDINGS_DIR
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bureau-bindings-"))
    process.env.BUREAU_BINDINGS_DIR = dir
    registerSampleRecipes(recipeRegistry)
  })
  afterEach(() => {
    if (prior === undefined) delete process.env.BUREAU_BINDINGS_DIR
    else process.env.BUREAU_BINDINGS_DIR = prior
    rmSync(dir, { recursive: true, force: true })
  })

  const parse = (r: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> =>
    JSON.parse(r.content[0]?.text ?? "{}") as Record<string, unknown>

  it("lists both samples and runs hackernews-top offline", async () => {
    const [list, run] = createWorkflowEntries()
    const listed = parse(await list!.call({})) as { workflows: Array<{ id: string }> }
    expect(listed.workflows.map(w => w.id)).toEqual(
      expect.arrayContaining(["github-repo", "hackernews-top"])
    )
    const res = parse(
      await run!.call({ id: "hackernews-top", offline: true, inputs: { limit: "1" } })
    ) as { output: { stories: unknown[] } }
    expect(res.output.stories).toHaveLength(1)
  })

  it("returns a structured error, not a throw, for a missing required input", async () => {
    const [, run] = createWorkflowEntries()
    const res = parse(await run!.call({ id: "github-repo", offline: true }))
    expect(String(res.error)).toMatch(/needs inputs: repo/)
  })
})
