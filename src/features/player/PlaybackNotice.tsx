import { createPortal } from "react-dom";
import { usePlayerSelector } from "./playerStore";
import "./playback-notice.css";

export function PlaybackNotice() {
  const message = usePlayerSelector(({ skipNotice }) => skipNotice
    ? `歌曲《${skipNotice.title}》无法播放，${skipNotice.exhausted ? "已停止自动切换，请稍后重试" : "将切换下一首"}`
    : null);
  return message ? createPortal(<div className="playback-notice" role="status" aria-live="polite">{message}</div>, document.body) : null;
}
