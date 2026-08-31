import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerExaSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}
