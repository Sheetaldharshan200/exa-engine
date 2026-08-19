import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import open from "open"

/**
 * Serve the embedded documentation site and open it.
 *
 * The docs ship inside the binary (packages/web, built statically at release
 * time), so they match the installed version exactly and work offline. The
 * same pages are available on any running `exa web` server under /docs.
 */
export const DocsCommand = effectCmd({
  command: "docs",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "open the exa documentation in your browser",
  instance: false,
  handler: Effect.fn("Cli.docs")(function* (args) {
    const { embeddedDocs } = yield* Effect.promise(() => import("../../server/shared/ui"))
    const bundled = yield* Effect.promise(() => embeddedDocs())
    if (!bundled) {
      UI.error("This build has no embedded documentation — read it at https://github.com/Sheetaldharshan200/exa-engine/tree/main/packages/web/src/content/docs")
      return
    }

    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    const url = `http://${opts.hostname === "0.0.0.0" ? "localhost" : opts.hostname}:${server.port}/docs`

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Documentation:    ", UI.Style.TEXT_NORMAL, url)
    open(url).catch(() => {})

    yield* Effect.never
  }),
})
