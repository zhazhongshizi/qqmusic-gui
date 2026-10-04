import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../../components/Icon";
import { AlbumArtwork } from "../stage/AlbumArtwork";
import {
  getCurrentTrack,
  playerActions,
  usePlayerSelector,
  type PlayerSnapshot,
} from "./playerStore";
import { useQueueDragReorder } from "./useQueueDragReorder";
import { SongArtistLinks } from "../artist/SongArtistLinks";
import { SavedQueues } from "../library/PersonalLibrary";
import { hasPlaybackTransport } from "../../backend/playbackTransport";

const selectQueue = (snapshot: PlayerSnapshot) => snapshot.queue;
const selectNativeMode = (snapshot: PlayerSnapshot) => snapshot.nativeMode;

const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "summary",
  "[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
const QUEUE_PAGE_SIZE = 30;

interface QueueDrawerProps {
  open: boolean;
  onClose: () => void;
  editable?: boolean;
  presentation?: "drawer" | "rhine-detail";
}

export function QueueDrawer({ open, onClose, editable = true, presentation = "drawer" }: QueueDrawerProps) {
  const queue = usePlayerSelector(selectQueue);
  const currentTrack = usePlayerSelector(getCurrentTrack);
  const nativeMode = usePlayerSelector(selectNativeMode);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [rhinePage, setRhinePage] = useState(1);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const queueListRef = useRef<HTMLOListElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const wasRhineOpenRef = useRef(false);
  const previousListViewRef = useRef({ page: 1, query: "" });
  const filteredQueue = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return queue.map((track, index) => ({ track, index })).filter(({ track }) =>
      !query || `${track.title}\n${track.artist}\n${track.album}`.toLocaleLowerCase().includes(query));
  }, [queue, searchQuery]);
  const pageCount = Math.max(1, Math.ceil(filteredQueue.length / QUEUE_PAGE_SIZE));
  const currentPage = Math.min(rhinePage, pageCount);
  const pageOffset = (currentPage - 1) * QUEUE_PAGE_SIZE;
  const visibleQueue = useMemo(() => filteredQueue.slice(pageOffset, pageOffset + QUEUE_PAGE_SIZE), [filteredQueue, pageOffset]);
  const dragItemIds = useMemo(() => visibleQueue.map(({ track }) => track.id), [visibleQueue]);
  const drag = useQueueDragReorder({
    disabled: !editable || queue.length < 2 || !!searchQuery.trim(),
    itemIds: dragItemIds,
    indexOffset: pageOffset,
    onMove: (trackId, targetIndex) => playerActions.moveTrackTo(
      trackId,
      Math.min(targetIndex + pageOffset, queue.length - 1),
    ),
    scrollContainerRef: dialogRef,
  });
  const dragTrack = drag.dragView
    ? queue.find((track) => track.id === drag.dragView?.trackId) ?? null
    : null;

  useEffect(() => {
    if (open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      wasOpenRef.current = true;
      if (presentation === "drawer") closeButtonRef.current?.focus();
      else dialogRef.current?.focus();
      return;
    }

    if (wasOpenRef.current) {
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
      wasOpenRef.current = false;
    }
  }, [open, presentation]);

  useEffect(() => {
    if (!open) {
      wasRhineOpenRef.current = false;
      return;
    }
    if (wasRhineOpenRef.current) return;
    wasRhineOpenRef.current = true;
    if (searchQuery.trim()) return;
    const currentIndex = currentTrack
      ? queue.findIndex((track) => track.id === currentTrack.id)
      : -1;
    setRhinePage(currentIndex >= 0
      ? Math.floor(currentIndex / QUEUE_PAGE_SIZE) + 1
      : 1);
  }, [currentTrack?.id, open, presentation, queue, searchQuery]);

  useEffect(() => {
    setRhinePage((page) => Math.min(page, pageCount));
  }, [pageCount]);

  useEffect(() => {
    const previous = previousListViewRef.current;
    if (
      open
      && (previous.page !== currentPage || previous.query !== searchQuery)
    ) {
      queueListRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }
    previousListViewRef.current = { page: currentPage, query: searchQuery };
  }, [currentPage, open, presentation, searchQuery]);

  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key !== "Tab" || presentation !== "drawer") return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    ).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true"
      && (!element.closest("details:not([open])") || element.tagName === "SUMMARY"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  const queueList = queue.length === 0 ? (
    <div className="queue-list__empty" role="status">
      <strong>播放队列为空</strong>
      <span>从歌曲或歌单中添加歌曲后会显示在这里。</span>
    </div>
  ) : visibleQueue.length === 0 ? (
    <p className="rhine-search-empty" role="status">播放队列中没有匹配的歌曲。</p>
  ) : (
    <ol className={presentation === "rhine-detail" ? "queue-list rhine-queue-list rhine-songs" : "queue-list"} ref={queueListRef}>
      {visibleQueue.map(({ track, index }, visibleIndex) => {
        const active = track.id === currentTrack?.id;
        const dragging = drag.dragView?.trackId === track.id;
        const indicatorBefore = drag.dragView?.indicatorTrackId === track.id
          && drag.dragView.indicatorEdge === "before";
        const indicatorAfter = drag.dragView?.indicatorTrackId === track.id
          && drag.dragView.indicatorEdge === "after";
        const itemClassName = [
          "queue-list__item",
          active ? "queue-list__item--active" : "",
          dragging ? "queue-list__item--dragging" : "",
          indicatorBefore ? "queue-list__item--drop-before" : "",
          indicatorAfter ? "queue-list__item--drop-after" : "",
        ].filter(Boolean).join(" ");
        return (
          <li
            className={itemClassName}
            data-playing={active}
            data-queue-track-id={track.id}
            key={track.id}
            onClickCapture={drag.onClickCapture}
            onDragStart={(event) => event.preventDefault()}
            onPointerDown={(event) => drag.onPointerDown(
              event,
              track.id,
              track.title,
              visibleIndex,
            )}
          >
            <AlbumArtwork compact track={track} />
            <div className="queue-list__info">
            <button
              aria-current={active ? "true" : undefined}
              className="queue-list__track"
              onClick={async () => {
                const started = await playerActions.playTrack(track.id);
                if (started && presentation === "rhine-detail") onClose();
              }}
              type="button"
            >
              <span className="queue-list__index">{active ? <Icon name="play" size={13} /> : String(index + 1).padStart(2, "0")}</span>
              <span>
                <strong>{track.title}</strong>
              </span>
            </button>
            <small><SongArtistLinks track={track} /> · {presentation === "rhine-detail" ? track.album || track.actualQuality : track.actualQuality}</small>
            </div>
            <div className="queue-list__actions" hidden={!editable}>
              <button
                aria-label={`上移《${track.title}》`}
                className="mini-button"
                disabled={index === 0}
                onClick={() => playerActions.moveTrack(track.id, -1)}
                type="button"
              >
                <Icon name="up" size={16} />
              </button>
              <button
                aria-label={`下移《${track.title}》`}
                className="mini-button"
                disabled={index === queue.length - 1}
                onClick={() => playerActions.moveTrack(track.id, 1)}
                type="button"
              >
                <Icon name="down" size={16} />
              </button>
              <button
                aria-label={`从队列移除《${track.title}》`}
                className="mini-button mini-button--danger"
                disabled={!nativeMode && queue.length <= 1}
                onClick={() => playerActions.removeTrack(track.id)}
                type="button"
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
  const dragPreview = dragTrack ? createPortal(
    <div aria-hidden="true" className="queue-drag-preview" ref={drag.previewRef}>
      <AlbumArtwork compact track={dragTrack} />
      <span>
        <strong>{dragTrack.title}</strong>
        <small>{dragTrack.artist} · {dragTrack.actualQuality}</small>
      </span>
    </div>,
    document.body,
  ) : null;

  if (presentation === "rhine-detail") {
    return <>
      <section
        aria-labelledby="player-queue-title"
        aria-label="播放队列详情"
        className="rhine-document rhine-playlist-document rhine-queue-document"
        id="player-queue-dialog"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="region"
        tabIndex={-1}
      >
        <button className="rhine-back" onClick={onClose} type="button">← 返回磁带机</button>
        <div className="rhine-queue-document__heading">
          <div><p className="rhine-eyebrow">UP NEXT / LOCAL QUEUE</p><h2 id="player-queue-title">播放队列</h2></div>
          <button
            aria-label="清空播放队列"
            className="queue-drawer__clear"
            disabled={queue.length === 0}
            hidden={!editable}
            onClick={() => playerActions.clearQueue()}
            type="button"
          ><Icon name="trash" size={15} /><span>清空</span></button>
        </div>
        <p className="rhine-queue-document__summary">{queue.length} 首 · 本地队列</p>
        {hasPlaybackTransport() && <SavedQueues compact />}
        <div className="rhine-document-actions rhine-queue-document__actions">
          <span>{queue.length} 首歌曲</span>
          <button disabled={queue.length === 0} onClick={async () => { const first = queue[0]; if (first && await playerActions.playTrack(first.id)) onClose(); }} type="button">播放全部</button>
        </div>
        <form className="rhine-playlist-search rhine-search-form" onSubmit={(event) => { event.preventDefault(); setRhinePage(1); setSearchQuery(searchInput.trim()); }}>
          <input aria-label="在播放队列搜索" maxLength={100} onChange={(event) => setSearchInput(event.target.value)} placeholder="在此队列搜索歌曲、歌手或专辑" type="search" value={searchInput} />
          <button disabled={!searchInput.trim()} type="submit">搜索</button>
          {searchQuery && <button onClick={() => { setSearchInput(""); setSearchQuery(""); setRhinePage(1); }} type="button">清除</button>}
        </form>
        {searchQuery && <p className="rhine-search-count" role="status">“{searchQuery}” · {filteredQueue.length} 首匹配</p>}
        <p className="rhine-queue-document__current" role="status">{currentTrack ? `正在播放：${currentTrack.title} · ${currentTrack.artist}` : "当前没有正在播放的歌曲"}</p>
        {queueList}
        {queue.length > 0 && <nav aria-label="播放队列分页" className="rhine-pages">
          <button disabled={currentPage <= 1} onClick={() => setRhinePage((page) => Math.max(1, page - 1))} type="button">上一页</button>
          <span>第 {currentPage} / {pageCount} 页 · 共 {filteredQueue.length} 首</span>
          <button disabled={currentPage >= pageCount} onClick={() => setRhinePage((page) => Math.min(pageCount, page + 1))} type="button">下一页</button>
        </nav>}
        {dragPreview}
        <p aria-live="polite" className="sr-only">{drag.announcement}</p>
        <p className="queue-drawer__hint">长按歌曲可拖动排序；也可使用按钮精确移动。</p>
      </section>
    </>;
  }

  return (
    <>
      <div aria-hidden="true" className="queue-scrim" onClick={onClose} />
      <section
        aria-labelledby="player-queue-title"
        aria-modal="true"
        className="queue-drawer"
        id="player-queue-dialog"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="queue-drawer__header">
          <div>
            <span className="section-label">UP NEXT</span>
            <h2 id="player-queue-title">播放队列</h2>
          </div>
          <div className="queue-drawer__header-actions">
            <button
              aria-label="关闭播放队列"
              className="icon-button icon-button--quiet"
              onClick={onClose}
              ref={closeButtonRef}
              type="button"
            >
              <Icon name="close" />
            </button>
            <button
              hidden={!editable}
              aria-label="清空播放队列"
              className="queue-drawer__clear"
              disabled={queue.length === 0}
              onClick={() => playerActions.clearQueue()}
              type="button"
            >
              <Icon name="trash" size={15} />
              <span>清空</span>
            </button>
          </div>
        </header>
        <p className="queue-drawer__summary">{queue.length} 首 · 本地队列</p>
        {hasPlaybackTransport() && <SavedQueues compact />}
        {queueList}
        {pageCount > 1 && <nav className="queue-drawer__pages" aria-label="队列分页">
          <button type="button" disabled={currentPage <= 1} onClick={() => setRhinePage(page => page - 1)}>上一页</button>
          <span>第 {currentPage} / {pageCount} 页</span>
          <button type="button" disabled={currentPage >= pageCount} onClick={() => setRhinePage(page => page + 1)}>下一页</button>
        </nav>}
        {dragPreview}
        <p aria-live="polite" className="sr-only">
          {drag.announcement}
        </p>
        <p className="queue-drawer__hint">
          {!editable ? "点击歌曲可在电脑上播放；队列整理请在电脑端完成。" : nativeMode ? "长按歌曲可拖动排序，顺序会保存在本地。" : "长按歌曲可拖动排序；也可使用按钮精确移动。"}
        </p>
      </section>
    </>
  );
}
