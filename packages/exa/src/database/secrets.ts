/**
 * Where connection passwords live.
 *
 * The shared registry deliberately holds no secrets. Secrets go to the
 * operating system's credential store — Keychain on macOS, the Secret Service
 * on Linux, Credential Manager on Windows — under one service name both `exa`
 * and Exasol Studio use, so either program can read a connection the other
 * saved without either of them keeping a plaintext copy.
 *
 * Why this rather than a 0600 file: a file is readable by anything running as
 * the user (a stray script, a backup tool, a synced folder), it lands in disk
 * images and snapshots, and it means "shared with the CLI" would have to mean
 * "written to disk in the clear" — which is not a trade worth making for a
 * production database credential. With the OS store, sharing a remote
 * connection is safe, so there is no local/remote split at all.
 *
 * The file fallback still exists for environments with no credential store
 * (a headless Linux box without a Secret Service, a container). It is used
 * only when the OS store is unavailable, and callers can tell which happened.
 */
import path from "path"
import { credentialFile } from "./registry"

export const SERVICE = "exa"

export type Backend = "keychain" | "secret-service" | "wincred" | "file"

/** The credential store this platform offers, before checking it works. */
export function preferredBackend(platform: string = process.platform): Backend {
  if (platform === "darwin") return "keychain"
  if (platform === "win32") return "wincred"
  if (platform === "linux") return "secret-service"
  return "file"
}

/** The command that reads a secret, or undefined for the file backend. */
export function readCommand(backend: Backend, id: string): string[] | undefined {
  switch (backend) {
    case "keychain":
      return ["security", "find-generic-password", "-a", id, "-s", SERVICE, "-w"]
    case "secret-service":
      return ["secret-tool", "lookup", "service", SERVICE, "account", id]
    case "wincred":
      return [
        "powershell",
        "-NoProfile",
        "-Command",
        `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];` +
          `(New-Object Windows.Security.Credentials.PasswordVault).Retrieve('${SERVICE}','${id}').Password`,
      ]
    default:
      return undefined
  }
}

/** The command that stores a secret, or undefined for the file backend. */
export function writeCommand(backend: Backend, id: string, secret: string): string[] | undefined {
  switch (backend) {
    case "keychain":
      // -U updates in place rather than failing when the item exists.
      return ["security", "add-generic-password", "-a", id, "-s", SERVICE, "-w", secret, "-U"]
    case "secret-service":
      return ["secret-tool", "store", "--label", `exa ${id}`, "service", SERVICE, "account", id]
    case "wincred":
      return [
        "powershell",
        "-NoProfile",
        "-Command",
        `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];` +
          `$v=New-Object Windows.Security.Credentials.PasswordVault;` +
          `$v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}','${id}','${secret}')))`,
      ]
    default:
      return undefined
  }
}

export function deleteCommand(backend: Backend, id: string): string[] | undefined {
  switch (backend) {
    case "keychain":
      return ["security", "delete-generic-password", "-a", id, "-s", SERVICE]
    case "secret-service":
      return ["secret-tool", "clear", "service", SERVICE, "account", id]
    case "wincred":
      return [
        "powershell",
        "-NoProfile",
        "-Command",
        `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];` +
          `$v=New-Object Windows.Security.Credentials.PasswordVault;` +
          `$v.Remove($v.Retrieve('${SERVICE}','${id}'))`,
      ]
    default:
      return undefined
  }
}

/**
 * `spawned` separates "the tool is not installed" from "the tool ran and said
 * no" — the difference between falling back to a file and correctly reporting
 * that a secret simply is not stored.
 */
async function run(cmd: string[], stdin?: string): Promise<{ spawned: boolean; ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "ignore",
    })
    const out = await new Response(proc.stdout).text()
    return { spawned: true, ok: (await proc.exited) === 0, out }
  } catch {
    return { spawned: false, ok: false, out: "" }
  }
}

let cached: Backend | undefined

/**
 * The backend actually in use: the platform's store when it works, otherwise
 * the file. Probed once — the answer cannot change during a run, and probing
 * per call would add a process spawn to every database connection.
 */
export async function backend(): Promise<Backend> {
  if (cached) return cached
  const preferred = preferredBackend()
  if (preferred === "file") return (cached = "file")
  // Read a name that cannot exist: if the tool RUNS at all — even to say "not
  // found" — the store is usable. Only a failure to launch it means this
  // machine has no credential store. (`command -v` cannot be used here: it is
  // a shell builtin, not an executable, so spawning it always fails.)
  const { spawned } = await run(readCommand(preferred, "__exa_probe__")!)
  return (cached = spawned ? preferred : "file")
}

export async function readSecret(id: string): Promise<string | undefined> {
  const which = await backend()
  const cmd = readCommand(which, id)
  if (cmd) {
    const { ok, out } = await run(cmd)
    if (ok && out.trim()) return out.replace(/\n$/, "")
    // Fall through: a secret written before the store was available may still
    // be sitting in the file.
  }
  const fs = await import("node:fs/promises")
  const text = await fs.readFile(credentialFile(id), "utf8").catch(() => undefined)
  return text?.trim() || undefined
}

export async function writeSecret(id: string, secret: string): Promise<Backend> {
  const which = await backend()
  const cmd = writeCommand(which, id, secret)
  if (cmd) {
    const { ok } = await run(cmd, which === "secret-service" ? secret : undefined)
    if (ok) {
      // Remove any older plaintext copy so a secret is never in two places.
      const fs = await import("node:fs/promises")
      await fs.rm(credentialFile(id), { force: true }).catch(() => undefined)
      return which
    }
  }
  const fs = await import("node:fs/promises")
  const file = credentialFile(id)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, secret, { mode: 0o600 })
  await fs.chmod(file, 0o600).catch(() => undefined)
  return "file"
}

export async function deleteSecret(id: string): Promise<void> {
  const which = await backend()
  const cmd = deleteCommand(which, id)
  if (cmd) await run(cmd)
  const fs = await import("node:fs/promises")
  await fs.rm(credentialFile(id), { force: true }).catch(() => undefined)
}

/** Reset the probed backend — tests only. */
export function resetBackendCache(): void {
  cached = undefined
}
