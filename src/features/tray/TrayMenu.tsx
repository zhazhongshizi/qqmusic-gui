import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { getCoverImage } from "../../backend/coverAdapter";
import {
  listenTrayMenuHidden,
  listenTrayMenuShown,
  sendTrayMenuAction,
  type TrayMenuAction,
} from "../../backend/trayMenuAdapter";
import { nativePlaybackSessionSnapshot } from "../../backend/nativeQueueAdapter";
import type { PlayerSnapshot, TrackSummary } from "../../contracts/appSnapshot";
import type { PlaybackSessionSnapshot, QueueTrack } from "../../contracts/queue";
import { Icon } from "../../components/Icon";
import "../../styles/tray-menu.css";

const REFRESH_INTERVAL_MS = 500;
const TRANSPORT_ACTIONS = new Set<TrayMenuAction>(["togglePlayback", "previous", "next"]);

type TrayTrack = Pick<QueueTrack, "id" | "title" | "artist" | "coverCacheKey">;

export interface TrayViewModel {
  readonly track: TrayTrack | TrackSummary | null;
  readonly status: string;
  readonly state: "playing" | "loading" | "paused" | "ready" | "ended" | "failed" | "empty" | "error";
  readonly canTransport: boolean;
}

export function resolveTrayTrack(session: PlaybackSessionSnapshot): TrayTrack | TrackSummary | null {
  if (session.queue.items.length === 0) return null;

  if (session.player.currentTrack) {
    return session.queue.items.find((track) => track.id === session.player.currentTrack?.id)
      ?? session.player.currentTrack;
  }

  return session.queue.items[session.queue.selectedIndex ?? -1] ?? null;
}

export function trayViewModel(
  session: PlaybackSessionSnapshot | null,
  snapshotError: boolean,
): TrayViewModel {
  if (snapshotError || !session) {
    return { track: null, status: "暂时无法读取播放状态", state: "error", canTransport: false };
  }

  const track = resolveTrayTrack(session);
  if (!track) {
    return { track: null, status: "暂无待播放歌曲", state: "empty", canTransport: false };
  }

  switch (session.player.state) {
    case "playing":
      return { track, status: "正在播放", state: "playing", canTransport: true };
    case "loading":
      return { track, status: "正在载入", state: "loading", canTransport: true };
    case "paused":
      return { track, status: "已暂停", state: "paused", canTransport: true };
    case "ended":
      return { track, status: "播放结束", state: "ended", canTransport: true };
    case "failed":
      return { track, status: "播放中断", state: "failed", canTransport: true };
    case "idle":
    default:
      return { track, status: "准备播放", state: "ready", canTransport: true };
  }
}

function isPlayingState(state: TrayViewModel["state"]): boolean {
  return state === "playing" || state === "loading";
}

function safeRevoke(url: string | null): void {
  if (!url || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(url);
}

export function TrayMenu() {
  const rootRef = useRef<HTMLElement>(null);
  const playButtonRef = useRef<HTMLButtonElement>(null);
  const showMainButtonRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const epochRef = useRef(0);
  const requestRef = useRef<Promise<void> | null>(null);
  const focusRequestRef = useRef(false);
  const focusReadyRef = useRef(false);
  const coverUrlRef = useRef<string | null>(null);
  const [active, setActive] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [session, setSession] = useState<PlaybackSessionSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState(true);
  const [transportBusy, setTransportBusy] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [focusReadyVersion, setFocusReadyVersion] = useState(0);

  const refresh = useCallback((expectedEpoch = epochRef.current): Promise<void> => {
    if (!activeRef.current || expectedEpoch !== epochRef.current) return Promise.resolve();
    if (requestRef.current) return requestRef.current;

    const requestEpoch = epochRef.current;
    const request = nativePlaybackSessionSnapshot()
      .then((nextSession) => {
        if (!activeRef.current || requestEpoch !== epochRef.current) return;
        setSession(nextSession);
        setSnapshotError(false);
        focusReadyRef.current = true;
        if (focusRequestRef.current) setFocusReadyVersion((current) => current + 1);
      })
      .catch(() => {
        if (activeRef.current && requestEpoch === epochRef.current) {
          setSnapshotError(true);
          focusReadyRef.current = true;
          if (focusRequestRef.current) setFocusReadyVersion((current) => current + 1);
        }
      })
      .finally(() => {
        if (requestRef.current !== request) return;
        requestRef.current = null;
        if (activeRef.current && requestEpoch !== epochRef.current) void refresh(epochRef.current);
      });

    requestRef.current = request;
    return request;
  }, []);

  const stopRefreshing = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    activeRef.current = false;
    epochRef.current += 1;
    setActive(false);
    setEpoch(epochRef.current);
    safeRevoke(coverUrlRef.current);
    coverUrlRef.current = null;
    setCoverUrl(null);
  }, []);

  const startRefreshing = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    activeRef.current = true;
    epochRef.current += 1;
    const nextEpoch = epochRef.current;
    setActive(true);
    setEpoch(nextEpoch);
    setSnapshotError(true);
    setActionError(false);
    focusRequestRef.current = true;
    focusReadyRef.current = false;
    void refresh(nextEpoch);
    timerRef.current = window.setInterval(() => {
      void refresh(nextEpoch);
    }, REFRESH_INTERVAL_MS);
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    let shownUnlisten: (() => void) | null = null;
    let hiddenUnlisten: (() => void) | null = null;

    const installListeners = async () => {
      const results = await Promise.allSettled([
        listenTrayMenuShown(startRefreshing),
        listenTrayMenuHidden(stopRefreshing),
      ]);
      const shown = results[0];
      const hidden = results[1];
      if (shown?.status === "fulfilled") {
        if (disposed) shown.value();
        else shownUnlisten = shown.value;
      }
      if (hidden?.status === "fulfilled") {
        if (disposed) hidden.value();
        else hiddenUnlisten = hidden.value;
      }
    };

    void installListeners();
    return () => {
      disposed = true;
      stopRefreshing();
      shownUnlisten?.();
      hiddenUnlisten?.();
    };
  }, [startRefreshing, stopRefreshing]);

  const view = useMemo(() => trayViewModel(session, snapshotError), [session, snapshotError]);
  const coverKey = active ? view.track && "coverCacheKey" in view.track ? view.track.coverCacheKey : undefined : undefined;

  useEffect(() => {
    safeRevoke(coverUrlRef.current);
    coverUrlRef.current = null;
    setCoverUrl(null);
    if (!active || !coverKey) return;

    let cancelled = false;
    const requestEpoch = epoch;
    void getCoverImage(coverKey).then((payload) => {
      if (
        cancelled ||
        !activeRef.current ||
        requestEpoch !== epochRef.current ||
        typeof URL.createObjectURL !== "function"
      ) return;
      const bytes = payload.bytes.slice().buffer as ArrayBuffer;
      const nextUrl = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }));
      coverUrlRef.current = nextUrl;
      setCoverUrl(nextUrl);
    }).catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [active, coverKey, epoch]);

  useEffect(() => {
    if (!active || !focusRequestRef.current || !focusReadyRef.current) return;
    focusRequestRef.current = false;
    (view.canTransport ? playButtonRef.current : showMainButtonRef.current)?.focus();
  }, [active, focusReadyVersion, session, snapshotError, view.canTransport]);

  async function performAction(action: TrayMenuAction): Promise<void> {
    const transport = TRANSPORT_ACTIONS.has(action);
    if (transport && transportBusy) return;
    if (transport) setTransportBusy(true);
    setActionError(false);
    try {
      await sendTrayMenuAction(action);
      setActionError(false);
      if (transport) await refresh();
    } catch {
      setActionError(true);
    } finally {
      if (transport) setTransportBusy(false);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      void performAction("hide");
      return;
    }
    if (event.key !== "Tab") return;

    const buttons = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    if (buttons.length === 0) return;
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1)
      : (currentIndex === buttons.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    buttons[nextIndex]?.focus();
  }

  const playLabel = isPlayingState(view.state) ? "暂停" : "播放";
  const trackTitle = view.track?.title ?? "暂无待播放歌曲";
  const trackArtist = view.track?.artist ?? "打开主窗口以选择歌曲";

  return (
    <main
      aria-label="QQ Music GUI 托盘控制"
      className="tray-menu"
      data-state={view.state}
      onKeyDown={onKeyDown}
      ref={rootRef}
    >
      <section className="tray-menu__panel">
        <header className="tray-menu__track-card">
          <div aria-hidden="true" className={`tray-menu__cover${coverUrl ? "" : " tray-menu__cover--placeholder"}`}>
            {coverUrl ? <img alt="" src={coverUrl} /> : <span />}
          </div>
          <div className="tray-menu__track-copy">
            <div className="tray-menu__eyebrow"><span className="tray-menu__meter"><i /><i /><i /></span>NOW PLAYING</div>
            <div className="tray-menu__title" title={trackTitle}>{trackTitle}</div>
            <div className="tray-menu__artist" title={trackArtist}>{trackArtist}</div>
            <div className="tray-menu__status">{view.status}</div>
          </div>
        </header>

        <div aria-label="播放控制" className="tray-menu__transport" role="group">
          <button
            aria-label="上一首"
            className="tray-menu__transport-button tray-menu__transport-button--side"
            disabled={!view.canTransport || transportBusy}
            onClick={() => void performAction("previous")}
            type="button"
          >
            <Icon name="previous" size={18} />
          </button>
          <button
            aria-label={playLabel}
            className="tray-menu__transport-button tray-menu__transport-button--primary"
            disabled={!view.canTransport || transportBusy}
            onClick={() => void performAction("togglePlayback")}
            ref={playButtonRef}
            type="button"
          >
            <Icon name={playLabel === "暂停" ? "pause" : "play"} size={20} />
          </button>
          <button
            aria-label="下一首"
            className="tray-menu__transport-button tray-menu__transport-button--side"
            disabled={!view.canTransport || transportBusy}
            onClick={() => void performAction("next")}
            type="button"
          >
            <Icon name="next" size={18} />
          </button>
        </div>

        <div aria-live="polite" className="tray-menu__action-status">{actionError ? "操作未完成，请重试" : ""}</div>

        <div className="tray-menu__utility">
          <button className="tray-menu__utility-button" onClick={() => void performAction("showMain")} ref={showMainButtonRef} type="button">
            <Icon name="restore" size={16} />
            <span>打开主窗口</span>
          </button>
          <button className="tray-menu__utility-button tray-menu__utility-button--danger" onClick={() => void performAction("quit")} type="button">
            <Icon name="close" size={16} />
            <span>退出 QQ Music GUI</span>
          </button>
        </div>
      </section>
    </main>
  );
}

export default TrayMenu;
