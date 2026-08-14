import { Effect } from "effect"
import * as prompts from "@clack/prompts"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { parseDsn } from "../../database/registry"
import { forgetConnection, listConnections, probe, saveConnection } from "../../database/connection"
import { choiceFromValue, prepareSetup } from "../../database/setup"
import { installPersonal } from "../../database/install"

/**
 * `exa connect` — attach a database to the agent.
 *
 * Exasol is bundled in the driver, so connecting is the whole setup: no MCP
 * server, no Python, no config file to hand-write. The connection is written
 * to the registry shared with Exasol Studio, so a database connected here
 * shows up there and the other way round.
 */

export const ConnectCommand = effectCmd({
  command: "connect [dsn]",
  describe: "connect a database to the agent (exasol://user@host:8563/schema)",
  builder: (yargs) =>
    yargs
      .positional("dsn", { describe: "exasol://user@host:port/schema", type: "string" })
      .option("password", { describe: "password (prompted when omitted)", type: "string" })
      .option("name", { describe: "label for this connection", type: "string" })
      .option("list", { describe: "show connected databases", type: "boolean" })
      .option("forget", { describe: "remove a connection by id", type: "string" }),
  handler: Effect.fn("Cli.connect")(function* (args) {
    if (args.list) {
      const all = yield* Effect.promise(() => listConnections())
      if (all.length === 0) {
        UI.println("no databases connected — run `exa connect` to add one")
        return
      }
      for (const c of all) {
        const tag = c.managed ? " (managed)" : ""
        UI.println(`  ${c.id}  ${c.user}@${c.host}:${c.port}${c.schema ? "/" + c.schema : ""}${tag}`)
      }
      return
    }

    if (args.forget) {
      yield* Effect.promise(() => forgetConnection(args.forget!))
      UI.println(`removed ${args.forget}`)
      return
    }

    let target = args.dsn ? parseDsn(args.dsn) : undefined
    if (args.dsn && !target) return yield* fail(`Not an Exasol DSN: ${args.dsn} (expected exasol://user@host:port/schema)`)

    // No DSN given: reuse what is already running here before offering to
    // install anything, so two programs never deploy competing databases.
    if (!target) {
      const { found, options } = yield* Effect.promise(() => prepareSetup())
      const picked = yield* Effect.promise(() =>
        prompts.select({
          message: "How do you want to connect?",
          options: options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
        }),
      )
      if (prompts.isCancel(picked)) return
      const choice = choiceFromValue(String(picked), found)

      if (choice.kind === "skip") {
        UI.println("skipped — run `exa connect` when you want a database")
        return
      }
      if (choice.kind === "install") {
        const entry = yield* Effect.promise(() => installPersonal((line) => UI.println(line)))
        if (!entry) return yield* fail("Install did not complete. `exa connect` again to retry.")
        UI.println(`connected — saved as ${entry.id} (shared with Exasol Studio)`)
        return
      }
      if (choice.kind === "use") {
        target = { host: choice.candidate.host, port: choice.candidate.port, user: "sys" }
        const user = yield* Effect.promise(() =>
          prompts.text({ message: "User", placeholder: "sys", defaultValue: "sys" }),
        )
        if (prompts.isCancel(user)) return
        target.user = String(user)
      }
    }

    if (!target) {
      const host = yield* Effect.promise(() =>
        prompts.text({ message: "Host", placeholder: "127.0.0.1", defaultValue: "127.0.0.1" }),
      )
      if (prompts.isCancel(host)) return
      const port = yield* Effect.promise(() =>
        prompts.text({ message: "Port", placeholder: "8563", defaultValue: "8563" }),
      )
      if (prompts.isCancel(port)) return
      const user = yield* Effect.promise(() => prompts.text({ message: "User", placeholder: "sys", defaultValue: "sys" }))
      if (prompts.isCancel(user)) return
      target = { host: String(host), port: Number(port) || 8563, user: String(user) }
    }

    let password = args.password
    if (password === undefined) {
      const entered = yield* Effect.promise(() => prompts.password({ message: `Password for ${target!.user}` }))
      if (prompts.isCancel(entered)) return
      password = String(entered)
    }

    const full = { ...target, password }
    UI.println(`connecting to ${full.user}@${full.host}:${full.port}…`)
    const result = yield* Effect.promise(() => probe(full))
    if (!result.ok) return yield* fail(`Could not connect: ${result.error}`)

    const entry = yield* Effect.promise(() => saveConnection(full, { name: args.name, source: "cli" }))
    UI.println(`connected — Exasol ${result.version}`)
    UI.println(`schemas: ${result.schemas.slice(0, 8).join(", ")}${result.schemas.length > 8 ? "…" : ""}`)
    UI.println(`saved as ${entry.id} (shared with Exasol Studio)`)
  }),
})
