import { useEffect, useRef, type CSSProperties } from "react";
import { Icon } from "../../components/Icon";
import { DeckCaption } from "./DeckCaption";
import { DeckOutroPreview } from "./DeckOutroPreview";
import { localMusicFormatFromId } from "../../contracts/localMusic";
import { PlaybackQualitySelector } from "../player/PlaybackQualitySelector";
import { MvLyricOffsetControl } from "../player/MvPlaybackSettings";
import { getCurrentTrack, playerActions, usePlayerSelector, type PlaybackMode } from "../player/playerStore";

const modes: Record<PlaybackMode, string> = { sequence: "顺序播放", "repeat-all": "列表循环", "repeat-one": "单曲循环", shuffle: "随机播放" };
const time = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, "0")}:${Math.floor(ms / 1000 % 60).toString().padStart(2, "0")}`;

export function NowPlaying({ onOpen }: { onOpen: () => void }) {
  const track = usePlayerSelector(getCurrentTrack);
  const playing = usePlayerSelector(s => s.isPlaying);
  const error = usePlayerSelector(s => s.playbackError);
  if (!track) return null;
  return <div className="rhine-now">
    <button onClick={onOpen}><i data-playing={playing && !error} /><span>{error ? "播放异常" : playing ? "正在播放" : "已暂停"} / {track.title}</span><span>进入磁带机 ↗</span></button>
    <button aria-label={playing ? "暂停" : "播放"} onClick={playerActions.toggle}><Icon name={playing ? "pause" : "play"} size={14} /></button>
  </div>;
}

function DeckTimeline() {
  const track = usePlayerSelector(getCurrentTrack);
  const position = usePlayerSelector(s => s.positionMs);
  const duration = track?.durationMs ?? 0;
  return <div className="rhine-deck-timeline"><span>{time(position)}</span><input aria-label="播放进度" type="range" min={0} max={duration || 1} disabled={!duration} value={Math.min(position, duration)} onChange={e => playerActions.seek(Number(e.target.value))} style={{ "--range-progress": `${duration ? position / duration * 100 : 0}%` } as CSSProperties} /><span>{time(duration)}</span></div>;
}

function DeckLyric({ onOpen }: { onOpen: () => void }) {
  const track = usePlayerSelector(getCurrentTrack);
  const index = usePlayerSelector(s => {
    const lines = getCurrentTrack(s)?.lyrics ?? [];
    let i = lines.length - 1;
    while (i >= 0 && (lines[i]?.atMs ?? Infinity) > s.positionMs) i--;
    return i;
  });
  const lines = track?.lyrics ?? [];
  const line = lines[index];
  if (!line?.original.trim()) return null;
  return <button className="rhine-deck-lyric" onClick={onOpen} aria-label="展开完整歌词"><span>{line.original}</span>{line.translation?.trim() && <small>{line.translation}</small>}</button>;
}

function VolumeDial() {
  const volume = usePlayerSelector(s => s.volume);
  const muted = usePlayerSelector(s => s.muted);
  const drag = useRef<{ x: number; y: number; value: number } | null>(null);
  const value = muted ? 0 : volume;
  return <div className="rhine-deck-volume">
    <button aria-label={muted ? "取消静音" : "静音"} onClick={playerActions.toggleMute}><Icon name={muted ? "mute" : "volume"} size={15} /></button>
    <div className="rhine-volume-dial" style={{ "--dial-angle": `${-135 + value * 270}deg` } as CSSProperties}>
      <span className="rhine-volume-knob" aria-hidden="true"><i /></span>
      <input aria-label="音量" aria-valuetext={`${Math.round(value * 100)}%`} title="音量：上下或左右拖动，也可使用方向键" type="range" min={0} max={1} step={0.01} value={value}
        onChange={e => playerActions.setVolume(Number(e.target.value))}
        onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, value }; }}
        onPointerMove={e => { const start = drag.current; if (!start) return; playerActions.setVolume(Math.min(1, Math.max(0, start.value + (e.clientX - start.x + start.y - e.clientY) / 160))); }}
        onPointerUp={e => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} />
    </div>
    <span className="rhine-volume-reading" aria-hidden="true">{Math.round(value * 100).toString().padStart(2, "0")}</span>
  </div>;
}

export function TapeDeck({ playlistTitle, onBack, onLyrics, onQueue }: { playlistTitle?: string; onBack: () => void; onLyrics: () => void; onQueue: () => void }) {
  const track = usePlayerSelector(getCurrentTrack);
  const playing = usePlayerSelector(s => s.isPlaying);
  const error = usePlayerSelector(s => s.playbackError);
  const mode = usePlayerSelector(s => s.mode);
  const queueLength = usePlayerSelector(s => s.queue.length);
  const requestedQuality = usePlayerSelector(s => s.requestedQuality);
  const previousRestartsTrack = usePlayerSelector(s => s.positionMs > 5000);
  const captionIntent = useRef({ direction: 0, until: 0 });
  useEffect(() => { captionIntent.current = { direction: 0, until: 0 }; }, [track?.id]);
  function changeTrack(direction: number) {
    captionIntent.current = { direction: direction < 0 && previousRestartsTrack ? 0 : direction, until: performance.now() + 3000 };
    if (direction < 0) playerActions.previous(); else playerActions.next();
  }
  return <section className="rhine-deck" aria-label="磁带机" data-playing={playing && !error}>
    <button className="rhine-deck-back" onClick={onBack}>↙ 返回音乐档案</button>
    <DeckCaption track={track ?? null} playlistTitle={playlistTitle} direction={() => performance.now() < captionIntent.current.until ? captionIntent.current.direction : 0} />
    <DeckOutroPreview />
    <div className="rhine-deck-rail" aria-hidden="true"><span>RL—01</span><i /><span>STEREO<br />TRANSPORT</span></div>
    <div className="rhine-deck-console">
      <DeckLyric onOpen={onLyrics} />
      <div className="rhine-deck-hardware">
        <div className="rhine-deck-display"><span><i />{error ? "播放异常" : playing ? "正在播放" : "已暂停"}</span><span title={track?.actualQuality === "QQ MV 音轨" ? "正在播放关联 MV 的声音，歌词可能与 MV 时间不同步" : undefined}>{track?.actualQuality === "QQ MV 音轨" ? "QQ MV 音轨" : "RL–01 / 磁带读取器"}</span></div>
        {error && <div className="rhine-deck-error" role="alert">{error.message}<button onClick={playerActions.retryPlayback}>重试播放</button></div>}
        <DeckTimeline />
        <div className="rhine-deck-controls">
          <button className="rhine-deck-mode" onClick={playerActions.cycleMode} aria-label={`${modes[mode]}，点击切换模式`}><Icon name={mode === "shuffle" ? "shuffle" : "repeat"} size={16} /><span>{modes[mode]}</span></button>
          <div className="rhine-deck-keys"><button aria-label="上一首" disabled={!track} onClick={() => changeTrack(-1)}><Icon name="previous" size={21} /><small>REW</small></button><button className="rhine-deck-play" aria-label={playing ? "暂停" : "播放"} disabled={!track} onClick={playerActions.toggle}><Icon name={playing ? "pause" : "play"} size={24} /><small>{playing ? "PAUSE" : "PLAY"}</small></button><button aria-label="下一首" disabled={!track} onClick={() => changeTrack(1)}><Icon name="next" size={21} /><small>FWD</small></button></div>
          <VolumeDial />
        </div>
        <div className="rhine-deck-foot">
          <div className="rhine-deck-quality" aria-label="播放质量">
            <span>实际 {track?.actualQuality ?? "未知音质"}</span>
            {track && (localMusicFormatFromId(track.id)
              ? <span>本地文件</span>
              : <PlaybackQualitySelector key={track.id} quality={requestedQuality} variant="rhine" />)}
          </div>
          <button onClick={onQueue}>播放队列 / {String(queueLength).padStart(2, "0")} ↗</button>
        </div>
        <MvLyricOffsetControl />
      </div>
    </div>
  </section>;
}
