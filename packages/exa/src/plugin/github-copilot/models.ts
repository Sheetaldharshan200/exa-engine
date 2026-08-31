import type { Model } from "@exa/sdk/v2"
import { Option, Schema } from "effect"

const item = Schema.Struct({
  model_picker_enabled: Schema.Boolean,
  id: Schema.String,
  name: Schema.String,
  // every version looks like: `{model.id}-YYYY-MM-DD`
  version: Schema.String,
  supported_endpoints: Schema.optional(Schema.Array(Schema.String)),
  policy: Schema.optional(
    Schema.Struct({
      state: Schema.optional(Schema.String),
    }),
  ),
  billing: Schema.optional(
    Schema.Struct({
      token_prices: Schema.optional(
        Schema.Struct({
          batch_size: Schema.Number,
          default: Schema.Struct({
            cache_price: Schema.Number,
            input_price: Schema.Number,
            output_price: Schema.Number,
          }),
        }),
      ),
    }),
  ),
  capabilities: Schema.Struct({
    family: Schema.String,
    limits: Schema.optional(
      Schema.Struct({
        max_context_window_tokens: Schema.optional(Schema.Number),
        max_output_tokens: Schema.optional(Schema.Number),
        max_prompt_tokens: Schema.optional(Schema.Number),
        vision: Schema.optional(
          Schema.Struct({
            max_prompt_image_size: Schema.Number,
            max_prompt_images: Schema.Number,
            supported_media_types: Schema.Array(Schema.String),
          }),
        ),
      }),
    ),
    supports: Schema.Struct({
      adaptive_thinking: Schema.optional(Schema.Boolean),
      max_thinking_budget: Schema.optional(Schema.Number),
      min_thinking_budget: Schema.optional(Schema.Number),
      reasoning_effort: Schema.optional(Schema.Array(Schema.String)),
      streaming: Schema.optional(Schema.Boolean),
      structured_outputs: Schema.optional(Schema.Boolean),
      tool_calls: Schema.optional(Schema.Boolean),
      vision: Schema.optional(Schema.Boolean),
    }),
  }),
})

export const schema = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
})

type Item = Schema.Schema.Type<typeof item>
type SelectableItem = Item & {
  capabilities: Item["capabilities"] & {
    limits: NonNullable<Item["capabilities"]["limits"]> & {
      max_output_tokens: number
      max_prompt_tokens: number
    }
    supports: Item["capabilities"]["supports"] & {
      tool_calls: boolean
    }
  }
}
type CopilotEndpoint = "chat" | "responses" | "messages"
type CopilotModel = Omit<Model, "api"> & {
  api: Model["api"] & { endpoint?: CopilotEndpoint }
}
const decodeModels = Schema.decodeUnknownSync(schema)
const decodeItem = Schema.decodeUnknownOption(item)

function build(key: string, remote: SelectableItem, url: string, prev?: Model): Model {
  const reasoning =
    !!remote.capabilities.supports.adaptive_thinking ||
    !!remote.capabilities.supports.reasoning_effort?.length ||
    remote.capabilities.supports.max_thinking_budget !== undefined ||
    remote.capabilities.supports.min_thinking_budget !== undefined
  const image =
    (remote.capabilities.supports.vision ?? false) ||
    (remote.capabilities.limits.vision?.supported_media_types ?? []).some((item) => item.startsWith("image/"))
  const pdf =
    (remote.capabilities.supports.vision ?? false) &&
    (remote.capabilities.limits.vision?.supported_media_types?.includes("application/pdf") ?? false)

  const isMsgApi = remote.supported_endpoints?.includes("/v1/messages")
  const endpoint: CopilotEndpoint | undefined = isMsgApi
    ? "messages"
    : remote.supported_endpoints?.includes("/responses")
      ? "responses"
      : remote.supported_endpoints?.includes("/chat/completions")
        ? "chat"
        : undefined
  const prices = remote.billing?.token_prices
  // Copilot prices are AIC per billing batch; Exa stores USD per million tokens.
  const usdPerMillion = prices && prices.batch_size > 0 ? 10_000 / prices.batch_size : 0

  const model: CopilotModel = {
    id: key,
    providerID: "github-copilot",
    api: {
      id: remote.id,
      url: isMsgApi ? `${url}/v1` : url,
      npm: isMsgApi ? "@ai-sdk/anthropic" : "@ai-sdk/github-copilot",
      ...(endpoint ? { endpoint } : {}),
    },
    // API response wins
    status: "active",
    limit: {
      context: remote.capabilities.limits.max_context_window_tokens ?? remote.capabilities.limits.max_prompt_tokens,
      input: remote.capabilities.limits.max_prompt_tokens,
      output: remote.capabilities.limits.max_output_tokens,
    },
    capabilities: {
      temperature: prev?.capabilities.temperature ?? true,
      reasoning: prev?.capabilities.reasoning ?? reasoning,
      attachment: prev?.capabilities.attachment ?? true,
      toolcall: remote.capabilities.supports.tool_calls,
      input: {
        text: true,
        audio: false,
        image,
        video: false,
        pdf,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    // existing wins
    family: prev?.family ?? remote.capabilities.family,
    name: prev?.name ?? remote.name,
    cost: {
      input: (prices?.default.input_price ?? 0) * usdPerMillion,
      output: (prices?.default.output_price ?? 0) * usdPerMillion,
      cache: {
        read: (prices?.default.cache_price ?? 0) * usdPerMillion,
        // `/models` exposes cached-input reads only; per-request billing accounts for cache writes.
        write: 0,
      },
    },
    options: prev?.options ?? {},
    headers: prev?.headers ?? {},
    release_date:
      prev?.release_date ??
      (remote.version.startsWith(`${remote.id}-`) ? remote.version.slice(remote.id.length + 1) : remote.version),
  }

  const efforts = remote.capabilities.supports.reasoning_effort
  const variants: NonNullable<Model["variants"]> = {}
  if (!isMsgApi && efforts?.length) {
    efforts.forEach((effort) => {
      variants[effort] = {
        reasoningEffort: effort,
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      }
    })
  } else {
    if (efforts?.length && remote.capabilities.supports.adaptive_thinking) {
      efforts.forEach((effort) => {
        variants[effort] = {
          thinking: {
            type: "adaptive",
            ...(model.api.id.includes("opus-4.7") ? { display: "summarized" } : {}),
          },
          effort,
        }
      })
    } else if (remote.capabilities.supports.max_thinking_budget) {
      const max = remote.capabilities.supports.max_thinking_budget
      variants["max"] = {
        thinking: {
          type: "enabled",
          budgetTokens: max - 1,
        },
      }
      variants["high"] = {
        thinking: {
          type: "enabled",
          budgetTokens: Math.floor(max / 2),
        },
      }
    }
  }
  if (Object.keys(variants).length > 0) {
    model.variants = variants
  }

  return model
}

function usable(item: Item): item is SelectableItem {
  return (
    item.policy?.state !== "disabled" &&
    item.capabilities.limits?.max_output_tokens !== undefined &&
    item.capabilities.limits.max_prompt_tokens !== undefined &&
    item.capabilities.supports.tool_calls !== undefined
  )
}

/**
 * A dated snapshot id such as "gpt-4o-2024-11-20" or "gpt-3.5-turbo-0613",
 * as opposed to the stable alias "gpt-4o".
 */
function isDatedSnapshot(id: string): boolean {
  return /-\d{4}(-\d{2}-\d{2})?$/.test(id)
}

/**
 * One entry per display name.
 *
 * GitHub returns the stable alias AND its dated snapshots, all carrying the
 * same name — so "GPT-4o" appeared three times in the picker with nothing to
 * tell the rows apart. Keep the alias, which is the one that keeps working as
 * GitHub moves it forward; if a name only ever appears dated, keep the newest
 * (ids sort by date).
 */
export function oneEntryPerName(ids: Iterable<string>, items: Map<string, { name: string }>): Set<string> {
  const byName = new Map<string, string[]>()
  for (const id of ids) {
    const name = items.get(id)?.name ?? id
    byName.set(name, [...(byName.get(name) ?? []), id])
  }
  const kept = new Set<string>()
  for (const group of byName.values()) {
    const stable = group.filter((id) => !isDatedSnapshot(id))
    kept.add(stable[0] ?? [...group].sort().at(-1)!)
  }
  return kept
}

export async function get(
  baseURL: string,
  headers: HeadersInit = {},
  existing: Record<string, Model> = {},
): Promise<{ models: Record<string, Model>; pickerEnabled: Set<string> }> {
  // 5s was tight enough that an ordinary slow network dropped every Copilot
  // model from the picker, which reads as the provider being broken rather
  // than a request being slow.
  const data = await fetch(`${baseURL}/models`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  }).then(async (res) => {
    if (!res.ok) {
      throw new Error(`GitHub returned HTTP ${res.status} for the model list`)
    }
    return decodeModels(await res.json())
  })

  const result = { ...existing }
  const remote = new Map(
    data.data.flatMap((raw) => {
      const item = Option.getOrUndefined(decodeItem(raw))
      return item && usable(item) ? ([[item.id, item]] as const) : []
    }),
  )

  // prune existing models whose api.id isn't in the endpoint response
  for (const [key, model] of Object.entries(result)) {
    const m = remote.get(model.api.id)
    if (!m) {
      delete result[key]
      continue
    }
    result[key] = build(key, m, baseURL, model)
  }

  // add new endpoint models not already keyed in result
  for (const [id, m] of remote) {
    if (id in result) continue
    result[id] = build(id, m, baseURL)
  }

  const flagged = new Set([...remote].filter(([, item]) => item.model_picker_enabled).map(([id]) => id))

  return {
    models: result,
    // model_picker_enabled is GitHub's hint for its OWN editor picker, and it
    // comes back false for every model on some accounts and OAuth apps.
    // Filtering on it then hides every usable model and the picker reads "No
    // results found" while the API is happily returning eight of them. Treat
    // the flag as a preference: when GitHub singles some models out, respect
    // that; when it singles out none, offer everything it returned.
    pickerEnabled: oneEntryPerName(flagged.size > 0 ? flagged : remote.keys(), remote),
  }
}

export * as CopilotModels from "./models"
