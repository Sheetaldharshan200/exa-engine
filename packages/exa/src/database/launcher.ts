/**
 * Reading credentials out of an Exasol Personal deployment.
 *
 * `exasol install local` generates a password and writes it, with the rest of
 * the connection details, into the deployment directory. Asking the user to
 * copy that password back out of the terminal is busywork on top of an install
 * that already knows the answer — so read it.
 *
 * Two files, both written by the launcher:
 *   deployment.json  → connection.{host,dbPort,username} and deploymentState
 *   secrets.json     → dbPassword
 *
 * Exasol Studio reads exactly these keys from its own deployment
 * (`local_runtime.rs::read_personal_connection`), including the same fallbacks.
 * The two implementations must agree, or a database installed by one program
 * is unusable by the other — the failure this whole shared setup exists to
 * prevent. The tests below pin the contract from this side.
 *
 * Studio keeps its deployment inside its app data and never touches the shared
 * default directory; the CLI owns that one. Reading is always safe from either
 * side, which is what makes "install in one, use in both" work.
 */
import path from "path"
import os from "os"

export type LauncherConnection = {
  host: string
  port: number
  user: string
  password: string
  /** The launcher's own word for the deployment state, e.g. "running". */
  state?: string
}

/** Where the launcher keeps deployments. Overridable so tests touch no HOME. */
export function deploymentsDir(): string {
  return process.env["EXASOL_DEPLOYMENTS_DIR"] || path.join(os.homedir(), ".exasol", "personal", "deployments")
}

export function deploymentDir(name = "default"): string {
  return path.join(deploymentsDir(), name)
}

/**
 * Studio's own deployment, which lives in its app data rather than the shared
 * launcher directory (`local_runtime.rs::runtime_dir` + "deployment").
 *
 * Read so that a database Studio installed is usable from the CLI straight
 * away. Normally Studio publishes it to the shared registry and the credential
 * store, and that is the path this relies on — but not before Studio has run
 * at least once, and a user who installs through Studio and then opens the CLI
 * should not be asked for a password that already exists on the disk.
 *
 * Read-only, same user, same machine. The CLI never starts, stops, or deletes
 * that deployment; Studio owns its lifecycle, exactly as Studio never operates
 * on the shared one.
 */
export function studioDeploymentDir(platform: string = process.platform, home: string = os.homedir()): string {
  const id = "com.exasol.studio"
  const base =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", id)
      : platform === "win32"
        ? path.join(process.env["APPDATA"] || path.join(home, "AppData", "Roaming"), id)
        : path.join(process.env["XDG_DATA_HOME"] || path.join(home, ".local", "share"), id)
  return path.join(base, "personal-local", "deployment")
}

/**
 * Pull a connection out of the two files' contents.
 *
 * Pure, so the contract with the launcher's format is testable without a
 * deployment. Returns undefined rather than a half-filled connection: a
 * password is the one field with no sensible default, and inventing one turns
 * a clear "not installed yet" into a confusing authentication failure.
 */
export function parseDeployment(deploymentJson: unknown, secretsJson: unknown): LauncherConnection | undefined {
  const deployment = (deploymentJson ?? {}) as Record<string, unknown>
  const secrets = (secretsJson ?? {}) as Record<string, unknown>
  const connection = (deployment["connection"] ?? {}) as Record<string, unknown>

  const password = secrets["dbPassword"]
  if (typeof password !== "string" || password === "") return undefined

  const port = Number(connection["dbPort"])
  return {
    host: typeof connection["host"] === "string" && connection["host"] ? connection["host"] : "127.0.0.1",
    port: Number.isFinite(port) && port > 0 ? port : 8563,
    user: typeof connection["username"] === "string" && connection["username"] ? connection["username"] : "sys",
    password,
    state: typeof deployment["deploymentState"] === "string" ? deployment["deploymentState"] : undefined,
  }
}

async function readJson(file: string): Promise<unknown> {
  const fs = await import("node:fs/promises")
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined // half-written during a deploy; the caller falls back
  }
}

/** The connection for one deployment directory, if the launcher wrote one. */
export async function readDeployment(dir: string): Promise<LauncherConnection | undefined> {
  const [deployment, secrets] = await Promise.all([
    readJson(path.join(dir, "deployment.json")),
    readJson(path.join(dir, "secrets.json")),
  ])
  if (deployment === undefined) return undefined
  return parseDeployment(deployment, secrets)
}

/**
 * Every deployment on this machine: the launcher's, then Studio's.
 *
 * Launcher deployments come first so that when both programs happen to have
 * one on the same port, the one this CLI installed wins.
 */
export async function listDeployments(): Promise<{ name: string; connection: LauncherConnection }[]> {
  const fs = await import("node:fs/promises")
  const names = await fs.readdir(deploymentsDir()).catch(() => [] as string[])
  const out: { name: string; connection: LauncherConnection }[] = []
  for (const name of names) {
    const connection = await readDeployment(path.join(deploymentsDir(), name))
    if (connection) out.push({ name, connection })
  }
  const studio = await readDeployment(studioDeploymentDir())
  if (studio) out.push({ name: "exasol-studio", connection: studio })
  return out
}

/**
 * The launcher credentials for a database reachable at this host and port, if
 * the launcher is the one that deployed it.
 *
 * Matching on host and port rather than deployment name is what lets a
 * database discovered by a bare port probe still connect without a prompt.
 */
export async function credentialsFor(host: string, port: number): Promise<LauncherConnection | undefined> {
  const local = new Set(["127.0.0.1", "localhost", "::1"])
  const wanted = host.toLowerCase()
  for (const { connection } of await listDeployments()) {
    if (connection.port !== port) continue
    const found = connection.host.toLowerCase()
    if (found === wanted || (local.has(found) && local.has(wanted))) return connection
  }
  return undefined
}
