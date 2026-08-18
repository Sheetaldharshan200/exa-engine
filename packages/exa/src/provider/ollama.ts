/**
 * Ollama running on this machine.
 *
 * The models.dev catalogue only knows "ollama-cloud", the hosted service that
 * wants an API key. A local Ollama needs no key at all — it is either
 * listening on 127.0.0.1:11434 or it is not — so it cannot be expressed as a
 * catalogue entry and had no way to appear at all.
 *
 * Detection rather than configuration: the models a user has pulled change
 * whenever they run `ollama pull`, so the list is read from the server each
 * time instead of being written down somewhere that goes stale. Ollama serves
 * an OpenAI-compatible API at /v1, which is what the model actually talks to;
 * its native /api endpoints are used only to enumerate models and ask what
 * each one supports.
 */
import { ModelV2 } from "@exa/core/model"
import { ProviderV2 } from "@exa/core/provider"
import type { Model } from "./provider"

export const OLLAMA_HOST = "http://127.0.0.1:11434"
export const OLLAMA_ID = "ollama"

/** What `GET /api/tags` reports about an installed model. */
export type OllamaTag = { model?: string; name?: string; details?: { parameter_size?: string } }

/** What `POST /api/show` reports about one model's abilities. */
export type OllamaShow = {
  capabilities?: string[]
  model_info?: Record<string, unknown>
}

export type OllamaModel = {
  id: string
  /** Tool calling — without it the agent cannot use any of its tools. */
  toolcall: boolean
  vision: boolean
  /** The model's real context window, when the server reports one. */
  context?: number
}

/** Model ids from `/api/tags`, in the form the OpenAI-compatible API expects. */
export function parseTags(body: unknown): string[] {
  const models = (body as { models?: OllamaTag[] })?.models
  if (!Array.isArray(models)) return []
  return models.map((m) => m.model ?? m.name ?? "").filter((id): id is string => Boolean(id))
}

/**
 * Read one model's capabilities.
 *
 * Ollama states these per model, so a user who pulled a vision model and a
 * tool-calling model gets each described correctly rather than both being
 * assumed identical. The context length is reported under a key named after
 * the architecture (`llama.context_length`, `qwen3.context_length`, …), so it
 * is found by suffix rather than by guessing the architecture.
 */
export function parseShow(id: string, body: unknown): OllamaModel {
  const show = (body ?? {}) as OllamaShow
  const caps = Array.isArray(show.capabilities) ? show.capabilities : []
  const info = show.model_info ?? {}
  const contextEntry = Object.entries(info).find(([key]) => key.endsWith(".context_length"))
  const context = typeof contextEntry?.[1] === "number" ? contextEntry[1] : undefined
  return {
    id,
    toolcall: caps.includes("tools"),
    vision: caps.includes("vision"),
    context,
  }
}

/** A model entry in the shape the provider registry expects. */
export function toModel(model: OllamaModel): Model {
  return {
    id: ModelV2.ID.make(model.id),
    providerID: ProviderV2.ID.make(OLLAMA_ID),
    api: { id: model.id, url: `${OLLAMA_HOST}/v1`, npm: "@ai-sdk/openai-compatible" },
    name: model.id,
    family: "",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: model.vision,
      toolcall: model.toolcall,
      input: { text: true, audio: false, image: model.vision, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    // It runs on the user's own machine. Reporting anything but zero would put
    // invented numbers in the cost display.
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: model.context ?? 8_192, output: 4_096 },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
    variants: {},
  }
}

async function json(url: string, init?: RequestInit, timeoutMs = 2_000): Promise<unknown | undefined> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return undefined
    return await res.json()
  } catch {
    return undefined // not running, or too slow to be worth waiting for
  }
}

/**
 * The models a local Ollama is serving, or undefined when it is not running.
 *
 * undefined and [] mean different things and both matter: not running means
 * the provider should not appear at all, while running with nothing pulled
 * means it should appear and say so — otherwise `ollama pull` looks like it
 * had no effect.
 */
export async function detect(host = OLLAMA_HOST): Promise<OllamaModel[] | undefined> {
  const tags = await json(`${host}/api/tags`)
  if (tags === undefined) return undefined
  const ids = parseTags(tags)
  return Promise.all(
    ids.map(async (id) => {
      const show = await json(`${host}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: id }),
      })
      return parseShow(id, show)
    }),
  )
}

// ── exa's own engine ────────────────────────────────────────────────────────

/**
 * The built-in engine, detected exactly like Ollama.
 *
 * It speaks the OpenAI API, so listing its models is one call to /v1/models.
 * Everything it serves is tool-capable by construction: the catalogue only
 * contains such models and the server is started with --jinja.
 */
export async function detectBuiltin(host: string): Promise<OllamaModel[] | undefined> {
  const body = await json(`${host}/v1/models`, undefined, 1_500)
  if (body === undefined) return undefined
  const data = (body as { data?: { id: string }[] })?.data
  if (!Array.isArray(data)) return []

  // Ask the server what it allocated rather than assuming. The window depends
  // on the model and the machine, so a fixed number here would promise more
  // than the server can hold on a small machine and less than it offers on a
  // large one — and the agent sizes its requests from this figure.
  const props = (await json(`${host}/props`, undefined, 1_500)) as
    | { default_generation_settings?: { n_ctx?: number } }
    | undefined
  const allocated = props?.default_generation_settings?.n_ctx

  return data
    .map((m) => m.id)
    .filter(Boolean)
    .map((id) => ({ id, toolcall: true, vision: false, context: allocated }))
}

/**
 * Every model exa can run, whether or not it has been downloaded yet.
 *
 * The picker should list these the way it lists any other provider's models —
 * a model you have not downloaded is still a model you can choose. Listing
 * only what is already serving meant the feature was invisible until you had
 * already used it, which is the wrong way round.
 */
export function builtinCatalogModels(
  catalog: { id: string; name: string }[],
  host: string,
  providerID: string,
): Record<string, Model> {
  return Object.fromEntries(
    catalog.map((entry) => [
      entry.id,
      toBuiltinModel({ id: entry.id, toolcall: true, vision: false }, host, providerID),
    ]),
  )
}

/** A built-in engine model in the shape the provider registry expects. */
export function toBuiltinModel(model: OllamaModel, host: string, providerID: string): Model {
  const base = toModel(model)
  return {
    ...base,
    providerID: ProviderV2.ID.make(providerID),
    api: { id: model.id, url: `${host}/v1`, npm: "@ai-sdk/openai-compatible" },
    // The server is started with a 32k window; anything larger would be
    // promised and then refused mid-conversation.
    limit: { context: model.context ?? 32_768, output: 4_096 },
  }
}
