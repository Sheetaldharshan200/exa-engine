/**
 * Classifying a statement into the operation class it belongs to.
 *
 * This is the enforcement point for `exa ops`: the agent's prompt asks it to
 * behave, but this decides. A statement whose class was not granted never
 * reaches the database, no matter what the model intended.
 *
 * Reads return undefined — they are always allowed.
 */

export type SqlOps = "insert" | "update" | "delete" | "create" | "alter" | "drop" | "dcl" | "admin"

const LABELS: Record<SqlOps, string> = {
  insert: "an INSERT (adds rows)",
  update: "an UPDATE (changes rows)",
  delete: "a DELETE or TRUNCATE (removes rows)",
  create: "a CREATE (adds objects)",
  alter: "an ALTER or RENAME (changes objects)",
  drop: "a DROP (removes objects)",
  dcl: "an access-control change (GRANT/REVOKE, users, roles)",
  admin: "an administrative statement (system, session, kill)",
}

export function describeOperation(op: SqlOps): string {
  return LABELS[op]
}

/**
 * Strip comments and leading noise so the leading keyword is the real one —
 * `/* hide *​/ DELETE …` and `-- x\nDROP …` must not read as a SELECT.
 */
function normalize(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
}

/**
 * The operation class of a statement, or undefined when it only reads.
 *
 * WITH-prefixed statements are followed through to their body, because
 * `WITH x AS (…) DELETE …` is a delete, not a read.
 */
export function classifySql(sql: string): SqlOps | undefined {
  let text = normalize(sql)
  if (!text) return undefined

  // Follow a CTE prefix to the statement it actually runs.
  if (text.startsWith("WITH ")) {
    const match = text.match(/\)\s*(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/)
    if (!match) return undefined
    text = text.slice(text.indexOf(match[1], match.index ?? 0))
  }

  const word = text.split(" ")[0]
  switch (word) {
    case "SELECT":
    case "DESCRIBE":
    case "DESC":
    case "EXPLAIN":
    case "SHOW":
    case "VALUES":
      return undefined
    case "INSERT":
    case "IMPORT":
      return "insert"
    case "UPDATE":
      return "update"
    case "DELETE":
    case "TRUNCATE":
      return "delete"
    case "MERGE":
      // A MERGE can insert and update; require the stronger of the two.
      return text.includes("WHEN NOT MATCHED") ? "insert" : "update"
    case "CREATE":
    case "REPLACE":
      return "create"
    case "ALTER":
      // ALTER SYSTEM/SESSION is administration, not a schema change.
      return /^ALTER (SYSTEM|SESSION)\b/.test(text) ? "admin" : "alter"
    case "RENAME":
    case "COMMENT":
      return "alter"
    case "DROP":
      return "drop"
    case "GRANT":
    case "REVOKE":
      return "dcl"
    case "KILL":
    case "FLUSH":
    case "RECOMPRESS":
    case "REORGANIZE":
    case "ANALYZE":
      return "admin"
    default:
      // Unknown verb: treat as administrative rather than assume it is safe.
      return "admin"
  }
}
