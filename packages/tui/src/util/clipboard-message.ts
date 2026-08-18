/**
 * What was copied, not just that something was.
 *
 * "Copied to clipboard" leaves the user to guess whether they got the line
 * they meant or the whole scrollback. The size answers that at a glance, and
 * it is the one fact the notice can state for certain.
 */
const NUMBER = new Intl.NumberFormat("en-US")

export function copiedMessage(text: string, what = "Copied"): string {
  const count = [...text].length
  return `${what} ${NUMBER.format(count)} ${count === 1 ? "character" : "characters"}`
}
