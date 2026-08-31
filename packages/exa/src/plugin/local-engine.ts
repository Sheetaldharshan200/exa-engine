import type { Plugin } from "@exa/plugin"
import { ENGINE_HOST, ENGINE_ID, findModel, formatSize } from "../local/catalog"

/**
 * Start the local engine when a local model is used.
 *
 * The picker lists every model exa can run, including ones not downloaded
 * yet — so choosing one has to do something sensible rather than fail with a
 * connection error to a port nothing is listening on.
 *
 * Two cases, deliberately handled differently:
 *
 *  - Downloaded but not serving: start it. That takes seconds and needs no
 *    decision from the user, so asking would be pure friction.
 *  - Not downloaded: say so, with the command and the size. Pulling several
 *    gigabytes inside a chat turn would stall the conversation for minutes
 *    with no progress and no way to cancel — the download deserves its own
 *    command, where it can report progress and be interrupted.
 */
export const LocalEnginePlugin: Plugin = async () => {
  return {
    async "chat.params"(input) {
      if (input.model.providerID !== ENGINE_ID) return

      const { installed, running, serve } = await import("../local/engine")
      if (await running(ENGINE_HOST)) {
        // Something is serving. llama-server hosts one model at a time, so a
        // different one being loaded is worth saying rather than silently
        // answering from the wrong weights.
        const serving = await fetch(`${ENGINE_HOST}/v1/models`, { signal: AbortSignal.timeout(1_500) })
          .then((r) => (r.ok ? (r.json() as Promise<{ data?: { id: string }[] }>) : undefined))
          .catch(() => undefined)
        const ids = (serving?.data ?? []).map((m) => m.id)
        if (ids.length > 0 && !ids.includes(input.model.id)) {
          throw new Error(
            `The local engine is serving ${ids.join(", ")}, not ${input.model.id}. ` +
              `Switch it with: exa model run ${input.model.id}`,
          )
        }
        return
      }

      const model = findModel(input.model.id)
      if (!model) {
        throw new Error(
          `The local engine is not running. Start it with: exa model run <id> (see \`exa model list\`).`,
        )
      }

      const have = await installed()
      if (!have.some((m) => m.id === model.id)) {
        throw new Error(
          `${model.name} has not been downloaded yet (${formatSize(model.sizeMB)}). ` +
            `Download and start it with: exa model run ${model.id}`,
        )
      }

      // Downloaded and idle — just bring it up.
      await serve(model, () => {})
    },
  }
}
