import { Config } from "effect"

/** Read an EXA_-prefixed environment variable. */
export function envVar(suffix: string) {
  return process.env["EXA_" + suffix]
}

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

/** truthy() over an EXA_-prefixed variable. */
export function truthyVar(suffix: string) {
  const value = envVar(suffix)?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = envVar("EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
const fff = envVar("DISABLE_FFF")

function enabledByExperimental(suffix: string) {
  return envVar(suffix) === undefined ? truthyVar("EXPERIMENTAL") : truthyVar(suffix)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  EXA_AUTO_HEAP_SNAPSHOT: truthyVar("AUTO_HEAP_SNAPSHOT"),
  EXA_GIT_BASH_PATH: envVar("GIT_BASH_PATH"),
  EXA_CONFIG: envVar("CONFIG"),
  EXA_CONFIG_CONTENT: envVar("CONFIG_CONTENT"),
  EXA_DISABLE_AUTOUPDATE: truthyVar("DISABLE_AUTOUPDATE"),
  EXA_ALWAYS_NOTIFY_UPDATE: truthyVar("ALWAYS_NOTIFY_UPDATE"),
  EXA_DISABLE_PRUNE: truthyVar("DISABLE_PRUNE"),
  EXA_DISABLE_TERMINAL_TITLE: truthyVar("DISABLE_TERMINAL_TITLE"),
  EXA_SHOW_TTFD: truthyVar("SHOW_TTFD"),
  EXA_DISABLE_AUTOCOMPACT: truthyVar("DISABLE_AUTOCOMPACT"),
  EXA_DISABLE_MODELS_FETCH: truthyVar("DISABLE_MODELS_FETCH"),
  EXA_DISABLE_MOUSE: truthyVar("DISABLE_MOUSE"),
  EXA_FAKE_VCS: envVar("FAKE_VCS"),
  EXA_SERVER_PASSWORD: envVar("SERVER_PASSWORD"),
  EXA_SERVER_USERNAME: envVar("SERVER_USERNAME"),
  EXA_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthyVar("DISABLE_FFF"),

  // Experimental
  EXA_EXPERIMENTAL_FILEWATCHER: Config.boolean("EXA_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  EXA_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("EXA_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  EXA_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthyVar("EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  EXA_MODELS_URL: envVar("MODELS_URL"),
  EXA_MODELS_PATH: envVar("MODELS_PATH"),
  EXA_DB: envVar("DB"),

  EXA_WORKSPACE_ID: envVar("WORKSPACE_ID"),
  EXA_EXPERIMENTAL_WORKSPACES: enabledByExperimental("EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get EXA_DISABLE_PROJECT_CONFIG() {
    return truthyVar("DISABLE_PROJECT_CONFIG")
  },
  get EXA_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("EXPERIMENTAL_REFERENCES")
  },
  get EXA_TUI_CONFIG() {
    return envVar("TUI_CONFIG")
  },
  get EXA_CONFIG_DIR() {
    return envVar("CONFIG_DIR")
  },
  get EXA_PURE() {
    return truthyVar("PURE")
  },
  get EXA_PERMISSION() {
    return envVar("PERMISSION")
  },
  get EXA_PLUGIN_META_FILE() {
    return envVar("PLUGIN_META_FILE")
  },
  get EXA_CLIENT() {
    return envVar("CLIENT") ?? "cli"
  },
}
