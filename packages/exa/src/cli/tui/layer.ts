import { run as runTui, type TuiInput } from "@exa/tui"
import { Global } from "@exa/core/global"
import { AppNodeBuilder } from "@exa/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
