import { createSignal, onMount } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"

/**
 * exa in-session controls (fork-only file): /sandbox, /ops and /persona give
 * the TUI the same switches the Exasol Studio chat panel has. Each edits the
 * exa agent's config through the engine (PATCH /config — writes the file AND
 * invalidates the config cache) and then disposes the instance so rebuilt
 * agents pick the change up live, from the next message.
 */

type ExaAgentConfig = {
  permission?: Record<string, unknown>
  options?: { sqlOps?: string[]; persona?: string; tools?: string[] } & Record<string, unknown>
}

async function readExaAgent(sdk: ReturnType<typeof useSDK>): Promise<ExaAgentConfig> {
  const response = await sdk.client.config.get(undefined, { throwOnError: true })
  const agents = (response.data as { agent?: Record<string, ExaAgentConfig> } | undefined)?.agent
  return agents?.["exa"] ?? {}
}

async function patchExaAgent(sdk: ReturnType<typeof useSDK>, patch: ExaAgentConfig): Promise<void> {
  // GLOBAL config update (PATCH /global/config): writes the user's config
  // file AND invalidates the engine's config cache — the instance-level
  // PATCH /config writes a project config.json without invalidating.
  await sdk.client.global.config.update({ config: { agent: { exa: patch } } as never }, { throwOnError: true })
  // Dispose rebuilds the instance (and its agents) so the change applies to
  // the NEXT message, not the next run.
  await sdk.client.instance.dispose()
}

const APPLY_NOTE = "applies from your next message"

export function DialogExaSandbox() {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [current, setCurrent] = createSignal<"on" | "off">("off")
  onMount(async () => {
    const agent = await readExaAgent(sdk).catch(() => ({}) as ExaAgentConfig)
    setCurrent(agent.permission?.webfetch === "allow" ? "on" : "off")
  })
  return (
    <DialogSelect
      title="Internet access (sandbox)"
      options={[
        { title: "OFF — sandboxed (web tools denied)", value: "off" },
        { title: "ON — web tools allowed", value: "on" },
      ]}
      current={current()}
      onSelect={async (opt) => {
        dialog.clear()
        const action = opt.value === "on" ? "allow" : "deny"
        try {
          await patchExaAgent(sdk, { permission: { webfetch: action, websearch: action } })
          toast.show({
            message: `Internet access ${opt.value === "on" ? "ON" : "OFF (sandboxed)"} — ${APPLY_NOTE}.`,
            variant: "success",
          })
        } catch {
          toast.show({ message: "Could not update the sandbox setting.", variant: "error" })
        }
      }}
    />
  )
}

const PERSONAS = [
  { key: "", label: "Adaptive — match each question" },
  { key: "data-analyst", label: "Data Analyst — tables and SQL" },
  { key: "bi-analyst", label: "BI Analyst — KPIs and comparisons" },
  { key: "data-scientist", label: "Data Scientist — models and metrics" },
  { key: "finance-analyst", label: "Finance Analyst — fiscal periods, margins" },
  { key: "data-engineer", label: "Data Engineer — pipelines and schemas" },
  { key: "dba", label: "DBA — administration and sessions" },
  { key: "executive", label: "Executive — headline first" },
]

export function DialogExaPersona() {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [current, setCurrent] = createSignal("")
  onMount(async () => {
    const agent = await readExaAgent(sdk).catch(() => ({}) as ExaAgentConfig)
    setCurrent(typeof agent.options?.persona === "string" ? agent.options.persona : "")
  })
  return (
    <DialogSelect
      title="Answers written for"
      options={PERSONAS.map((p) => ({ title: p.label, value: p.key }))}
      current={current()}
      onSelect={async (opt) => {
        dialog.clear()
        try {
          await patchExaAgent(sdk, { options: { persona: opt.value } })
          toast.show({
            message: `Persona: ${opt.value || "adaptive"} — ${APPLY_NOTE}.`,
            variant: "success",
          })
        } catch {
          toast.show({ message: "Could not update the persona.", variant: "error" })
        }
      }}
    />
  )
}

const SQL_OPS: { key: string; label: string }[] = [
  { key: "insert", label: "INSERT — INSERT/IMPORT/MERGE-insert" },
  { key: "update", label: "UPDATE — UPDATE/MERGE-update" },
  { key: "delete", label: "DELETE — DELETE/TRUNCATE" },
  { key: "create", label: "CREATE — schema/table/view/function" },
  { key: "alter", label: "ALTER — ALTER/RENAME/COMMENT" },
  { key: "drop", label: "DROP" },
  { key: "dcl", label: "ACCESS — GRANT/REVOKE/users/roles" },
  { key: "admin", label: "ADMIN — ALTER SYSTEM/SESSION/KILL" },
]

export function DialogExaOps() {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [granted, setGranted] = createSignal<Set<string>>(new Set())
  onMount(async () => {
    const agent = await readExaAgent(sdk).catch(() => ({}) as ExaAgentConfig)
    const ops = Array.isArray(agent.options?.sqlOps) ? agent.options.sqlOps : []
    setGranted(new Set(ops.filter((o): o is string => typeof o === "string")))
  })
  const options = () => [
    ...SQL_OPS.map((op) => ({
      title: `${granted().has(op.key) ? "[x]" : "[ ]"} ${op.label}`,
      value: op.key,
    })),
    { title: "Done — save grants", value: "__done" },
  ]
  return (
    <DialogSelect
      title="SQL operations the agent may run (read is always allowed)"
      options={options()}
      onSelect={async (opt) => {
        if (opt.value !== "__done") {
          const next = new Set(granted())
          if (next.has(opt.value)) next.delete(opt.value)
          else next.add(opt.value)
          setGranted(next)
          return
        }
        dialog.clear()
        const ops = SQL_OPS.map((o) => o.key).filter((k) => granted().has(k))
        try {
          await patchExaAgent(sdk, { options: { sqlOps: ops } })
          toast.show({
            message: `Granted SQL operations: ${ops.length ? ops.join(", ") : "none (read-only)"} — ${APPLY_NOTE}.`,
            variant: "success",
          })
        } catch {
          toast.show({ message: "Could not update the SQL operation grants.", variant: "error" })
        }
      }}
    />
  )
}

const TOOL_GROUPS: { key: string; label: string }[] = [
  { key: "files", label: "Files — read and edit local files" },
  { key: "shell", label: "Shell — run commands" },
  { key: "search", label: "Search — grep, glob, list the workspace" },
  { key: "tasks", label: "Tasks — todos and subagents" },
]

export function DialogExaTools() {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [granted, setGranted] = createSignal<Set<string>>(new Set())
  onMount(async () => {
    const agent = await readExaAgent(sdk).catch(() => ({}) as ExaAgentConfig)
    const tools = Array.isArray(agent.options?.tools) ? agent.options.tools : []
    setGranted(new Set(tools.filter((t): t is string => typeof t === "string")))
  })
  const options = () => [
    ...TOOL_GROUPS.map((g) => ({
      title: `${granted().has(g.key) ? "[x]" : "[ ]"} ${g.label}`,
      value: g.key,
    })),
    { title: "Done — save", value: "__done" },
  ]
  return (
    <DialogSelect
      title="Tool groups the agent may use (data tools are always on)"
      options={options()}
      onSelect={async (opt) => {
        if (opt.value !== "__done") {
          const next = new Set(granted())
          if (next.has(opt.value)) next.delete(opt.value)
          else next.add(opt.value)
          setGranted(next)
          return
        }
        dialog.clear()
        const tools = TOOL_GROUPS.map((g) => g.key).filter((k) => granted().has(k))
        try {
          await patchExaAgent(sdk, { options: { tools } })
          toast.show({
            message: `Tool groups: ${tools.length ? tools.join(", ") : "none (data tools only)"} — ${APPLY_NOTE}.`,
            variant: "success",
          })
        } catch {
          toast.show({ message: "Could not update the tool groups.", variant: "error" })
        }
      }}
    />
  )
}

/**
 * /connect-db — attach a database without leaving the session.
 *
 * Databases already running on this machine are offered first: two programs
 * must not each deploy their own and both call it "local".
 */
export function DialogExaConnectDb() {
  const dialog = useDialog()
  const toast = useToast()
  const [options, setOptions] = createSignal<{ title: string; value: string }[]>([
    { title: "Looking for databases…", value: "__wait" },
  ])
  onMount(async () => {
    try {
      const [{ prepareSetup }, { listConnections, activeConnection, connectionsMissingCredentials }] =
        await Promise.all([
          import("../../../exa/src/database/setup"),
          import("../../../exa/src/database/connection"),
        ])
      const [{ options: setup }, connected, current, missing] = await Promise.all([
        prepareSetup(),
        listConnections(),
        activeConnection(),
        connectionsMissingCredentials(),
      ])
      const unusable = new Set(missing.map((c) => c.id))
      setOptions([
        // Several databases can be connected at once, and only one of them is
        // the one an unqualified question goes to — so say which, and make
        // picking another one actually change it.
        ...connected.map((c) => {
          const where = `${c.host}:${c.port}`
          const mark = unusable.has(c.id)
            ? " — needs a password here"
            : c.id === current?.id
              ? " — default"
              : ""
          return { title: `${c.name}  (${where})${mark}`, value: `connected:${c.id}` }
        }),
        ...setup.map((o) => ({ title: o.hint ? `${o.label} — ${o.hint}` : o.label, value: o.value })),
      ])
    } catch {
      setOptions([{ title: "Could not look for databases", value: "skip" }])
    }
  })
  return (
    <DialogSelect
      title="Databases"
      options={options()}
      onSelect={async (opt) => {
        dialog.clear()
        const value = String(opt.value)
        if (value.startsWith("connected:")) {
          const id = value.slice("connected:".length)
          const { setDefaultConnection, listConnections, connectionsMissingCredentials } = await import(
            "../../../exa/src/database/connection"
          )
          const entry = (await listConnections()).find((c) => c.id === id)
          const missing = (await connectionsMissingCredentials()).some((c) => c.id === id)
          if (missing) {
            toast.show({
              message: `${entry?.name ?? id} has no password on this machine — run: exa connect exasol://${entry?.user ?? "sys"}@${entry?.host ?? ""}:${entry?.port ?? ""}`,
              variant: "warning",
              duration: 12_000,
            })
            return
          }
          await setDefaultConnection(id)
          toast.show({
            message: `${entry?.name ?? id} is now the default. Other databases stay available — name them in a question.`,
            variant: "success",
          })
          return
        }
        // Everything else needs credentials or a long-running install, which
        // belong in a terminal rather than a modal.
        const how =
          value === "install"
            ? "exa connect  (choose “Install Exasol Personal locally”)"
            : value.startsWith("use:")
              ? `exa connect exasol://sys@127.0.0.1:${value.slice(4)}`
              : "exa connect"
        toast.show({ message: `Run: ${how}`, variant: "info", duration: 12_000 })
      }}
    />
  )
}
