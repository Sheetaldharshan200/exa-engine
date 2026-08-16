/**
 * Installing Exasol Personal from the CLI.
 *
 * The database is NOT bundled: it is ~170MB with its own lifecycle, and
 * pinning a copy inside every exa release would tie a database upgrade to a
 * CLI upgrade. Instead this fetches the latest official release at the moment
 * the user asks for it — the same rule Exasol Studio follows.
 *
 * Deployment itself is delegated to Exasol's own launcher rather than
 * reimplemented: it already knows how to lay out a deployment, pick ports and
 * report status, and a second implementation would be a second set of bugs.
 */
import path from "path"
import os from "os"
import { probe, saveConnection } from "./connection"
import { deploymentDir, readDeployment } from "./launcher"
import type { ConnectionEntry } from "./registry"

const INSTALL_SCRIPT = "https://www.exasol.com/install/"

type Log = (line: string) => void

async function run(cmd: string[], log: Log): Promise<number> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const stream = async (readable: ReadableStream<Uint8Array> | null) => {
    if (!readable) return
    const reader = readable.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) log(`  ${line.trim()}`)
    }
  }
  await Promise.all([stream(proc.stdout), stream(proc.stderr)])
  return proc.exited
}

function launcherPath(): string {
  return path.join(os.homedir(), ".local", "bin", "exasol")
}

async function haveLauncher(): Promise<boolean> {
  const { existsSync } = await import("node:fs")
  if (existsSync(launcherPath())) return true
  const proc = Bun.spawn(["which", "exasol"], { stdout: "ignore", stderr: "ignore" })
  return (await proc.exited) === 0
}

/**
 * Ensure the launcher exists, deploy a local database, and connect to it.
 * Returns the saved connection, or undefined when the user's platform or a
 * failed step means there is nothing to connect to.
 */
export async function installPersonal(log: Log): Promise<ConnectionEntry | undefined> {
  if (process.platform !== "darwin") {
    log("Exasol Personal Local currently runs on macOS. On Linux and Windows, run Exasol in a container")
    log("and connect with: exa connect exasol://sys@localhost:8563")
    return undefined
  }

  if (!(await haveLauncher())) {
    log("installing the Exasol launcher…")
    const code = await run(["sh", "-c", `curl -fsSL ${INSTALL_SCRIPT} | sh`], log)
    if (code !== 0 || !(await haveLauncher())) {
      log("could not install the Exasol launcher")
      return undefined
    }
  }

  const exasol = (await haveLauncher()) ? launcherPath() : "exasol"
  log("deploying a local Exasol database — this takes a few minutes on first run…")
  const code = await run([exasol, "install", "local"], log)
  if (code !== 0) {
    log("deployment did not complete")
    return undefined
  }

  // The launcher generated a password and wrote it into the deployment, so
  // read it rather than making the user copy it back out of the scrollback.
  log("")
  const credentials = await readDeployment(deploymentDir())
  if (credentials) {
    const entry = await connectLocal(
      credentials.host,
      credentials.port,
      credentials.user,
      credentials.password,
      log,
    )
    if (entry) return entry
    // Deployed but not reachable yet — the port can lag the launcher's exit.
    log("the database is deployed but did not accept a connection yet")
  }

  // Reading the deployment can legitimately fail: a launcher version that
  // writes a different layout, or a deploy that half-finished. Say what to run
  // rather than leaving the user with a database and no way in.
  log("database deployed. Connect it with:")
  log("  exa connect exasol://sys@127.0.0.1:8563")
  log(`(the password is in ${path.join(deploymentDir(), "secrets.json")})`)
  return undefined
}

/** Connect to a database that is already running locally. */
export async function connectLocal(
  host: string,
  port: number,
  user: string,
  password: string,
  log: Log,
): Promise<ConnectionEntry | undefined> {
  const result = await probe({ host, port, user, password })
  if (!result.ok) {
    log(`could not connect: ${result.error}`)
    return undefined
  }
  log(`connected — Exasol ${result.version}`)
  return saveConnection({ host, port, user, password }, { managed: true, source: "cli" })
}
