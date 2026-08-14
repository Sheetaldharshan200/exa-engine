/**
 * First-run database setup.
 *
 * Three rules this flow follows, learned from tools that get uninstalled:
 *  - Ask once. The answer, including "skip", is remembered; the next run goes
 *    straight to the prompt.
 *  - Never download without a decision. Size and time are stated BEFORE the
 *    170MB starts moving, not after.
 *  - Never block automation. Non-interactive runs (`exa run`, pipes, CI) skip
 *    the wizard entirely.
 */
import { discover, type Candidate } from "./discover"
import { listConnections } from "./connection"
import { connectionId } from "./registry"

export type SetupChoice =
  | { kind: "use"; candidate: Candidate }
  | { kind: "install" }
  | { kind: "manual" }
  | { kind: "skip" }

export type SetupOption = { value: string; label: string; hint?: string }

/**
 * Whether to offer setup at all: only with a connected TTY, and only when no
 * database is connected and the user has not already declined.
 */
export async function shouldOfferSetup(input: {
  interactive: boolean
  declined: boolean
}): Promise<boolean> {
  if (!input.interactive || input.declined) return false
  return (await listConnections()).length === 0
}

/**
 * The choices to present, in the order a user should consider them: reuse
 * what is already running first, install only if nothing is.
 *
 * Deliberately no "connect another database type" entry — exa is the Exasol
 * agent, and other sources are reached through MCP servers by users who
 * already know they want them.
 */
export function setupOptions(found: Candidate[]): SetupOption[] {
  const options: SetupOption[] = found.map((c) => ({
    value: `use:${c.port}`,
    label: `Use ${c.origin}`,
    hint: `${c.host}:${c.port} — already running`,
  }))
  options.push({
    value: "install",
    label: "Install Exasol Personal locally",
    hint: "~170 MB download, a few minutes, nothing to configure",
  })
  options.push({ value: "manual", label: "Connect to an existing Exasol", hint: "host, port, user" })
  options.push({ value: "skip", label: "Skip for now", hint: "run `exa connect` whenever you like" })
  return options
}

export function choiceFromValue(value: string, found: Candidate[]): SetupChoice {
  if (value.startsWith("use:")) {
    const port = Number(value.slice(4))
    const candidate = found.find((c) => c.port === port)
    if (candidate) return { kind: "use", candidate }
  }
  if (value === "install") return { kind: "install" }
  if (value === "manual") return { kind: "manual" }
  return { kind: "skip" }
}

/**
 * Discovered databases MINUS the ones already registered.
 *
 * A database Exasol Studio (or an earlier `exa connect`) already registered is
 * not a choice to make — offering "use the database you are already using"
 * is noise, and picking it would re-ask for credentials that are stored.
 */
export function unregistered(found: Candidate[], registeredIds: string[]): Candidate[] {
  return found.filter((c) => {
    // A registry entry may use any user; match on host and port, which is what
    // identifies the database itself.
    return !registeredIds.some((id) => id.startsWith(`${c.host.toLowerCase()}_${c.port}_`))
  })
}

/** Everything the caller needs to render the prompt. */
export async function prepareSetup(): Promise<{ found: Candidate[]; options: SetupOption[] }> {
  const [discovered, connections] = await Promise.all([discover(), listConnections()])
  const registered = connections.map((c) => connectionId(c.host, c.port, c.user))
  const found = unregistered(discovered, registered)
  return { found, options: setupOptions(found) }
}
