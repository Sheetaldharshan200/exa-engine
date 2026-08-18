import { createSignal, onMount, Show } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"

/**
 * The local engine's models, shown the way a package manager shows them:
 * what is installed, what it would cost to install the rest, and one keypress
 * to do it.
 *
 * Picking this provider used to print a line telling the user to go and run a
 * shell command. Every other provider in this dialog completes its setup right
 * here, and there is no reason a local model should be the exception.
 */

type Entry = {
  id: string
  name: string
  description: string
  sizeMB: number
  minRamGB: number
  installed: boolean
}

function formatSize(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

/** The download, with the progress the dialog list cannot show. */
function Progress(props: { title: string; line: () => string; done: () => boolean; failed: () => string | undefined }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  return (
    <box padding={1} width={64} flexDirection="column" gap={1}>
      <text fg={theme.text}>
        <b>{props.title}</b>
      </text>
      <Show
        when={!props.failed()}
        fallback={
          <text fg={theme.error}>{props.failed()}</text>
        }
      >
        <text fg={theme.textMuted}>{props.line()}</text>
      </Show>
      <Show when={props.done() || props.failed()}>
        <text fg={theme.textMuted}>esc to close</text>
      </Show>
      <Show when={!props.done() && !props.failed()}>
        <text fg={theme.textMuted}>this runs once — the model is cached afterwards</text>
      </Show>
      <box onMouseDown={() => (props.done() || props.failed() ? dialog.clear() : undefined)} />
    </box>
  )
}

export function DialogLocalModels() {
  const dialog = useDialog()
  const toast = useToast()
  const [entries, setEntries] = createSignal<Entry[]>([])
  const [serving, setServing] = createSignal<string>()

  onMount(async () => {
    try {
      const [{ MODELS }, { installed, running }] = await Promise.all([
        import("../../../exa/src/local/catalog"),
        import("../../../exa/src/local/engine"),
      ])
      const have = new Set((await installed()).map((m) => m.id))
      // What can be used right now comes first; what needs a download follows.
      setEntries(
        [...MODELS]
          .sort((a, b) => Number(have.has(b.id)) - Number(have.has(a.id)))
          .map((m) => ({
            id: m.id,
            name: m.name,
            description: m.description,
            sizeMB: m.sizeMB,
            minRamGB: m.minRamGB,
            installed: have.has(m.id),
          })),
      )
      if (await running()) {
        const res = await fetch("http://127.0.0.1:41414/v1/models", { signal: AbortSignal.timeout(1_500) })
          .then((r) => (r.ok ? (r.json() as Promise<{ data?: { id: string }[] }>) : undefined))
          .catch(() => undefined)
        setServing(res?.data?.[0]?.id)
      }
    } catch {
      setEntries([])
    }
  })

  async function start(entry: Entry) {
    const [{ findModel }, { serve }] = await Promise.all([
      import("../../../exa/src/local/catalog"),
      import("../../../exa/src/local/engine"),
    ])
    const model = findModel(entry.id)
    if (!model) return

    const [line, setLine] = createSignal(entry.installed ? "starting…" : "preparing download…")
    const [done, setDone] = createSignal(false)
    const [failed, setFailed] = createSignal<string>()
    dialog.replace(() => (
      <Progress
        title={entry.installed ? `Starting ${entry.name}` : `Installing ${entry.name} (${formatSize(entry.sizeMB)})`}
        line={line}
        done={done}
        failed={failed}
      />
    ))

    try {
      await serve(model, (l) => setLine(l.trim()))
      setDone(true)
      setLine(`${entry.name} is running — pick it from the model list`)
      toast.show({ variant: "success", message: `${entry.name} is ready` })
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <DialogSelect
      title="Local models"
      options={entries().map((entry) => ({
        title: entry.name,
        value: entry.id,
        description:
          entry.id === serving()
            ? "running"
            : entry.installed
              ? `installed — ${entry.minRamGB} GB RAM`
              : `install ${formatSize(entry.sizeMB)} — ${entry.minRamGB} GB RAM`,
        category: entry.installed ? "Installed" : "Available",
        async onSelect() {
          await start(entry)
        },
      }))}
      onSelect={() => {}}
    />
  )
}
