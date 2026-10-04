import { useEffect, useState } from "react";
import { getSmartShuffleStatus, setSmartShuffleEnabled, type SmartShuffleStatus } from "../../backend/smartShuffleAdapter";

export function SmartShuffleToggle({ presentation = "menu" }: { presentation?: "menu" | "rhine" }) {
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [status, setStatus] = useState<SmartShuffleStatus>({ enabled: false, likesLoaded: false });
  const [busy, setBusy] = useState(native);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!native) return;
    let active = true;
    void getSmartShuffleStatus().then(
      (value) => { if (active) setStatus(value); },
      () => { if (active) setError(true); },
    ).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [native]);

  async function toggle() {
    setBusy(true);
    setError(false);
    try { setStatus(await setSmartShuffleEnabled(!status.enabled)); }
    catch { setError(true); }
    finally { setBusy(false); }
  }

  const statusText = !native ? "请在桌面版试用" : status.enabled
    ? status.likesLoaded ? "已开启 · 随机模式生效 · 下次启动保持开启" : "已开启时间加权 · 开关已保存，喜欢列表暂未同步"
    : "已关闭 · 开关自动保存，开启后久未听优先";
  const control = <button type="button" role={presentation === "rhine" ? "switch" : "menuitemcheckbox"} aria-checked={status.enabled}
      aria-label="智能随机 · 遗忘度" className={presentation === "rhine" ? "rhine-smart-shuffle-button" : undefined}
      disabled={!native || busy} onClick={() => void toggle()}
      title="仅影响随机播放：久未听和喜欢的歌曲适当优先，减少近期重复。自动保存开关，下次启动沿用。">
      <span>{busy ? "智能随机：正在读取…" : "智能随机 · 遗忘度"}</span><i aria-hidden="true" />
    </button>;
  if (presentation === "rhine") return <div className="rhine-smart-shuffle">
    <p className="rhine-eyebrow">实验性功能</p>{control}
    <p className="rhine-settings-note" role="status">{statusText}</p>
    <p className="rhine-settings-note">仅影响随机播放：久未听和喜欢的歌曲适当优先，减少近期重复。开关自动保存，与普通界面共用。</p>
    {error && <p className="rhine-smart-shuffle-error" role="alert">智能随机设置失败，请重试</p>}
  </div>;
  return <>
    <div className="fixture-menu__divider" role="separator" />
    <span className="section-label" role="presentation">实验性功能</span>
    {control}<span className="section-label" role="status">{statusText}</span>
    {error && <span className="fixture-menu__error" role="alert">智能随机设置失败，请重试</span>}
  </>;
}
