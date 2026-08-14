/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeContent from "./skill/customize-exa.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-exa",
            description:
              "Use ONLY when the user is editing or creating exa's own configuration: exa.json, exa.jsonc, files under .exa/, or files under ~/.config/exa/. Also use when creating or fixing exa agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring exa itself.",
            location: AbsolutePath.make("/builtin/customize-exa.md"),
            content: CustomizeOpencodeContent,
          }),
        }),
      )
    })
  }),
})
