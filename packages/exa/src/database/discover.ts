/**
 * Finding databases that already exist on this machine.
 *
 * Before offering to install anything, look for what is already here: an
 * Exasol Personal deployment from the launcher, one Exasol Studio manages, or
 * a starter kit. Two programs must not each deploy their own database and
 * both call it "local" — that wastes 170MB and leaves the user guessing which
 * one their data is in.
 */

export type Candidate = {
  host: string
  port: number
  /** Where we learned about it — shown to the user so the choice is informed. */
  origin: string
  /** Launcher deployment name, when it came from `exasol deployments list`. */
  deployment?: string
  status?: string
}

/**
 * Parse `exasol deployments list` output.
 *
 * Format is `name key=value key=value…`, e.g.
 *   default status=running preset=local/local path=/Users/u/.exasol/…
 */
export function parseDeployments(stdout: string): Candidate[] {
  const out: Candidate[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [name, ...rest] = trimmed.split(/\s+/)
    if (!name || name.toLowerCase() === "name") continue
    const fields: Record<string, string> = {}
    for (const pair of rest) {
      const eq = pair.indexOf("=")
      if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    // Only local presets are reachable on this machine.
    if (fields.preset && !fields.preset.startsWith("local")) continue
    out.push({
      host: "127.0.0.1",
      port: Number(fields.port) || 8563,
      origin: `Exasol Personal deployment "${name}"`,
      deployment: name,
      status: fields.status,
    })
  }
  return out
}

/** Ports worth probing: the launcher default, and Studio's isolated port. */
export const KNOWN_PORTS = [
  { port: 8563, origin: "local Exasol on port 8563" },
  { port: 8565, origin: "Exasol Studio's managed database (port 8565)" },
]

async function portOpen(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer)
      try {
        socket?.end()
      } catch {
        /* already closed */
      }
      resolve(value)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    let socket: import("node:net").Socket | undefined
    import("node:net")
      .then((net) => {
        socket = net.connect({ host: "127.0.0.1", port }, () => done(true))
        socket.on("error", () => done(false))
      })
      .catch(() => done(false))
  })
}

async function launcherDeployments(): Promise<Candidate[]> {
  try {
    const proc = Bun.spawn(["exasol", "deployments", "list"], { stdout: "pipe", stderr: "ignore" })
    if ((await proc.exited) !== 0) return []
    return parseDeployments(await new Response(proc.stdout).text())
  } catch {
    return [] // launcher not installed — nothing to report
  }
}

/**
 * Databases reachable right now, newest information first. Deployment records
 * are preferred over bare port probes because they carry a name and status.
 */
export async function discover(): Promise<Candidate[]> {
  const found = new Map<number, Candidate>()
  for (const candidate of await launcherDeployments()) {
    if (candidate.status && candidate.status !== "running") continue
    if (await portOpen(candidate.port)) found.set(candidate.port, candidate)
  }
  for (const known of KNOWN_PORTS) {
    if (found.has(known.port)) continue
    if (await portOpen(known.port)) {
      found.set(known.port, { host: "127.0.0.1", port: known.port, origin: known.origin })
    }
  }
  return [...found.values()]
}
