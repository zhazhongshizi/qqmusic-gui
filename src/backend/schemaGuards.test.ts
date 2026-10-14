import { expect, it } from "vitest";
import { createSchemaGuards } from "./schemaGuards";
const guards = createSchemaGuards(() => { throw new Error("invalid DTO"); });
it("supports declared optional extensions while refusing missing and unexpected fields", () => {
  expect(guards.record({ id: "a" }, ["id"], ["label"])).toEqual({ id: "a" });
  expect(guards.record({ id: "a", label: "new" }, ["id"], ["label"])).toEqual({ id: "a", label: "new" });
  for (const value of [{ label: "only" }, { id: "a", private: "no" }, Object.create({ id: "inherited" }), null, []]) {
    expect(() => guards.record(value, ["id"], ["label"])).toThrow("invalid DTO");
  }
  expect(() => guards.exactRecord({ id: "a", label: "unknown" }, ["id"])).toThrow();
});
it("keeps integer and UTF-8 byte limits including empty/control character policy", () => {
  expect(guards.unsigned(0)).toBe(0);
  for (const value of [-1, .5, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) expect(() => guards.unsigned(value)).toThrow();
  expect(guards.utf8Text("歌", 3)).toBe("歌");
  expect(() => guards.utf8Text("歌", 2)).toThrow();
  expect(guards.utf8Text("", 3, true)).toBe("");
  for (const value of ["", "a\nb", "\0", "\r"]) expect(() => guards.utf8Text(value, 20)).toThrow();
});
