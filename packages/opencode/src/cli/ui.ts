import { EOL } from "os"
import { Schema } from "effect"

// exa branding — solid block EXA. The X's left chevron (strokes + apex) is
// Exasol green; the right strokes stay the default colour.
const EXA_E = ["███████", "██     ", "█████  ", "██     ", "███████"]
const EXA_XL = ["██  ", " ██ ", "  ██", " ██ ", "██  "]
const EXA_XR = [" ██", "██ ", "█  ", "██ ", " ██"]
const EXA_A = [" █████ ", "██   ██", "███████", "██   ██", "██   ██"]
const wordmark = [
  ...EXA_E.map((e, i) => `${e} ${EXA_XL[i]}${EXA_XR[i]} ${EXA_A[i]}`),
  "by Exasol",
]

export class CancelledError extends Schema.TaggedErrorClass<CancelledError>()("UICancelledError", {}) {}

export const Style = {
  TEXT_HIGHLIGHT: "\x1b[96m",
  TEXT_HIGHLIGHT_BOLD: "\x1b[96m\x1b[1m",
  TEXT_DIM: "\x1b[90m",
  TEXT_DIM_BOLD: "\x1b[90m\x1b[1m",
  TEXT_NORMAL: "\x1b[0m",
  TEXT_NORMAL_BOLD: "\x1b[1m",
  TEXT_WARNING: "\x1b[93m",
  TEXT_WARNING_BOLD: "\x1b[93m\x1b[1m",
  TEXT_DANGER: "\x1b[91m",
  TEXT_DANGER_BOLD: "\x1b[91m\x1b[1m",
  TEXT_SUCCESS: "\x1b[92m",
  TEXT_SUCCESS_BOLD: "\x1b[92m\x1b[1m",
  TEXT_INFO: "\x1b[94m",
  TEXT_INFO_BOLD: "\x1b[94m\x1b[1m",
}

export function println(...message: string[]) {
  print(...message)
  process.stderr.write(EOL)
}

export function print(...message: string[]) {
  blank = false
  process.stderr.write(message.join(" "))
}

let blank = false
export function empty() {
  if (blank) return
  println("" + Style.TEXT_NORMAL)
  blank = true
}

export function logo(pad?: string) {
  if (!process.stdout.isTTY && !process.stderr.isTTY) {
    const result = []
    for (const row of wordmark) {
      if (pad) result.push(pad)
      result.push(row)
      result.push(EOL)
    }
    return result.join("").trimEnd()
  }

  const reset = "\x1b[0m"
  const bold = "\x1b[1m"
  const green = "\x1b[38;2;95;195;59m"
  const dim = "\x1b[90m"
  const result: string[] = []
  for (let i = 0; i < EXA_E.length; i++) {
    if (pad) result.push(pad)
    result.push(bold, EXA_E[i], reset, " ")
    result.push(bold, green, EXA_XL[i], reset)
    result.push(bold, EXA_XR[i], reset, " ")
    result.push(bold, EXA_A[i], reset)
    result.push(EOL)
  }
  if (pad) result.push(pad)
  result.push(dim, "by Exasol", reset, EOL)
  return result.join("").trimEnd()
}

export async function input(prompt: string): Promise<string> {
  const readline = require("readline")
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

export function error(message: string) {
  if (message.startsWith("Error: ")) {
    message = message.slice("Error: ".length)
  }
  println(Style.TEXT_DANGER_BOLD + "Error: " + Style.TEXT_NORMAL + message)
}

export function markdown(text: string): string {
  return text
}

export * as UI from "./ui"
