import { useEffect, useState } from "react";
import "./remote-control.css";

interface RemoteStatus { enabled: boolean; addresses: string[]; pairingCode: string | null }
const OFF: RemoteStatus = { enabled: false, addresses: [], pairingCode: null };

async function requestStatus(command: "remote_status" | "remote_set_enabled", enabled?: boolean): Promise<RemoteStatus> {
  const { invoke } = await import("@tauri-apps/api/core");
  const value = await invoke<unknown>(command, enabled === undefined ? {} : { enabled });
  if (!value || typeof value !== "object") throw new Error("读取遥控状态失败");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "addresses,enabled,pairingCode" || typeof data.enabled !== "boolean"
    || !Array.isArray(data.addresses) || !data.addresses.every((a) => typeof a === "string" && /^http:\/\/[\d.]+:\d+$/.test(a))
    || !(data.pairingCode === null || (typeof data.pairingCode === "string" && /^[a-f0-9]{32}$/.test(data.pairingCode)))) throw new Error("读取遥控状态失败");
  return data as unknown as RemoteStatus;
}

export function RemoteControlSettings() {
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [status, setStatus] = useState(OFF);
  const [busy, setBusy] = useState(native);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!native) return;
    let active = true;
    void requestStatus("remote_status").then((s) => { if (active) setStatus(s); }, () => { if (active) setError("读取遥控状态失败，请重新打开设置"); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [native]);
  async function toggle() {
    setBusy(true); setError(""); setCopied(false);
    try { setStatus(await requestStatus("remote_set_enabled", !status.enabled)); }
    catch (e) { setError(typeof e === "string" ? e : "遥控服务操作失败，请重试"); }
    finally { setBusy(false); }
  }
  const primary = status.addresses.find((a) => !a.includes("127.0.0.1"));
  const link = `${primary ?? status.addresses[0] ?? ""}/#code=${status.pairingCode ?? ""}`;
  return <>
    <div className="fixture-menu__divider" role="separator" />
    <span className="section-label">局域网遥控 · 测试版</span>
    <button type="button" role="menuitemcheckbox" aria-checked={status.enabled} disabled={!native || busy} onClick={() => void toggle()}>
      <span>{busy ? "正在连接播放核心…" : "允许手机 / 平板遥控"}</span><i aria-hidden="true" />
    </button>
    {status.enabled && <div className="remote-settings" role="group" aria-label="遥控连接信息" onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }}>
      <p>手机与电脑连接同一网络。打开下方地址，输入连接码。声音由电脑播放。</p>
      {status.addresses.map((address) => <label key={address}>{address.includes("127.0.0.1") ? "本机预览" : "手机访问地址"}<input readOnly value={address} onFocus={(e) => e.target.select()} /></label>)}
      {!primary && <p>未识别到局域网地址，可使用电脑的 IPv4 地址加 :19653 访问。</p>}
      <label>连接码<input readOnly value={status.pairingCode ?? ""} onFocus={(e) => e.target.select()} /></label>
      <button type="button" onClick={() => { void navigator.clipboard.writeText(link).then(() => setCopied(true), () => setError("复制失败，请选中地址和连接码手动复制")); }}>{copied ? "连接链接已复制" : "复制含连接码的链接"}</button>
      <p>仅在可信局域网使用。关闭即断开所有设备；重启默认关闭。若无法连接，请检查专用网络防火墙与访客 Wi-Fi 隔离。</p>
    </div>}
    {!native && <span className="section-label">请在桌面版开启</span>}
    {error && <span className="fixture-menu__error" role="alert">{error}</span>}
  </>;
}
