import { expect, it } from "vitest";
import { parseShortcutSnapshot } from "./shortcutAdapter";
import { defaultShortcuts, shortcutLabel } from "../contracts/shortcuts";

it("parses five actions including play/pause and preserves registration errors", () => {
  const value = { settings: defaultShortcuts(), errors: ["快捷键占用"] };
  expect(parseShortcutSnapshot(value)).toEqual(value);
  expect(shortcutLabel("shift+control+KeyP")).toBe("Ctrl + Shift + P");
});

it("rejects missing, duplicate and unknown actions and malformed status", () => {
  const value = () => ({ settings: defaultShortcuts(), errors: [] });
  const missing = value(); missing.settings.bindings.pop();
  const duplicate = value(); duplicate.settings.bindings[1]!.action = "togglePlayback";
  const extra = { ...value(), privatePath: "unexpected" };
  for (const bad of [missing, duplicate, extra, { settings: null, errors: [] }, { ...value(), errors: [42] }]) {
    expect(() => parseShortcutSnapshot(bad)).toThrow();
  }
});
