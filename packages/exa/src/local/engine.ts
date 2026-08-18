/**
 * Getting llama.cpp's server onto the machine and running a model with it.
 *
 * Downloads are resumable-by-restart rather than resumable-by-range: a partial
 * file is written to a `.part` name and only moved into place once complete,
 * so an interrupted 4GB download can never be mistaken for a usable model.
 * That failure is worth designing against — a truncated GGUF fails deep inside
 * the server with an error that says nothing about the download.
 */
import path from "path"
import os from "os"
import { ENGINE_HOST, ENGINE_ID, ENGINE_PORT, MODELS, RELEASES_LATEST, assetFragment, chooseContext, pickAsset, type LocalModel } from "./catalog"

type Log = (line: string) => void

/** Where the server binary and the weights live. */
export function engineDir(): string {
  const base =
    process.env["XDG_DATA_HOME"] ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), ".local", "share")
      : path.join(os.homedir(), ".local", "share"))
  return path.join(base, "exa", "engine")
}

export function modelsDir(): string {
  return path.join(engineDir(), "models")
}

/** Where the archive is extracted. The binary is RUN from here, never moved. */
export function runtimeDir(): string {
  return path.join(engineDir(), "llama")
}

const SERVER_BIN = process.platform === "win32" ? "llama-server.exe" : "llama-server"

export function modelPath(model: LocalModel): string {
  return path.join(modelsDir(), model.file)
}

async function exists(file: string): Promise<boolean> {
  const fs = await import("node:fs/promises")
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

/** Models already downloaded, so the CLI can say what is ready to run. */
export async function installed(): Promise<LocalModel[]> {
  const out: LocalModel[] = []
  for (const model of MODELS) if (await exists(modelPath(model))) out.push(model)
  return out
}

/**
 * Stream a download to disk with progress.
 *
 * Written to `.part` and renamed at the end: a half-written file must never be
 * left somewhere that later looks like a completed download.
 */
async function download(url: string, dest: string, log: Log): Promise<void> {
  const fs = await import("node:fs/promises")
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const part = `${dest}.part`

  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status}) for ${url}`)
  const total = Number(res.headers.get("content-length") ?? 0)

  const file = Bun.file(part).writer()
  let seen = 0
  let lastReport = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    file.write(chunk)
    seen += chunk.byteLength
    // Report by size, not by chunk: a 4GB download is hundreds of thousands of
    // chunks and logging each one is its own denial of service.
    if (total && seen - lastReport > 50 * 1024 * 1024) {
      lastReport = seen
      log(`  ${Math.round((seen / total) * 100)}%  (${(seen / 1024 ** 3).toFixed(1)} of ${(total / 1024 ** 3).toFixed(1)} GB)`)
    }
  }
  await file.end()
  await fs.rename(part, dest)
}

/** Ensure the llama.cpp server binary is present, downloading it if not. */
export async function ensureServer(log: Log): Promise<string> {
  const cached = await locate(runtimeDir(), SERVER_BIN)
  if (cached) return cached

  log("fetching the local model engine (llama.cpp)…")
  const release = (await fetch(RELEASES_LATEST, {
    headers: { Accept: "application/vnd.github+json" },
  }).then((r) => (r.ok ? r.json() : undefined))) as { assets?: { name: string; browser_download_url: string }[] } | undefined

  const assets = release?.assets ?? []
  const name = pickAsset(assets.map((a) => a.name), assetFragment())
  if (!name) {
    throw new Error(
      `llama.cpp publishes no build for ${process.platform}/${process.arch}. ` +
        "Install Ollama instead, or point exa at any OpenAI-compatible server.",
    )
  }
  const asset = assets.find((a) => a.name === name)!

  const fs = await import("node:fs/promises")
  const dir = runtimeDir()
  await fs.mkdir(dir, { recursive: true })
  const archive = path.join(dir, name)
  await download(asset.browser_download_url, archive, log)

  log("unpacking…")
  const unpack = name.endsWith(".zip") ? ["unzip", "-oq", archive, "-d", dir] : ["tar", "-xzf", archive, "-C", dir]
  const proc = Bun.spawn(unpack, { stdout: "ignore", stderr: "ignore" })
  if ((await proc.exited) !== 0) throw new Error(`could not unpack ${name}`)
  await fs.rm(archive, { force: true }).catch(() => undefined)

  // The archive layout moves between releases, so find the binary rather than
  // assuming where it landed.
  const found = await locate(dir, SERVER_BIN)
  if (!found) throw new Error("the llama.cpp archive contained no llama-server binary")

  // Run it where it was extracted. The macOS build resolves its own shared
  // libraries through @rpath relative to the binary, so copying just the
  // executable elsewhere produces "Library not loaded: libllama-server-impl"
  // the first time it is started.
  await Promise.all(
    (await fs.readdir(path.dirname(found)).catch(() => [] as string[])).map((entry) =>
      fs.chmod(path.join(path.dirname(found), entry), 0o755).catch(() => undefined),
    ),
  )
  log("engine ready")
  return found
}

async function locate(dir: string, target: string): Promise<string | undefined> {
  const fs = await import("node:fs/promises")
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await locate(full, target)
      if (nested) return nested
    } else if (entry.name === target) return full
  }
  return undefined
}

/** Ensure the weights are present, downloading them if not. */
export async function ensureModel(model: LocalModel, log: Log): Promise<string> {
  const dest = modelPath(model)
  if (await exists(dest)) return dest
  log(`downloading ${model.name} (${(model.sizeMB / 1024).toFixed(1)} GB) — this runs once`)
  await download(model.url, dest, log)
  return dest
}

/**
 * The lsof invocation that finds the SERVER on a port.
 *
 * -sTCP:LISTEN matters far more than it looks. Without it lsof reports every
 * process holding a socket on the port — the listener AND everything connected
 * to it. exa itself is one of those the moment it detects the engine, so
 * restarting a model sent kill -9 to the user's own session: "zsh: killed exa",
 * with the terminal left in mouse-tracking mode.
 */
export function listenerLookup(port: number): string[] {
  return ["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]
}

/** The pids to signal — never our own, whatever lsof reported. */
export function killable(lsofOutput: string, self: number): string[] {
  return lsofOutput
    .split(/\s+/)
    .filter(Boolean)
    .filter((pid) => pid !== String(self))
}

/** True when something is already serving the engine port. */
export async function running(host = ENGINE_HOST): Promise<boolean> {
  try {
    const res = await fetch(`${host}/v1/models`, { signal: AbortSignal.timeout(1_500) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Start the server detached, so it outlives the command that started it.
 *
 * A CLI that stopped the model when the command returned would make the whole
 * feature useless: the next `exa` run would have to load several gigabytes
 * again. It keeps running until `exa model stop`.
 */
export async function serve(model: LocalModel, log: Log): Promise<void> {
  const bin = await ensureServer(log)
  const weights = await ensureModel(model, log)

  if (await running()) {
    log("an engine is already serving this port — stopping it first")
    await stop()
    // The old process does not release the port the instant it is killed, and
    // the replacement then fails to bind and exits silently — the command
    // reports success while nothing is serving. Wait for the port to be free.
    for (let i = 0; i < 20 && (await running()); i++) {
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  const context = chooseContext(model, os.totalmem())
  log(
    context < model.contextMax
      ? `starting ${model.name} with a ${context.toLocaleString()} token window ` +
          `(its maximum is ${model.contextMax.toLocaleString()}; the rest would not fit in memory)…`
      : `starting ${model.name} with its full ${context.toLocaleString()} token window…`,
  )
  const proc = Bun.spawn(
    [
      bin,
      "-m",
      weights,
      "--host",
      "127.0.0.1",
      "--port",
      String(ENGINE_PORT),
      // OpenAI-style tool calling. Without it the agent has no tools at all,
      // which is the difference between a data agent and a chat box.
      "--jinja",
      // Full GPU offload where there is one; ignored by CPU-only builds.
      "-ngl",
      "99",
      // One conversation gets the whole window. llama-server defaults to four
      // parallel slots and divides the context between them, so a 32k
      // allocation quietly became 8k per conversation — less than this agent's
      // own system prompt.
      "--parallel",
      "1",
      // The largest window this machine can hold for this model, rather than
      // a fixed number that is too small on a workstation and too large on a
      // laptop.
      "-c",
      String(context),
      // Quantising the KV cache halves what the window costs, which is what
      // makes the larger windows reachable at all. The quality cost at q8_0 is
      // negligible next to running out of memory.
      "--cache-type-k",
      "q8_0",
      "--cache-type-v",
      "q8_0",
      // The alias becomes the model id the user types after `builtin/`, so it
      // must be the catalogue id — the display name has spaces and would need
      // quoting on every command.
      "--alias",
      model.id,
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  )
  proc.unref()

  // Loading several GB off disk takes a while; report readiness rather than
  // returning to a prompt that does not work yet.
  for (let i = 0; i < 60; i++) {
    if (await running()) {
      log(`ready — ${model.name} is serving on ${ENGINE_HOST}`)
      log(`use it with: exa --model ${ENGINE_ID}/${model.id}`)
      return
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error("the engine started but did not begin serving within 60s")
}

/** Stop whatever holds the engine port. */
export async function stop(): Promise<boolean> {
  if (process.platform === "win32") {
    const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", `Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force`], {
      stdout: "ignore",
      stderr: "ignore",
    })
    return (await proc.exited) === 0
  }
  const find = Bun.spawn(listenerLookup(ENGINE_PORT), { stdout: "pipe", stderr: "ignore" })
  const pids = killable(await new Response(find.stdout).text(), process.pid)
  if (pids.length === 0) return false
  for (const pid of pids) {
    const kill = Bun.spawn(["kill", "-9", pid], { stdout: "ignore", stderr: "ignore" })
    await kill.exited
  }
  return true
}
