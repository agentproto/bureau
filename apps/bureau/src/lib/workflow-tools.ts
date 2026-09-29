/**
 * Workflow tool entries — `bureau_workflow_list` and `bureau_workflow_run`.
 *
 * Exposes the declarative AIP-15 workflow registry over MCP. `list` discovers
 * available workflows and any pre-configured bindings (which pre-fill session +
 * standing inputs). `run` executes one, captures any delivery messages (instead
 * of sending them externally) and returns the structured output.
 */

import { z } from "zod"
import type { ChannelPort } from "./ports.js"
import {
  buildWorkflowCaps,
  executeWorkflow,
  isOffline,
  type WorkflowSessionOpts,
} from "./run-workflow.js"
import { resolveRunnable, resolveRun, listRunnable } from "./bindings.js"
import { resolveBilling, getWorkflowHooks } from "./workflow-hooks.js"
import { asContent, toInputSchema, type McpEntry } from "../mcp-tool.js"

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

export function createWorkflowEntries(): McpEntry[] {
  const workflowListEntry: McpEntry = {
    name: "bureau_workflow_list",
    description:
      "List the declarative workflows this Bureau can run: id, name, what it " +
      "does, required inputs, and which live capabilities it needs. A pre-" +
      "configured entry (a binding) shows `boundFrom` + `sessionAttached` and " +
      "asks only for the inputs it hasn't pre-filled. Call before " +
      "bureau_workflow_run to discover ids + inputs.",
    jsonSchema: toInputSchema(z.object({})),
    call: async () => asContent({ workflows: await listRunnable() }),
  }

  const workflowRunEntry: McpEntry = {
    name: "bureau_workflow_run",
    description:
      "Run a registered workflow OR a pre-configured binding by id and return " +
      "its structured output. Pass `inputs` (per bureau_workflow_list) and, when " +
      "the workflow needs a session, ONE of: `offline` (a canned payload, no " +
      "browser), `session` (a saved logged-in identity id), or `liveUrl` (an " +
      "anonymous live camofox tab). A binding pre-fills its session + standing " +
      "inputs; anything you pass here overrides them. Any delivery is captured " +
      "and returned, not sent externally. A PRICED workflow (see `price` in " +
      "bureau_workflow_list) requires `confirmPaid:true` to run — without it the " +
      "call returns `{ needsApproval, price }` and does NOT run or charge.",
    jsonSchema: toInputSchema(
      z.object({
        id: z.string().describe("Workflow id from bureau_workflow_list."),
        inputs: z
          .record(z.string(), z.string())
          .optional()
          .describe("Data inputs keyed by the workflow's input flags."),
        session: z
          .string()
          .optional()
          .describe("Saved session id to drive (logged-in identity)."),
        liveUrl: z
          .string()
          .optional()
          .describe("Open an anonymous live camofox tab at this URL."),
        offline: z
          .unknown()
          .optional()
          .describe(
            "Canned payload to replay (no browser/network): the workflow's " +
              "seed shape, or `true` to replay its built-in seed."
          ),
        heal: z
          .union([z.boolean(), z.string()])
          .optional()
          .describe(
            "Pass false to skip the session self-heal pre-flight (default: on). " +
              "Only applies to saved `session` runs; offline/liveUrl are unaffected."
          ),
        confirmPaid: z
          .union([z.boolean(), z.string()])
          .optional()
          .describe(
            "Set true to approve the per-run charge on a PRICED workflow. " +
              "Required for a priced run (the MCP surface can't prompt); free " +
              "workflows ignore it."
          ),
      })
    ),
    call: async args => {
      const a = args as {
        id?: unknown
        inputs?: Record<string, string>
        session?: string
        liveUrl?: string
        offline?: unknown
        heal?: boolean | string
        confirmPaid?: boolean | string
      }
      const id = String(a.id ?? "")
      const runnable = await resolveRunnable(id)
      if (!runnable) {
        return asContent({
          error: `unknown workflow "${id}"`,
          available: (await listRunnable()).map(e => e.id),
        })
      }
      const { desc, binding } = runnable
      // Merge binding's defaults UNDER the call (call wins), then validate.
      const { inputs, sessionId } = resolveRun(binding, {
        inputs: a.inputs ?? {},
        sessionId: a.session,
      })
      const missing = desc.inputs
        .filter(f => f.required && !inputs[f.flag])
        .map(f => f.flag)
      if (missing.length) {
        return asContent({
          error: `${id} needs inputs: ${missing.join(", ")}`,
        })
      }

      // Approval gate — MCP has no prompt, so a priced run is a two-call confirm
      // (mirrors gated workflows' draft-then-confirm). Without confirmPaid:true a
      // priced run returns `{ needsApproval }` and does NOT run or charge.
      const confirmPaid = a.confirmPaid === true || a.confirmPaid === "true"
      const billing = resolveBilling(desc)
      if (!billing.free && !confirmPaid) {
        return asContent({
          needsApproval: true,
          price: billing.priceCredits,
          message:
            `"${id}" costs ${billing.priceCredits} cr` +
            (billing.firstRunFree ? " (first run free)" : "") +
            ". Re-run with confirmPaid:true to authorize the charge.",
        })
      }
      // The two-call confirm IS the gate, so preRun's approve is trivially true.
      const { billing: hooksBilling } = getWorkflowHooks()
      const pre = await hooksBilling.preRun(desc, { approve: () => true })
      if (!pre.proceed) {
        return asContent({ error: pre.message })
      }
      const charge = pre.charge

      // heal defaults to true; MCP clients may stringify booleans → accept "false"
      const healOpt = a.heal === false || a.heal === "false" ? false : undefined
      const sessionOpts: WorkflowSessionOpts = {
        offline: a.offline,
        sessionId,
        liveUrl: a.liveUrl,
        ...(healOpt !== undefined ? { heal: healOpt } : {}),
      }
      const delivered: Array<{
        to?: string
        text?: string
        hasDocument: boolean
      }> = []
      const collectChannel: ChannelPort = {
        async send(message) {
          delivered.push({
            to: message.to,
            text: message.text ?? message.caption,
            hasDocument: Boolean(message.document),
          })
          return { id: "bureau-mcp" }
        },
      }
      let caps: Record<string, unknown>
      try {
        caps = await buildWorkflowCaps(
          desc,
          sessionOpts,
          desc.caps.includes("deliver") ? collectChannel : undefined,
          // Held run ⇒ stamp the runId so priced-run inference folds (§5d).
          hooksBilling.proxyRunId(charge)
        )
      } catch (e) {
        await hooksBilling.releaseOnFailure(charge)
        return asContent({ error: errMsg(e) })
      }

      let output: unknown
      try {
        output = await executeWorkflow(desc, inputs, caps, {
          offline: isOffline(sessionOpts),
        })
      } catch (e) {
        await hooksBilling.releaseOnFailure(charge) // void the hold on run failure
        return asContent({ error: `run failed: ${errMsg(e)}` })
      }

      // Success → capture (settle). A finalize failure IS a run failure (S3):
      // captureOnSuccess voids the hold internally, then rethrows.
      try {
        await hooksBilling.captureOnSuccess(charge)
      } catch (e) {
        return asContent({
          error: `billing finalize failed: ${errMsg(e)} — run not charged`,
        })
      }

      return asContent({
        id,
        ...(binding ? { workflow: desc.id } : {}),
        output,
        delivered,
      })
    },
  }

  return [workflowListEntry, workflowRunEntry]
}
