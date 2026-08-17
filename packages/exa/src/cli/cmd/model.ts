import os from "os"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ENGINE_HOST, ENGINE_ID, MODELS, findModel, fitsInMemory, formatSize } from "../../local/catalog"
import { installed, modelPath, running, serve, stop } from "../../local/engine"

/**
 * `exa model` — run a model on this machine, with no other software installed.
 *
 * Ollama is supported when it is there, but it cannot be a requirement: a user
 * who has never heard of it still needs a way to work offline, on private
 * data, or without paying per token. This is that way.
 */
export const ModelCommand = effectCmd({
  command: "model <action> [name]",
  describe: "run models locally (list, pull, run, stop, status)",
  builder: (yargs) =>
    yargs
      .positional("action", {
        describe: "list | pull | run | stop | status",
        type: "string",
        choices: ["list", "pull", "run", "stop", "status"],
      })
      .positional("name", { describe: "model id from `exa model list`", type: "string" }),
  handler: Effect.fn("Cli.model")(function* (args) {
    const action = String(args.action)
    const say = (line: string) => UI.println(line)

    if (action === "status") {
      const live = yield* Effect.promise(() => running())
      const have = yield* Effect.promise(() => installed())
      UI.println(live ? `engine: running on ${ENGINE_HOST}` : "engine: not running")
      UI.println(have.length ? `downloaded: ${have.map((m) => m.id).join(", ")}` : "downloaded: none")
      if (!live && have.length) UI.println(`start one with: exa model run ${have[0]!.id}`)
      return
    }

    if (action === "stop") {
      const stopped = yield* Effect.promise(() => stop())
      UI.println(stopped ? "engine stopped" : "no engine was running")
      return
    }

    if (action === "list") {
      const have = new Set((yield* Effect.promise(() => installed())).map((m) => m.id))
      const totalRam = os.totalmem()
      const live = yield* Effect.promise(() => running())
      for (const model of MODELS) {
        const state = have.has(model.id) ? "downloaded" : `${formatSize(model.sizeMB)} download`
        // Saying this up front beats a 4GB download that then swaps to death.
        const fits = fitsInMemory(model, totalRam) ? "" : `  — needs ${model.minRamGB} GB RAM, this machine has ${Math.round(totalRam / 1024 ** 3)} GB`
        UI.println(`  ${model.id.padEnd(18)} ${model.name}`)
        UI.println(`  ${"".padEnd(18)} ${model.description}`)
        UI.println(`  ${"".padEnd(18)} ${state}${fits}`)
        UI.println("")
      }
      UI.println(live ? `engine running on ${ENGINE_HOST}` : "run one with: exa model run <id>")
      return
    }

    const name = args.name ? String(args.name) : undefined
    if (!name) return yield* fail(`Which model? Run \`exa model list\` to see them.`)
    const model = findModel(name)
    if (!model) {
      return yield* fail(`No model called "${name}". Available: ${MODELS.map((m) => m.id).join(", ")}.`)
    }

    if (!fitsInMemory(model, os.totalmem())) {
      UI.println(
        `warning: ${model.name} wants ${model.minRamGB} GB of RAM and this machine has ` +
          `${Math.round(os.totalmem() / 1024 ** 3)} GB. It may swap heavily or fail to load.`,
      )
    }

    if (action === "pull") {
      const { ensureServer, ensureModel } = yield* Effect.promise(() => import("../../local/engine"))
      yield* Effect.promise(() => ensureServer(say))
      yield* Effect.promise(() => ensureModel(model, say))
      UI.println(`${model.name} is ready at ${modelPath(model)}`)
      UI.println(`start it with: exa model run ${model.id}`)
      return
    }

    // run: download whatever is missing, then serve it. Failures are reported
    // as messages rather than stack traces — "no build for your platform" is
    // something the user can act on.
    const failure = yield* Effect.promise(() =>
      serve(model, say).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    )
    if (failure) return yield* fail(failure)
    UI.println("")
    UI.println(`it will keep running until \`exa model stop\`, and any exa session will see it as ${ENGINE_ID}/…`)
  }),
})
