/**
 * The unsecured-server warning, with the fix in the same breath.
 *
 * "EXA_SERVER_PASSWORD is not set; server is unsecured" names a variable and
 * stops — the reader is left to guess where to set it and what it protects.
 * A warning that requires research is homework, not a warning.
 *
 * It also overstated the default case: bound to 127.0.0.1 the server is only
 * reachable from this machine, which matters. The message says who can reach
 * it for the binding actually in use, and the one line that closes the gap.
 */
export function unsecuredServerWarning(hostname: string, command: "serve" | "web"): string[] {
  const local = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  return [
    local
      ? "!  No password set — anything running on this machine can use this server."
      : "!  No password set — ANYONE on your network can use this server.",
    `   Secure it:  EXA_SERVER_PASSWORD=<choose-a-password> exa ${command}`,
    `   The browser then asks to sign in: username "exa", password the one you chose.`,
  ]
}
