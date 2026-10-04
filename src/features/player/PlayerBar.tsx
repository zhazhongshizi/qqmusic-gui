import type { CSSProperties } from "react";

import { Icon } from "../../components/Icon";
import { SongArtistLinks } from "../artist/SongArtistLinks";
import { AlbumArtwork } from "../stage/AlbumArtwork";
import {
  getCurrentTrack,
  playerActions,
  usePlayerSelector,
  type PlayerSnapshot,
  type PlaybackMode,
} from "./playerStore";

interface PlayerBarProps {
  onOpenQueue: () => void;
  queueOpen: boolean;
}

const MODE_LABELS: Record<PlaybackMode, string> = {
  sequence: "顺序播放",
  "repeat-all": "列表循环",
  "repeat-one": "单曲循环",
  shuffle: "随机播放",
};

function formatTime(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

const selectPosition = (snapshot: PlayerSnapshot) => snapshot.positionMs;
const selectMode = (snapshot: PlayerSnapshot) => snapshot.mode;
const selectIsPlaying = (snapshot: PlayerSnapshot) => snapshot.isPlaying;
const selectMuted = (snapshot: PlayerSnapshot) => snapshot.muted;
const selectVolume = (snapshot: PlayerSnapshot) => snapshot.volume;
const selectQueueLength = (snapshot: PlayerSnapshot) => snapshot.queue.length;
const selectPlaybackError = (snapshot: PlayerSnapshot) => snapshot.playbackError;

function PlayerTimeline({ track }: { track: NonNullable<ReturnType<typeof getCurrentTrack>> }) {
  const positionMs = usePlayerSelector(selectPosition);
  return (
    <div className="player-bar__timeline">
      <span>{formatTime(positionMs)}</span>
      <input
        aria-label="播放进度"
        max={track.durationMs}
        min="0"
        onChange={(event) => playerActions.seek(Number(event.currentTarget.value))}
        style={{
          "--range-progress": `${track.durationMs === 0 ? 0 : (positionMs / track.durationMs) * 100}%`,
        } as CSSProperties}
        type="range"
        value={positionMs}
      />
      <span>{formatTime(track.durationMs)}</span>
    </div>
  );
}

export function PlayerBar({ onOpenQueue, queueOpen }: PlayerBarProps) {
  const track = usePlayerSelector(getCurrentTrack);
  const mode = usePlayerSelector(selectMode);
  const isPlaying = usePlayerSelector(selectIsPlaying);
  const muted = usePlayerSelector(selectMuted);
  const volume = usePlayerSelector(selectVolume);
  const queueLength = usePlayerSelector(selectQueueLength);
  const playbackError = usePlayerSelector(selectPlaybackError);

  if (!track) return null;

  const modeIcon = mode === "shuffle" ? "shuffle" : "repeat";

  return (
    <footer className="player-bar" aria-label="播放器控制">
      <div className="player-bar__track">
        <AlbumArtwork compact track={track} />
        <div>
          <strong>{track.title}</strong>
          <span><SongArtistLinks track={track} />{track.actualQuality === "QQ MV 音轨" ? " · QQ MV 音轨" : ""}</span>
        </div>
      </div>

      <div className="player-bar__center">
        {playbackError ? (
          <div className="player-bar__error" role="alert">
            <span>{playbackError.message}</span>
            <button className="text-button" onClick={playerActions.retryPlayback} type="button">重试播放</button>
          </div>
        ) : null}
        <PlayerTimeline track={track} />
        <div className="player-bar__transport">
          <button
            aria-label={`${MODE_LABELS[mode]}，点击切换模式`}
            className="icon-button icon-button--quiet player-bar__mode"
            onClick={playerActions.cycleMode}
            title={MODE_LABELS[mode]}
            type="button"
          >
            <Icon name={modeIcon} size={18} />
            <span>{mode === "repeat-one" ? "1" : null}</span>
          </button>
          <button aria-label="上一首" className="icon-button" onClick={playerActions.previous} type="button">
            <Icon name="previous" />
          </button>
          <button
            aria-label={isPlaying ? "暂停" : "播放"}
            className="icon-button player-bar__play"
            onClick={playerActions.toggle}
            type="button"
          >
            <Icon name={isPlaying ? "pause" : "play"} size={22} />
          </button>
          <button aria-label="下一首" className="icon-button" onClick={playerActions.next} type="button">
            <Icon name="next" />
          </button>
          <button
            aria-label={muted ? "取消静音" : "静音"}
            className="icon-button icon-button--quiet"
            onClick={playerActions.toggleMute}
            type="button"
          >
            <Icon name={muted ? "mute" : "volume"} size={18} />
          </button>
        </div>
      </div>

      <div className="player-bar__tools">
        <div className="player-bar__volume">
          <label className="sr-only" htmlFor="player-volume">音量</label>
          <input
            id="player-volume"
            max="1"
            min="0"
            onChange={(event) => playerActions.setVolume(Number(event.currentTarget.value))}
            step="0.01"
            style={{ "--range-progress": `${(muted ? 0 : volume) * 100}%` } as CSSProperties}
            type="range"
            value={muted ? 0 : volume}
          />
        </div>
        <button
          aria-controls="player-queue-dialog"
          aria-expanded={queueOpen}
          aria-label="打开播放队列"
          className="queue-button"
          onClick={onOpenQueue}
          type="button"
        >
          <Icon name="queue" size={18} />
          <span>{queueLength}</span>
        </button>
      </div>
    </footer>
  );
}
