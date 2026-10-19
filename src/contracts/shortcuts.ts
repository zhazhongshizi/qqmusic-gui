export const SHORTCUT_ACTIONS = [
  { action: "togglePlayback", label: "播放／暂停", key: "Space" },
  { action: "next", label: "下一首", key: "ArrowRight" },
  { action: "previous", label: "上一首", key: "ArrowLeft" },
  { action: "volumeUp", label: "音量增加 10%", key: "ArrowUp" },
  { action: "volumeDown", label: "音量降低 10%", key: "ArrowDown" },
] as const;

export type ShortcutAction = typeof SHORTCUT_ACTIONS[number]["action"];
export interface ShortcutBinding { action: ShortcutAction; enabled: boolean; shortcut: string }
export interface ShortcutSettingsValue { enabled: boolean; bindings: ShortcutBinding[] }
export interface ShortcutSnapshot { settings: ShortcutSettingsValue; errors: string[] }

export function defaultShortcuts(): ShortcutSettingsValue {
  return { enabled: true, bindings: SHORTCUT_ACTIONS.map(({ action, key }) => ({ action, enabled: true, shortcut: `Control+Alt+${key}` })) };
}

export const SHORTCUT_MODIFIERS = [
  { value: "Control", label: "Ctrl" }, { value: "Alt", label: "Alt" },
  { value: "Shift", label: "Shift" }, { value: "Super", label: "Win" },
] as const;

export const SHORTCUT_KEYS = [
  { value: "Space", label: "空格" },
  { value: "ArrowRight", label: "→ 右方向键" }, { value: "ArrowLeft", label: "← 左方向键" },
  { value: "ArrowUp", label: "↑ 上方向键" }, { value: "ArrowDown", label: "↓ 下方向键" },
  ...Array.from({ length: 26 }, (_, i) => ({ value: `Key${String.fromCharCode(65 + i)}`, label: String.fromCharCode(65 + i) })),
  ...Array.from({ length: 10 }, (_, i) => ({ value: `Digit${i}`, label: String(i) })),
  ...Array.from({ length: 24 }, (_, i) => ({ value: `F${i + 1}`, label: `F${i + 1}` })),
  ...["Enter", "Tab", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown"].map(value => ({ value, label: value })),
];

export function shortcutParts(shortcut: string) {
  const tokens = shortcut.split("+");
  const key = tokens.pop() ?? "Space";
  const aliases: Record<string, string> = { ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift", super: "Super", cmd: "Super" };
  return { key, modifiers: tokens.map(token => aliases[token.trim().toLowerCase()] ?? token) };
}

export function shortcutLabel(shortcut: string) {
  const { key, modifiers } = shortcutParts(shortcut);
  return [...SHORTCUT_MODIFIERS.filter(item => modifiers.includes(item.value)).map(item => item.label),
    SHORTCUT_KEYS.find(item => item.value === key)?.label ?? key].join(" + ");
}
