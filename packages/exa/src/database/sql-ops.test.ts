import { describe, expect, test } from "bun:test"
import { classifySql } from "./sql-ops"

describe("classifySql", () => {
  test("reads are unrestricted", () => {
    for (const sql of [
      "SELECT 1",
      "  select * from t  ",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "DESCRIBE SALES.ORDERS",
      "EXPLAIN SELECT 1",
    ]) {
      expect(classifySql(sql)).toBeUndefined()
    }
  })

  test("classifies each write class", () => {
    expect(classifySql("INSERT INTO t VALUES (1)")).toBe("insert")
    expect(classifySql("IMPORT INTO t FROM LOCAL CSV FILE 'x'")).toBe("insert")
    expect(classifySql("UPDATE t SET a = 1")).toBe("update")
    expect(classifySql("DELETE FROM t")).toBe("delete")
    expect(classifySql("TRUNCATE TABLE t")).toBe("delete")
    expect(classifySql("CREATE TABLE t (a INT)")).toBe("create")
    expect(classifySql("ALTER TABLE t ADD COLUMN b INT")).toBe("alter")
    expect(classifySql("RENAME TABLE a TO b")).toBe("alter")
    expect(classifySql("DROP TABLE t")).toBe("drop")
    expect(classifySql("GRANT SELECT ON s TO u")).toBe("dcl")
    expect(classifySql("REVOKE SELECT ON s FROM u")).toBe("dcl")
  })

  // The interesting cases: statements that LOOK like reads.
  test("a comment cannot disguise a write", () => {
    expect(classifySql("/* just a select */ DELETE FROM t")).toBe("delete")
    expect(classifySql("-- SELECT 1\nDROP TABLE t")).toBe("drop")
    expect(classifySql("/* a */ /* b */ UPDATE t SET x = 1")).toBe("update")
  })

  test("a CTE prefix cannot disguise a write", () => {
    expect(classifySql("WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM x)")).toBe("delete")
    expect(classifySql("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x")).toBe("insert")
  })

  test("MERGE requires the stronger class when it can insert", () => {
    expect(classifySql("MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN UPDATE SET a = 1")).toBe("update")
    expect(classifySql("MERGE INTO t USING s ON (1=1) WHEN NOT MATCHED THEN INSERT VALUES (1)")).toBe("insert")
  })

  test("ALTER SYSTEM and SESSION are administration, not schema changes", () => {
    expect(classifySql("ALTER SYSTEM SET x = 1")).toBe("admin")
    expect(classifySql("ALTER SESSION SET TIME_ZONE = 'UTC'")).toBe("admin")
    expect(classifySql("ALTER SCHEMA s CHANGE OWNER u")).toBe("alter")
  })

  // Fail closed: an unrecognized verb must not be assumed harmless.
  test("an unknown statement is treated as administrative", () => {
    expect(classifySql("FROBNICATE THE DATABASE")).toBe("admin")
    expect(classifySql("KILL SESSION 1")).toBe("admin")
  })

  test("empty input is not a write", () => {
    expect(classifySql("")).toBeUndefined()
    expect(classifySql("   ")).toBeUndefined()
    expect(classifySql("-- only a comment")).toBeUndefined()
  })
})
