import { Schema } from "effect"
import { NamedError } from "@exa/core/util/error"
import { Process } from "@/util/process"
import { IdeEvent } from "@exa/schema/ide-event"

const SUPPORTED_IDES = [
  { name: "Windsurf" as const, cmd: "windsurf" },
  { name: "Visual Studio Code - Insiders" as const, cmd: "code-insiders" },
  { name: "Visual Studio Code" as const, cmd: "code" },
  { name: "Cursor" as const, cmd: "cursor" },
  { name: "VSCodium" as const, cmd: "codium" },
]

export const Event = IdeEvent

export const AlreadyInstalledError = NamedError.create("AlreadyInstalledError", {})

export const InstallFailedError = NamedError.create("InstallFailedError", {
  stderr: Schema.String,
})

export function ide() {
  if (process.env["TERM_PROGRAM"] === "vscode") {
    const v = process.env["GIT_ASKPASS"]
    for (const ide of SUPPORTED_IDES) {
      if (v?.includes(ide.name)) return ide.name
    }
  }
  return "unknown"
}

export function alreadyInstalled() {
  return process.env["EXA_CALLER"] === "vscode" || process.env["EXA_CALLER"] === "vscode-insiders"
}

/**
 * The extension to install, as publisher.name on the marketplace.
 *
 * This was hardcoded to the upstream project's published extension, so
 * running exa inside an editor terminal installed THEIR extension — a
 * different product, from a different publisher, silently. The default now
 * matches this repository's own extension (sdks/vscode/package.json), and
 * EXA_VSCODE_EXTENSION_ID overrides it for anyone publishing a fork under
 * their own publisher id.
 */
export function extensionId(env: Record<string, string | undefined> = process.env): string {
  return env["EXA_VSCODE_EXTENSION_ID"]?.trim() || "sheetaldharshan200.exa"
}

export async function install(ide: (typeof SUPPORTED_IDES)[number]["name"]) {
  const cmd = SUPPORTED_IDES.find((i) => i.name === ide)?.cmd
  if (!cmd) throw new Error(`Unknown IDE: ${ide}`)

  const p = await Process.run([cmd, "--install-extension", extensionId()], {
    nothrow: true,
  })
  const stdout = p.stdout.toString()
  const stderr = p.stderr.toString()

  if (p.code !== 0) {
    throw new InstallFailedError({ stderr })
  }
  if (stdout.includes("already installed")) {
    throw new AlreadyInstalledError({})
  }
}

export * as Ide from "."
