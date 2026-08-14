import { registerCustomTheme } from "@pierre/diffs"
import { ExaTheme } from "./marked-theme"

let registered = false

export function registerExaTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("Exa", () => Promise.resolve(ExaTheme))
}
