/**
 * exa's own local model runtime.
 *
 * Ollama cannot be a prerequisite: a user who has not installed it has no way
 * to run anything locally at all. So exa ships the ability to run models
 * itself — llama.cpp's server, fetched on demand, plus a short list of models
 * known to work with an agent.
 *
 * Nothing here is bundled into the exa binary. The server is ~50MB and a model
 * is 2-5GB, which would be absurd to carry for the users who never ask for it,
 * and would tie a llama.cpp update to an exa release. Both are downloaded when
 * the user asks and cached under the data directory.
 *
 * The port matches the one Exasol Studio's built-in engine uses. That is
 * deliberate: on a machine running both, whichever started the server serves
 * the other, instead of two copies of llama.cpp fighting over the GPU.
 */

export const ENGINE_PORT = 41414
export const ENGINE_ID = "builtin"
export const ENGINE_HOST = `http://127.0.0.1:${ENGINE_PORT}`

/** llama.cpp publishes one asset per OS/arch; CPU-safe builds, macOS gets Metal. */
export const RELEASES_LATEST = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"

export type LocalModel = {
  id: string
  name: string
  description: string
  /** The file inside the repo, and the name it is cached under. */
  file: string
  url: string
  sizeMB: number
  /** Refuse to suggest a model the machine cannot hold. */
  minRamGB: number
  /** The window the model was trained for — the most it can usefully hold. */
  contextMax: number
  /**
   * Bytes of KV cache per token, with the cache quantised to q8_0.
   *
   * 2 (keys and values) x layers x kv-heads x head-dim, one byte per element.
   * This is what makes a large window expensive: it is charged per token of
   * context, whether or not the conversation ever fills it.
   */
  kvBytesPerToken: number
}

/**
 * Curated rather than open-ended.
 *
 * Every entry is a GGUF that actually calls tools — a model that cannot is
 * useless to this agent, and the failure is baffling rather than obvious: it
 * answers in prose about querying your database instead of querying it. These
 * are the same three Exasol Studio ships, so a machine with both is not
 * downloading two different sets of weights.
 */
export const MODELS: LocalModel[] = [
  {
    id: "qwen3-4b",
    name: "Qwen3 4B Instruct",
    description: "Best small all-rounder — strong tool calling, fast.",
    file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    sizeMB: 2500,
    minRamGB: 8,
    contextMax: 262_144,
    // 36 layers x 8 kv heads x 128 head dim
    kvBytesPerToken: 2 * 36 * 8 * 128,
  },
  {
    id: "llama-3.2-3b",
    name: "Llama 3.2 3B Instruct",
    description: "Lightest option for smaller machines.",
    file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    sizeMB: 1926,
    minRamGB: 8,
    contextMax: 131_072,
    // 28 layers x 8 kv heads x 128 head dim
    kvBytesPerToken: 2 * 28 * 8 * 128,
  },
  {
    id: "qwen2.5-coder-7b",
    name: "Qwen2.5 Coder 7B",
    description: "Strongest SQL quality — needs more RAM.",
    file: "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
    url: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
    sizeMB: 4467,
    minRamGB: 16,
    contextMax: 32_768,
    // 28 layers x 4 kv heads x 128 head dim — grouped-query attention makes
    // this model's context far cheaper per token than its size suggests.
    kvBytesPerToken: 2 * 28 * 4 * 128,
  },
]

export function findModel(id: string): LocalModel | undefined {
  const needle = id.trim().toLowerCase()
  return (
    MODELS.find((m) => m.id.toLowerCase() === needle) ??
    MODELS.find((m) => m.name.toLowerCase() === needle) ??
    MODELS.find((m) => m.id.toLowerCase().includes(needle))
  )
}

/**
 * The llama.cpp release asset for this machine, or undefined where llama.cpp
 * publishes no build — better to say so than to download something that
 * cannot run.
 */
export function assetFragment(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const key = `${platform}/${arch}`
  switch (key) {
    case "darwin/arm64":
      return "-bin-macos-arm64."
    case "darwin/x64":
      return "-bin-macos-x64."
    case "linux/x64":
      return "-bin-ubuntu-x64."
    case "linux/arm64":
      return "-bin-ubuntu-arm64."
    case "win32/x64":
      return "-bin-win-cpu-x64."
    case "win32/arm64":
      return "-bin-win-cpu-arm64."
    default:
      return undefined
  }
}

/**
 * Pick this machine's asset out of a release's asset list.
 *
 * The fragment is required rather than defaulted: with a default, passing
 * assetFragment() for an unsupported platform (undefined) silently fell back
 * to THIS machine's build, so "we publish nothing for you" became "here is a
 * binary that cannot run".
 */
export function pickAsset(names: string[], fragment: string | undefined): string | undefined {
  if (!fragment) return undefined
  // Windows ships .zip, everything else .tar.gz — match the fragment first so
  // an arm64 machine never picks up the x64 build that also ends in .zip.
  return names.find((n) => n.includes(fragment))
}

/** Whether this machine has the memory the model wants. */
export function fitsInMemory(model: LocalModel, totalBytes: number): boolean {
  return totalBytes / 1024 ** 3 >= model.minRamGB
}

export function formatSize(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}


/**
 * The largest context this machine can actually hold for a model.
 *
 * "Use the maximum" is the right instinct and the wrong instruction: the KV
 * cache is charged per token of window, so Llama 3.2 3B at its full 128k needs
 * about 7GB of cache on top of the 2GB of weights. Asking for it on a laptop
 * either fails to allocate or swaps until the machine is unusable.
 *
 * So: the model's trained window, reduced by halves until the cache fits the
 * budget. Halving rather than trimming keeps the number recognisable — a user
 * reading 65,536 can tell what happened.
 */
export function chooseContext(model: LocalModel, totalRamBytes: number, budgetFraction = 0.35): number {
  const budget = totalRamBytes * budgetFraction - model.sizeMB * 1024 * 1024
  let context = model.contextMax
  // Never go below this: the agent's own system prompt — tool schemas, skills,
  // database context — runs to tens of thousands of tokens, and a window under
  // this cannot hold a conversation at all.
  const floor = 8_192
  while (context > floor && context * model.kvBytesPerToken > budget) {
    context = Math.floor(context / 2)
  }
  return Math.max(floor, context)
}
