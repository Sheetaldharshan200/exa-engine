import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@exa/core/flag/flag"
import { unsecuredServerWarning } from "../server-warning"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless exa server",
  // Server loads instances per-request via x-exa-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const opts = yield* resolveNetworkOptions(args)
    if (!Flag.EXA_SERVER_PASSWORD) {
      for (const line of unsecuredServerWarning(opts.hostname, "serve")) console.log(line)
    }
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`exa server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
