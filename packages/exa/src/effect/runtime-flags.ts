import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("EXA_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@exa/RuntimeFlags", {
  autoShare: bool("EXA_AUTO_SHARE"),
  pure: bool("EXA_PURE"),
  disableDefaultPlugins: bool("EXA_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("EXA_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("EXA_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("EXA_DISABLE_LSP_DOWNLOAD"),
  // Reading another product's configuration is opt-in, not the default.
  //
  // Upstream loaded ~/.claude/CLAUDE.md as agent instructions and ~/.claude
  // /skills as skills, for compatibility with the tool it lived alongside.
  // Inherited unchanged, that means exa silently ingests a different
  // product's config and skills — the user's Claude Code instructions became
  // exa's instructions, which is how a session about an Exasol database
  // started describing "the agentic database behind Claude".
  //
  // Anyone who wants that back sets EXA_CLAUDE_CODE_COMPAT=1. The old
  // EXA_DISABLE_CLAUDE_CODE* variables still force it off, so a script that
  // set them keeps working.
  claudeCodePrompt: Config.all({
    compat: bool("EXA_CLAUDE_CODE_COMPAT"),
    broad: bool("EXA_DISABLE_CLAUDE_CODE"),
    direct: bool("EXA_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.compat && !flags.broad && !flags.direct)),
  claudeCodeSkills: Config.all({
    compat: bool("EXA_CLAUDE_CODE_COMPAT"),
    broad: bool("EXA_DISABLE_CLAUDE_CODE"),
    direct: bool("EXA_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.compat && !flags.broad && !flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("EXA_ENABLE_EXA"),
    legacy: bool("EXA_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("EXA_ENABLE_PARALLEL"),
    legacy: bool("EXA_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("EXA_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("EXA_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("EXA_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("EXA_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("EXA_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("EXA_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("EXA_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("EXA_EXPERIMENTAL_PLAN_MODE"),
  experimentalCodeMode: enabledByExperimental("EXA_EXPERIMENTAL_CODE_MODE"),
  experimentalEventSystem: enabledByExperimental("EXA_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("EXA_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("EXA_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("EXA_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("EXA_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("EXA_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("EXA_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("EXA_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: Service.layer.pipe(Layer.orDie), deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@exa/core/effect/layer-node"
