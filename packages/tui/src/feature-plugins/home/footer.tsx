import type { TuiPlugin, TuiPluginApi } from "@exa/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, Match, onMount, Show, Switch } from "solid-js"
import { abbreviateHome } from "../../runtime"
import { useTuiPaths } from "../../context/runtime"
import { useHomeSessionDestination } from "../../routes/home/session-destination"

const id = "internal:home-footer"

function Directory(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const destination = useHomeSessionDestination()
  const paths = useTuiPaths()
  const dir = createMemo(() => {
    const selected = destination?.destination()
    if (!selected || selected.type === "new") return
    const out = abbreviateHome(selected.directory, paths.home)
    const branch =
      selected.directory === (props.api.state.path.directory || paths.cwd) ? props.api.state.vcs?.branch : undefined
    if (branch) return out + ":" + branch
    return out
  })

  return <Show when={dir()}>{(value) => <text fg={theme().textMuted}>{value()}</text>}</Show>
}

/**
 * The database this session will query.
 *
 * A data agent's footer should answer "what am I connected to", the way a
 * coding tool's answers "what branch am I on". Read once on mount: the
 * registry only changes when the user runs `exa connect` or /connect-db, both
 * of which restart this view.
 */
function Database(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [name, setName] = createSignal<string>()
  onMount(async () => {
    try {
      const { activeConnection } = await import("../../../../exa/src/database/connection")
      const current = await activeConnection()
      if (current) setName(current.name)
    } catch {
      // The footer must never be the reason the app fails to draw.
    }
  })
  return (
    <Show when={name()}>
      {(value) => (
        <text fg={theme().textMuted}>
          <span style={{ fg: theme().success }}>⛁ </span>
          {value()}
        </text>
      )}
    </Show>
  )
}

function Mcp(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <text fg={theme().text}>
          <Switch>
            <Match when={err()}>
              <span style={{ fg: theme().error }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: count() > 0 ? theme().success : theme().textMuted }}>⊙ </span>
            </Match>
          </Switch>
          {count()} MCP
        </text>
        <text fg={theme().textMuted}>/status</text>
      </box>
    </Show>
  )
}

function Version(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  return (
    <box flexShrink={0}>
      <text fg={theme().textMuted}>{props.api.app.version}</text>
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <Directory api={props.api} />
      <Database api={props.api} />
      <Mcp api={props.api} />
      <box flexGrow={1} />
      <Version api={props.api} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
