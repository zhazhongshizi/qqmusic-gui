import { useEffect, useState } from "react";
import { nativeSetMvFallbackEnabled, nativeSettingsSnapshot } from "../../backend/settingsAdapter";
import { getCurrentTrack, playerActions, usePlayerSelector } from "./playerStore";

export function MvFallbackSetting() {
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(native);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!native) return;
    let alive = true;
    void nativeSettingsSnapshot().then(settings => { if (alive) setEnabled(settings.mvFallbackEnabled ?? true); })
      .catch(() => { if (alive) setError("未能读取 MV 补播设置"); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [native]);
  return <div className="mv-fallback-setting">
    <label><input type="checkbox" checked={enabled} disabled={busy || !!error} onChange={event => {
      const next = event.target.checked;
      if (!native) { setEnabled(next); return; }
      setBusy(true);
      void nativeSetMvFallbackEnabled(next).then(settings => { setEnabled(settings.mvFallbackEnabled ?? next); setError(""); })
        .catch(() => setError("保存失败，请重新打开设置后重试"))
        .finally(() => setBusy(false));
    }} />原曲不可用时使用 QQ MV 音轨</label>
    <p>仅在原曲无法播放时尝试关联 MV；修改后从下次加载歌曲生效。</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function MvLyricOffsetControl() {
  const track = usePlayerSelector(getCurrentTrack);
  const offset = usePlayerSelector(s => s.lyricOffsetMs ?? 0);
  const native = usePlayerSelector(s => s.nativeMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setError(""); }, [track?.id]);
  if (!native || track?.actualQuality !== "QQ MV 音轨") return null;
  function change(value: number) {
    setBusy(true); setError("");
    void playerActions.setMvLyricOffset(value).catch(() => setError("歌词偏移保存失败，请重试"))
      .finally(() => setBusy(false));
  }
  return <div className="mv-lyric-offset" aria-label="MV 歌词同步">
    <span>MV 歌词 {offset === 0 ? "无偏移" : `${offset > 0 ? "延后" : "提前"} ${Math.abs(offset / 1000).toFixed(1)} 秒`}</span>
    <button type="button" disabled={busy || offset <= -60000} onClick={() => change(offset - 500)}>提前 0.5 秒</button>
    <button type="button" disabled={busy || offset >= 60000} onClick={() => change(offset + 500)}>延后 0.5 秒</button>
    <button type="button" disabled={busy || offset === 0} onClick={() => change(0)}>重置</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
