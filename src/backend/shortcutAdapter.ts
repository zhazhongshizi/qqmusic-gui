import { invoke } from "@tauri-apps/api/core";
import { SHORTCUT_ACTIONS, type ShortcutBinding, type ShortcutSettingsValue, type ShortcutSnapshot } from "../contracts/shortcuts";
import { createSchemaGuards } from "./schemaGuards";

const invalid = (): never => { throw new Error("快捷键状态格式无效，请重新打开设置"); };
const guards = createSchemaGuards(invalid);

export function parseShortcutSnapshot(value: unknown): ShortcutSnapshot {
  const root = guards.exactRecord(value, ["settings", "errors"]);
  const settings = guards.exactRecord(root.settings, ["enabled", "bindings"]);
  if (typeof settings.enabled !== "boolean" || !Array.isArray(settings.bindings) || settings.bindings.length !== 5
    || !Array.isArray(root.errors) || !root.errors.every(error => typeof error === "string")) return invalid();
  const seen = new Set<string>();
  const bindings = settings.bindings.map(value => {
    const binding = guards.exactRecord(value, ["action", "enabled", "shortcut"]);
    if (!SHORTCUT_ACTIONS.some(item => item.action === binding.action) || typeof binding.enabled !== "boolean"
      || typeof binding.action !== "string" || seen.has(binding.action)) return invalid();
    seen.add(binding.action);
    return { action: binding.action, enabled: binding.enabled, shortcut: guards.utf8Text(binding.shortcut, 100) } as ShortcutBinding;
  });
  return { settings: { enabled: settings.enabled, bindings }, errors: root.errors as string[] };
}

export async function shortcutsControl(settings?: ShortcutSettingsValue): Promise<ShortcutSnapshot> {
  return parseShortcutSnapshot(await invoke<unknown>("shortcuts_control", {
    request: settings ? { action: "save", settings } : { action: "status" },
  }));
}
