// Scripted browser_navigate and browser_evaluate with the Bureau SDK.
//
//   npm install @agentproto/bureau-sdk
//   bureau start && bureau install-mcp --client cursor --config ./mcp.json
//   node navigate.mjs ./mcp.json https://example.com
//
// The device bearer comes from the MCP config that `bureau install-mcp` wrote.
// Never commit that file.

import { readFileSync } from "node:fs"
import { createHttpTransport } from "@agentproto/bureau-sdk"

const [configPath = "./mcp.json", url = "https://example.com", server = "bureau"] = process.argv.slice(2)

const entry = JSON.parse(readFileSync(configPath, "utf8")).mcpServers?.[server]
if (!entry?.url || !entry.headers?.Authorization) {
  console.error(`no "${server}" entry with a bearer in ${configPath}; run bureau install-mcp first`)
  process.exit(2)
}

// The transport posts to <baseUrl>/mcp; wrap fetch to add the device bearer.
const authorizedFetch = (input, init = {}) =>
  fetch(input, { ...init, headers: { ...init.headers, authorization: entry.headers.Authorization } })

const bureau = createHttpTransport({
  baseUrl: new URL(entry.url).origin,
  fetchImpl: authorizedFetch,
})

const text = result => result.content.map(block => block.text ?? "").join("")

const navigated = await bureau.callTool("browser_navigate", { url })
if (navigated.isError) throw new Error(text(navigated))
console.log("navigated:", text(navigated))

const title = await bureau.callTool("browser_evaluate", { expression: "document.title" })
if (title.isError) throw new Error(text(title))
console.log("title:", text(title))
