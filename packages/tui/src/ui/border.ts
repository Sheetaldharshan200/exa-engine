export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

export const SplitBorder = {
  border: ["left" as const, "right" as const],
  customBorderChars: {
    ...EmptyBorder,
    vertical: "┃",
  },
}

/**
 * The composer's frame: a full rounded box.
 *
 * The previous treatment — a single accent bar down the left with a
 * half-block shadow under it — is the most recognisable thing about this
 * screen, and it belonged to the project this was forked from. A closed frame
 * reads as a different product at a glance and states plainly where the input
 * begins and ends, which the floating left bar never did.
 */
export const ComposerBorder = {
  border: ["top" as const, "right" as const, "bottom" as const, "left" as const],
  customBorderChars: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    bottomT: "┴",
    topT: "┬",
    cross: "┼",
    leftT: "├",
    rightT: "┤",
  },
}

/**
 * The rule beside something the user said.
 *
 * A heavy "┃" bar was the loudest thing in the transcript and belonged to the
 * project this was forked from. A thin rule recedes, letting the text carry
 * the message, and matches the weight of the composer's own frame.
 */
export const PromptBorder = {
  border: ["left" as const],
  customBorderChars: {
    ...EmptyBorder,
    vertical: "▏",
  },
}
