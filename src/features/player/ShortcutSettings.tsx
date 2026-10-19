import { useEffect, useRef, useState } from "react";
import { shortcutsControl } from "../../backend/shortcutAdapter";
import { defaultShortcuts, SHORTCUT_ACTIONS, SHORTCUT_KEYS, SHORTCUT_MODIFIERS, shortcutLabel, shortcutParts,
  type ShortcutAction, type ShortcutBinding, type ShortcutSnapshot, type ShortcutSettingsValue } from "../../contracts/shortcuts";
import "./shortcut-settings.css";

function ShortcutEditor() {
  const native = "__TAURI_INTERNALS__" in window;
  const [snapshot, setSnapshot] = useState<ShortcutSnapshot | null>(null);
  const [draft, setDraft] = useState<ShortcutSettingsValue>(defaultShortcuts);
  const [busy, setBusy] = useState(native);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<ShortcutAction | null>(null);
  const [reload, setReload] = useState(0);
  const mounted = useRef(false), saving = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!native) return;
    let active = true;
    setBusy(true); setError("");
    void shortcutsControl().then(value => {
      if (active) { setSnapshot(value); setDraft(value.settings); }
    }, () => { if (active) setError("快捷键配置读取失败，请重试"); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [native, reload]);

  function patch(action: ShortcutAction, value: Partial<ShortcutBinding>) {
    setMessage(""); setError("");
    setDraft(current => ({ ...current, bindings: current.bindings.map(binding => binding.action === action ? { ...binding, ...value } : binding) }));
  }
  async function save() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const value = await shortcutsControl(draft);
      if (mounted.current) { setSnapshot(value); setDraft(value.settings); setMessage("快捷键已保存并生效"); }
    } catch (reason) {
      if (mounted.current) setError(typeof reason === "string" ? reason : "快捷键保存失败，请重试");
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const dirty = snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.settings);
  const disabled = !native || busy || !snapshot;
  return <section className="shortcut-editor" aria-label="快捷键配置" aria-busy={busy}
    onKeyDown={event => { if (event.key !== "Escape") event.stopPropagation(); }}>
    <p className="shortcut-settings__note">设置全局组合键，软件在后台或隐藏到托盘时也能控制播放。修改后点击保存。</p>
    {!native && <p className="shortcut-settings__note">请在 Windows 桌面版中设置快捷键。</p>}
    <label className="shortcut-settings__master"><input type="checkbox" checked={draft.enabled} disabled={disabled}
      onChange={event => { setDraft(current => ({ ...current, enabled: event.target.checked })); setMessage(""); setError(""); }} />启用全局快捷键</label>
    <div className="shortcut-settings__bindings">
      {SHORTCUT_ACTIONS.map(({ action, label }) => {
        const binding = draft.bindings.find(item => item.action === action)!;
        const parts = shortcutParts(binding.shortcut);
        const blocked = disabled || !draft.enabled;
        return <div className="shortcut-settings__binding" key={action}>
          <div className="shortcut-settings__row">
            <label><input type="checkbox" aria-label={`启用${label}快捷键`} checked={binding.enabled} disabled={blocked}
              onChange={event => patch(action, { enabled: event.target.checked })} />{label}</label>
            <button type="button" className="shortcut-settings__key" disabled={blocked || !binding.enabled}
              aria-label={`修改${label}快捷键`} aria-expanded={editing === action}
              onClick={() => setEditing(editing === action ? null : action)}>{shortcutLabel(binding.shortcut)}<span aria-hidden="true">修改</span></button>
          </div>
          {editing === action && <fieldset className="shortcut-settings__edit" disabled={blocked || !binding.enabled}>
            <legend>{label}组合键</legend>
            <div className="shortcut-settings__modifiers">{SHORTCUT_MODIFIERS.map(modifier => <label key={modifier.value}>
              <input type="checkbox" checked={parts.modifiers.includes(modifier.value)} onChange={event => {
                const modifiers = event.target.checked ? [...parts.modifiers, modifier.value] : parts.modifiers.filter(value => value !== modifier.value);
                patch(action, { shortcut: [...SHORTCUT_MODIFIERS.filter(item => modifiers.includes(item.value)).map(item => item.value), parts.key].join("+") });
              }} />{modifier.label}</label>)}</div>
            <label className="shortcut-settings__main-key">主键<select aria-label={`${label}主键`} value={parts.key}
              onChange={event => patch(action, { shortcut: [...parts.modifiers, event.target.value].join("+") })}>
              {!SHORTCUT_KEYS.some(item => item.value === parts.key) && <option value={parts.key}>{parts.key}</option>}
              {SHORTCUT_KEYS.map(key => <option value={key.value} key={key.value}>{key.label}</option>)}
            </select></label>
          </fieldset>}
        </div>;
      })}
    </div>
    <div className="shortcut-settings__actions">
      <button type="button" disabled={disabled} onClick={() => { setDraft(defaultShortcuts()); setMessage(""); setError(""); setEditing(null); }}>恢复默认快捷键</button>
      <button type="button" disabled={disabled} onClick={() => void save()}>{busy ? "正在读取或保存…" : "保存快捷键"}</button>
    </div>
    {dirty && <p className="shortcut-settings__note">有未保存的修改。</p>}
    {message && <p role="status">{message}</p>}
    {(error || snapshot?.errors.length) ? <div className="shortcut-settings__error" role="alert">
      {error && <p>{error}</p>}{snapshot?.errors.map(value => <p key={value}>{value}</p>)}
      {!snapshot && native && !busy && <button type="button" onClick={() => setReload(value => value + 1)}>重新读取快捷键配置</button>}
    </div> : null}
    <p className="shortcut-settings__note">关闭单项会保留组合。音量每次增减 10 个百分点，范围为 0%～100%。</p>
  </section>;
}

export function ShortcutSettings({ presentation = "normal" }: { presentation?: "normal" | "rhine" }) {
  const [open, setOpen] = useState(false);
  if (presentation === "rhine") return <div className="shortcut-settings shortcut-settings--rhine"><ShortcutEditor /></div>;
  return <details className="shortcut-settings" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>快捷键设置</summary>{open && <ShortcutEditor />}
  </details>;
}
