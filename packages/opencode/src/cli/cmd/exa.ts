import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

/**
 * exa-specific commands (fork-only file, kept out of upstream paths so fork
 * syncs stay clean): the sandbox (internet access) switch and the SQL
 * operation-class grants — the same controls the Exasol Studio chat panel
 * exposes, so CLI and app behave identically.
 *
 * Both edit the global opencode.json (respecting OPENCODE_CONFIG_DIR, which
 * the app pins to its managed config). Agent permissions and prompts are
 * boot-time state, so changes apply to the NEXT engine start.
 */

const SQL_OPS = ["insert", "update", "delete", "create", "alter", "drop", "dcl", "admin"] as const

type AgentEntry = { permission?: Record<string, unknown>; options?: Record<string, unknown> } & Record<string, unknown>
type ConfigRoot = { agent?: Record<string, AgentEntry> } & Record<string, unknown>

const configFile = () => path.join(Global.Path.config, "opencode.json")

const readConfig = Effect.promise(async () => {
  const fs = await import("node:fs/promises")
  let root: ConfigRoot = {}
  try {
    root = JSON.parse(await fs.readFile(configFile(), "utf8")) as ConfigRoot
  } catch {
    /* absent or unreadable — start fresh */
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) root = {}
  return root
})

const writeConfig = (root: ConfigRoot) =>
  Effect.promise(async () => {
    const fs = await import("node:fs/promises")
    await fs.mkdir(path.dirname(configFile()), { recursive: true })
    await fs.writeFile(configFile(), JSON.stringify(root, null, 2))
  })

function exaAgent(root: ConfigRoot): AgentEntry {
  root.agent = root.agent ?? {}
  root.agent["exa"] = root.agent["exa"] ?? {}
  return root.agent["exa"]
}

const RESTART_NOTE = "Applies to the next engine start — restart a running exa session (or the Exasol Studio engine) to apply now."

export const SandboxCommand = effectCmd({
  command: "sandbox [state]",
  describe: "show or set the exa agent's internet access (sandbox)",
  builder: (yargs) =>
    yargs.positional("state", {
      describe: "on = allow web tools, off = sandboxed (default), status = show",
      type: "string",
      choices: ["status", "on", "off"] as const,
    }),
  handler: Effect.fn("Cli.exa.sandbox")(function* (args) {
    const root = yield* readConfig
    const current = () => {
      const p = root.agent?.["exa"]?.permission
      return p?.webfetch === "allow" && p?.websearch === "allow"
    }
    const state = args.state ?? "status"
    if (state === "status") {
      UI.println(`internet access: ${current() ? "ON" : "OFF (sandboxed)"}`)
      return
    }
    const action = state === "on" ? "allow" : "deny"
    const agent = exaAgent(root)
    agent.permission = agent.permission ?? {}
    agent.permission.webfetch = action
    agent.permission.websearch = action
    yield* writeConfig(root)
    UI.println(`internet access: ${state === "on" ? "ON" : "OFF (sandboxed)"}`)
    UI.println(RESTART_NOTE)
  }),
})

export const OpsCommand = effectCmd({
  command: "ops [action] [classes..]",
  describe: "show or change the SQL operation classes the exa agent may run",
  builder: (yargs) =>
    yargs
      .positional("action", {
        describe: "list = show grants, grant/revoke = change them",
        type: "string",
        choices: ["list", "grant", "revoke"] as const,
      })
      .positional("classes", {
        describe: `operation classes: ${SQL_OPS.join(", ")} — or "all"`,
        type: "string",
        array: true,
      }),
  handler: Effect.fn("Cli.exa.ops")(function* (args) {
    const root = yield* readConfig
    const agent = exaAgent(root)
    const stored = (agent.options as { sqlOps?: unknown } | undefined)?.sqlOps
    const current = new Set<string>(
      Array.isArray(stored) ? stored.filter((o): o is string => SQL_OPS.includes(o as (typeof SQL_OPS)[number])) : [],
    )
    const show = () => {
      const granted = SQL_OPS.filter((o) => current.has(o))
      UI.println(granted.length === 0 ? "granted SQL operations: none (read-only)" : `granted SQL operations: ${granted.join(", ")}`)
    }
    const action = args.action ?? "list"
    if (action === "list") {
      show()
      return
    }
    const requested = (args.classes ?? []).map((c) => c.toLowerCase())
    if (requested.length === 0) return yield* fail(`Name the classes to ${action}: ${SQL_OPS.join(", ")} — or "all".`)
    const expanded = requested.includes("all") ? [...SQL_OPS] : requested
    const unknown = expanded.filter((c) => !SQL_OPS.includes(c as (typeof SQL_OPS)[number]))
    if (unknown.length > 0) return yield* fail(`Unknown operation class(es): ${unknown.join(", ")}. Valid: ${SQL_OPS.join(", ")}.`)
    for (const c of expanded) {
      if (action === "grant") current.add(c)
      else current.delete(c)
    }
    agent.options = agent.options ?? {}
    agent.options.sqlOps = SQL_OPS.filter((o) => current.has(o))
    yield* writeConfig(root)
    show()
    UI.println(RESTART_NOTE)
  }),
})
