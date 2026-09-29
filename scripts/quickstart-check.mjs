#!/usr/bin/env node
// Runs the README quickstart end to end on a fresh temp HOME and records the
// stages to docs/quickstart-run.txt.
//
//   pnpm build && node scripts/quickstart-check.mjs
//
// Camofox is FAKED: an in-process REST server on a random loopback port that
// answers the few endpoints browser_navigate needs (and fetches the local
// fixture page, so the navigation is real HTTP). A real Camofox needs its own
// Firefox build and a launchd or serve command, so it is not started here.
// Everything else is the real built server and CLI (apps/bureau/dist).
// Nothing is contacted outside 127.0.0.1; no real browser profile, Keychain or
// user config is read; children get a minimal environment.

import { spawn, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(ROOT, "apps", "bureau", "dist", "index.js")
const OUT = join(ROOT, "docs", "quickstart-run.txt")
const FIXTURE_TITLE = "Bureau quickstart fixture"

if (!existsSync(BIN)) {
  console.error("apps/bureau/dist/index.js is missing: run `pnpm build` first")
  process.exit(2)
}

/** @type {Array<{stage: string, ms: number, ok: boolean, detail: string}>} */
const rows = []
const t0 = Date.now()
const tmp = mkdtempSync(join(tmpdir(), "bureau-quickstart-"))
const home = join(tmp, "home")
const bureauHome = join(home, ".agentproto", "bureau")
const mcpConfig = join(tmp, "mcp.json")

/** Replace machine paths so the recorded file stays portable. */
const scrub = text => text.split(tmp).join("<tmp>").split(ROOT).join("<repo>")

async function stage(name, fn) {
  const start = Date.now()
  try {
    const detail = await fn()
    rows.push({ stage: name, ms: Date.now() - start, ok: true, detail: scrub(String(detail ?? "")) })
  } catch (e) {
    rows.push({ stage: name, ms: Date.now() - start, ok: false, detail: scrub(e instanceof Error ? e.message : String(e)) })
    throw e
  }
}

const listen = server =>
  new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  })

const readBody = req =>
  new Promise(resolve => {
    const chunks = []
    req.on("data", c => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })

// The fixture page the agent navigates to.
const fixture = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" })
  res.end(`<!doctype html><title>${FIXTURE_TITLE}</title><h1>It works</h1>`)
})

// Fake camofox: tabs, navigate (fetches the page), evaluate (returns its title).
const tabs = new Map()
const camofox = createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  const raw = await readBody(req)
  const body = raw ? JSON.parse(raw) : {}
  if (url.pathname === "/health") return send(200, { ok: true, engine: "fake-camofox", browserState: "running" })
  if (url.pathname === "/tabs" && req.method === "POST") {
    const id = `tab-${tabs.size + 1}`
    tabs.set(id, { url: "about:blank", html: "" })
    return send(200, { tabId: id })
  }
  if (url.pathname === "/tabs" && req.method === "GET") return send(200, { tabs: [...tabs.keys()].map(id => ({ tabId: id })) })
  const m = /^\/tabs\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname)
  const tab = m ? tabs.get(m[1]) : undefined
  if (!m || !tab) return send(404, { error: "tab not found" })
  if (req.method === "DELETE") {
    tabs.delete(m[1])
    return send(200, { ok: true })
  }
  if (m[2] === "navigate") {
    tab.url = String(body.url)
    tab.html = await (await fetch(tab.url)).text()
    return send(200, { ok: true, url: tab.url })
  }
  if (m[2] === "evaluate") {
    const title = /<title>([^<]*)<\/title>/.exec(tab.html)?.[1] ?? ""
    return send(200, { ok: true, result: /title/.test(String(body.expression)) ? title : tab.url })
  }
  return send(200, { ok: true })
})

const cleanEnv = extra => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  BUREAU_HOME: bureauHome,
  NO_COLOR: "1",
  ...extra,
})

const cli = (args, extraEnv = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { env: cleanEnv(extraEnv), encoding: "utf8", timeout: 60_000 })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function rpc(port, bearer, id, method, params) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  })
  const text = await res.text()
  if (res.status !== 200) return { status: res.status, message: undefined }
  const data = text.startsWith("event:") || text.includes("\ndata:") ? /data: (.*)/.exec(text)?.[1] ?? "{}" : text
  return { status: res.status, message: JSON.parse(data) }
}

let server
let failure
try {
  const fixturePort = await listen(fixture)
  const camofoxPort = await listen(camofox)
  const bureauPort = await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port
      probe.close(() => resolve(p))
    })
    probe.once("error", reject)
  })
  const mcpUrl = `http://127.0.0.1:${bureauPort}/mcp`

  await stage("bureau start (server + fake camofox reused)", async () => {
    server = spawn(
      process.execPath,
      [BIN, "start", "--port", String(bureauPort), "--browser-port", String(camofoxPort), "--timeout", "40"],
      { env: cleanEnv({ CAMOFOX_URL: `http://127.0.0.1:${camofoxPort}` }), stdio: ["ignore", "pipe", "pipe"] }
    )
    let log = ""
    server.stdout.on("data", d => (log += d))
    server.stderr.on("data", d => (log += d))
    const deadline = Date.now() + 60_000
    for (;;) {
      if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode}): ${log.slice(-400)}`)
      try {
        const r = await fetch(`http://127.0.0.1:${bureauPort}/health`)
        const h = await r.json()
        if (h.state === "healthy") return `/health: browser=${h.browser} state=${h.state} tools=${h.tools} wasAlreadyRunning=${h.wasAlreadyRunning}`
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`no healthy /health within 60 s: ${log.slice(-400)}`)
      await sleep(100)
    }
  })

  await stage("/mcp without a bearer is refused", async () => {
    const r = await rpc(bureauPort, undefined, 1, "tools/list", {})
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`)
    return "401"
  })

  let firstDiff = ""
  let configAfterFirst = ""
  await stage("bureau install-mcp (first run)", async () => {
    const r = cli(["install-mcp", "--client", "cursor", "--config", mcpConfig, "--url", mcpUrl])
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`)
    firstDiff = r.stdout
    configAfterFirst = readFileSync(mcpConfig, "utf8")
    if (!/^--- /m.test(firstDiff) || !/^\+ .*"bureau"/m.test(firstDiff)) throw new Error("no config diff was printed")
    return "exit 0, config diff printed (below)"
  })
  await stage("bureau install-mcp (second run, idempotent)", async () => {
    const r = cli(["install-mcp", "--client", "cursor", "--config", mcpConfig, "--url", mcpUrl])
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`)
    if (readFileSync(mcpConfig, "utf8") !== configAfterFirst) throw new Error("the config changed on the second run")
    if (/^--- /m.test(r.stdout)) throw new Error("a second diff was printed")
    return "exit 0, config byte-identical, no diff"
  })

  const bearer = JSON.parse(readFileSync(mcpConfig, "utf8")).mcpServers.bureau.headers.Authorization.replace(/^Bearer /, "")
  await stage("MCP initialize", async () => {
    const r = await rpc(bureauPort, bearer, 2, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "quickstart-check", version: "0.0.0" },
    })
    if (r.status !== 200 || r.message?.error) throw new Error(`initialize failed: ${r.status}`)
    return `server ${r.message?.result?.serverInfo?.name ?? "?"}`
  })
  await stage("tools/list", async () => {
    const r = await rpc(bureauPort, bearer, 3, "tools/list", {})
    const names = (r.message?.result?.tools ?? []).map(t => t.name)
    if (!names.includes("browser_navigate")) throw new Error(`browser_navigate not listed (${names.length} tools)`)
    return `${names.length} tools, includes browser_navigate`
  })
  await stage("browser_navigate to the fixture page", async () => {
    const r = await rpc(bureauPort, bearer, 4, "tools/call", {
      name: "browser_navigate",
      arguments: { url: `http://127.0.0.1:${fixturePort}/` },
    })
    if (r.message?.error || r.message?.result?.isError) throw new Error(`navigate failed: ${JSON.stringify(r.message).slice(0, 300)}`)
    return `result: ${JSON.stringify(r.message?.result?.content?.[0]?.text ?? "").slice(0, 120)}`
  })
  await stage("browser_evaluate reads the page title", async () => {
    const r = await rpc(bureauPort, bearer, 5, "tools/call", {
      name: "browser_evaluate",
      arguments: { expression: "document.title" },
    })
    const text = JSON.stringify(r.message?.result?.content?.[0]?.text ?? "")
    if (!text.includes(FIXTURE_TITLE)) throw new Error(`title not seen: ${text.slice(0, 200)}`)
    return `title "${FIXTURE_TITLE}" read back`
  })
  await stage("examples/navigate.mjs (SDK) reads the title", async () => {
    // Give the example a node_modules with the built SDK, as an npm install would.
    const dir = join(tmp, "example")
    mkdirSync(join(dir, "node_modules", "@agentproto"), { recursive: true })
    symlinkSync(join(ROOT, "packages", "sdk"), join(dir, "node_modules", "@agentproto", "bureau-sdk"))
    copyFileSync(join(ROOT, "examples", "navigate.mjs"), join(dir, "navigate.mjs"))
    // Async spawn: the fake camofox and fixture live on this event loop.
    const r = await new Promise(resolve => {
      const child = spawn(process.execPath, [join(dir, "navigate.mjs"), mcpConfig, `http://127.0.0.1:${fixturePort}/`], {
        env: cleanEnv({}),
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", d => (stdout += d))
      child.stderr.on("data", d => (stderr += d))
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
      child.on("close", status => {
        clearTimeout(timer)
        resolve({ status, stdout, stderr })
      })
    })
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${(r.stderr || r.stdout).slice(0, 300)}`)
    if (!r.stdout.includes(FIXTURE_TITLE)) throw new Error(`title not printed: ${r.stdout.slice(0, 200)}`)
    return `exit 0, printed the title "${FIXTURE_TITLE}"`
  })
  await stage("bureau doctor (informational)", async () => {
    const r = cli(["doctor", "--browser", "camofox"], { CAMOFOX_URL: `http://127.0.0.1:${camofoxPort}` })
    const checks = (r.stdout || "").split("\n").map(l => /^\s*\[(ok|FAIL|skip)\]\s+([\w:-]+)/.exec(l)).filter(Boolean)
    const summary = checks.map(m => `${m[2]}=${m[1]}`).join(" ")
    return `exit ${r.status}: ${summary} (informational: the temp HOME has no Chrome profile, so chrome checks fail here)`
  })

  const diffStart = firstDiff.indexOf("--- ")
  const diffEnd = firstDiff.indexOf("Restart the host")
  writeFileSync(join(tmp, "diff.txt"), firstDiff.slice(diffStart, diffEnd < 0 ? undefined : diffEnd).trimEnd())
} catch (e) {
  failure = e
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM")
    await sleep(500)
  }
  camofox.close()
  fixture.close()
}

const total = Date.now() - t0
const ok = !failure && rows.every(r => r.ok)
const diffText = existsSync(join(tmp, "diff.txt")) ? readFileSync(join(tmp, "diff.txt"), "utf8") : ""
const report = [
  "Bureau quickstart run",
  `result: ${ok ? "PASS" : "FAIL"}   total: ${total} ms   node: ${process.version}   platform: ${process.platform}`,
  "",
  "Setup: fresh temp HOME and BUREAU_HOME, random loopback ports, the built server and CLI from apps/bureau/dist.",
  "Camofox is a FAKE REST server (tabs, navigate, evaluate) run by the script; a real Camofox is not started.",
  "The fixture page is served over real local HTTP. No real browser profile, Keychain or user MCP config was touched.",
  "",
  "stage".padEnd(52) + "ms".padStart(7) + "  status  detail",
  ...rows.map(r => r.stage.padEnd(52) + String(r.ms).padStart(7) + `  ${r.ok ? "ok    " : "FAIL  "}${r.detail}`),
  ...(failure ? ["", `failure: ${scrub(failure instanceof Error ? failure.message : String(failure))}`] : []),
  "",
  "Config diff printed by the first `bureau install-mcp` (bearer redacted by the command):",
  ...scrub(diffText).split("\n").map(l => `  ${l}`),
  "",
].join("\n")
writeFileSync(OUT, report)
rmSync(tmp, { recursive: true, force: true })
console.log(report)
process.exit(ok ? 0 : 1)
