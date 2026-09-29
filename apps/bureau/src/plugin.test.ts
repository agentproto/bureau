/**
 * The plugin seam: specs, loading, and fail-loud startup. A plugin that cannot
 * load, has the wrong shape, throws building tools, is refused by its license,
 * or reuses a core tool name must abort with a PluginLoadError, never silently
 * drop tools.
 */

import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  PluginLoadError,
  activatePlugins,
  loadPlugin,
  loadPlugins,
  pluginSpecs,
  type BureauPlugin,
} from "./plugin.js"
import { buildCatalogue, runServe } from "./serve.js"
import { runCli } from "./cli.js"
import {
  bureauSessionDeps,
  clearSessionSources,
  type BureauSessionDeps,
} from "./lib/sessions.js"

/** Static fixtures: vite-node cannot dynamic-import files outside the project root. */
const fixture = (name: string): string =>
  fileURLToPath(new URL(`./__tests__/fixtures/plugins/${name}`, import.meta.url))

afterEach(() => clearSessionSources())

const good = (name: string, tool: string): BureauPlugin => ({
  name,
  entries: () => [
    {
      name: tool,
      description: "d",
      jsonSchema: { type: "object", properties: {} },
      call: async () => ({ content: [] }),
    },
  ],
})

describe("pluginSpecs", () => {
  it("reads --plugin (both forms) and BUREAU_PLUGINS, de-duplicated", () => {
    expect(
      pluginSpecs(["--plugin", "./a.js", "--plugin=./b.js", "--host", "x"], {
        BUREAU_PLUGINS: " ./b.js, pkg-c ,",
      })
    ).toEqual(["./a.js", "./b.js", "pkg-c"])
  })

  it("returns nothing when neither is set", () => {
    expect(pluginSpecs(["--host", "0.0.0.0"], {})).toEqual([])
  })
})

describe("loadPlugin fails loudly", () => {
  it("a path that does not exist", async () => {
    await expect(loadPlugin(fixture("missing.mjs"))).rejects.toBeInstanceOf(
      PluginLoadError
    )
  })

  it("a module that throws on import", async () => {
    const p = fixture("throws.mjs")
    await expect(loadPlugin(p)).rejects.toThrow(/boom at import/)
  })

  it("an export that is not a plugin", async () => {
    const p = fixture("shape.mjs")
    await expect(loadPlugin(p)).rejects.toThrow(/entries/)
  })

  it("a factory that throws", async () => {
    const p = fixture("factory.mjs")
    await expect(loadPlugin(p)).rejects.toThrow(/factory threw: no key/)
  })

  it("a license refusal", async () => {
    const p = fixture("license.mjs")
    await expect(loadPlugin(p)).rejects.toThrow(/license refused: expired/)
  })

  it("loads a valid plugin from a path (object and factory forms)", async () => {
    const a = fixture("ok-a.mjs")
    const b = fixture("ok-b.mjs")
    const loaded = await loadPlugins([a, b])
    expect(loaded.map(p => p.name)).toEqual(["a", "b"])
  })

  it("stops at the first bad plugin in a list", async () => {
    const a = fixture("ok-b.mjs")
    await expect(loadPlugins([a, fixture("nope.mjs")])).rejects.toBeInstanceOf(
      PluginLoadError
    )
  })
})

describe("buildCatalogue with plugins", () => {
  it("adds a plugin's tools after core's and its http routes", () => {
    let hit = false
    const plugin: BureauPlugin = {
      ...good("extra", "extra_tool"),
      httpRoutes: () => {
        hit = true
        return true
      },
    }
    const { entries, extraRoutes } = buildCatalogue({ plugins: [plugin] })
    expect(entries.at(-1)?.name).toBe("extra_tool")
    expect(extraRoutes?.({} as never, {} as never)).toBe(true)
    expect(hit).toBe(true)
  })

  it("aborts when entries() throws", () => {
    const bad: BureauPlugin = {
      name: "bad",
      entries: () => {
        throw new Error("cannot build")
      },
    }
    expect(() => buildCatalogue({ plugins: [bad] })).toThrow(
      /plugin "bad" failed to load: entries\(\) threw: cannot build/
    )
  })

  it("aborts when a plugin reuses a core tool name", () => {
    expect(() =>
      buildCatalogue({ plugins: [good("dup", "browser_navigate")] })
    ).toThrow(/tool "browser_navigate" is already registered by core/)
  })

  it("aborts when two plugins register the same tool", () => {
    expect(() =>
      buildCatalogue({ plugins: [good("one", "shared"), good("two", "shared")] })
    ).toThrow(/tool "shared" is already registered by one/)
  })
})

describe("session sources", () => {
  it("a plugin's source supplies the managed-session deps", () => {
    const deps: BureauSessionDeps = {
      catalogs: [{ kind: "test", catalog: { list: async () => [], get: async () => null } }],
    }
    activatePlugins([
      { name: "s", entries: () => [], sessionSources: [{ name: "src", deps: () => deps }] },
    ])
    expect(bureauSessionDeps()).toBe(deps)
  })

  it("with no source registered the deps are empty", () => {
    expect(bureauSessionDeps()).toEqual({})
  })
})

describe("startup", () => {
  it("runServe rejects on a broken plugin before opening a port", async () => {
    const before = {
      rejection: process.listeners("unhandledRejection"),
      exception: process.listeners("uncaughtException"),
    }
    try {
      await expect(
        runServe(["--plugin", fixture("missing.mjs")])
      ).rejects.toBeInstanceOf(PluginLoadError)
    } finally {
      for (const l of process.listeners("unhandledRejection"))
        if (!before.rejection.includes(l)) process.off("unhandledRejection", l)
      for (const l of process.listeners("uncaughtException"))
        if (!before.exception.includes(l)) process.off("uncaughtException", l)
    }
  })

  it("the CLI exits non-zero with the plugin's name in the message", async () => {
    const p = fixture("shape.mjs")
    const prior = process.exitCode
    const errors: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => void errors.push(a.join(" "))
    try {
      await runCli(["serve", "--plugin", p])
      expect(process.exitCode).toBe(1)
      expect(errors.join("\n")).toMatch(/failed to load/)
    } finally {
      console.error = orig
      process.exitCode = prior
    }
  })

  it("plugin subcommands are dispatched by the CLI", async () => {
    const seen: string[][] = []
    const prior = process.exitCode
    try {
      await runCli(["hello", "--x", "1"], {
        plugins: [
          {
            name: "cmd",
            entries: () => [],
            commands: { hello: async argv => (seen.push(argv), 0) },
          },
        ],
      })
      expect(seen).toEqual([["--x", "1"]])
    } finally {
      process.exitCode = prior
    }
  })
})
