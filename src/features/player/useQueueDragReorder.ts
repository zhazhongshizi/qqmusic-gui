import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

const HOLD_DELAY_MS = 250;
const ARMING_TOLERANCE_PX = 8;
const AUTO_SCROLL_EDGE_PX = 64;
const AUTO_SCROLL_MAX_PX = 14;

type DropEdge = "before" | "after";

export interface QueueDragView {
  readonly indicatorEdge: DropEdge | null;
  readonly indicatorTrackId: string | null;
  readonly targetIndex: number;
  readonly trackId: string;
}

interface DragSession {
  readonly label: string;
  readonly pointerId: number;
  readonly row: HTMLElement;
  readonly startX: number;
  readonly startY: number;
  readonly trackId: string;
  holdTimer: number | null;
  phase: "armed" | "dragging";
  removeListeners: () => void;
  targetIndex: number;
}

interface QueueDragReorderOptions {
  readonly disabled?: boolean;
  readonly indexOffset?: number;
  readonly itemIds: readonly string[];
  readonly onMove: (trackId: string, targetIndex: number) => Promise<void>;
  readonly scrollContainerRef: RefObject<HTMLElement | null>;
}

function distanceFromStart(session: DragSession, event: PointerEvent) {
  return Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
}

function autoScrollVelocity(container: HTMLElement, clientY: number) {
  const bounds = container.getBoundingClientRect();
  if (clientY < bounds.top + AUTO_SCROLL_EDGE_PX) {
    const intensity = 1 - Math.max(0, clientY - bounds.top) / AUTO_SCROLL_EDGE_PX;
    return -AUTO_SCROLL_MAX_PX * Math.min(1, intensity);
  }
  if (clientY > bounds.bottom - AUTO_SCROLL_EDGE_PX) {
    const intensity = 1 - Math.max(0, bounds.bottom - clientY) / AUTO_SCROLL_EDGE_PX;
    return AUTO_SCROLL_MAX_PX * Math.min(1, intensity);
  }
  return 0;
}

export function useQueueDragReorder({
  disabled = false,
  indexOffset = 0,
  itemIds,
  onMove,
  scrollContainerRef,
}: QueueDragReorderOptions) {
  const [dragView, setDragView] = useState<QueueDragView | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const sessionRef = useRef<DragSession | null>(null);
  const itemIdsRef = useRef(itemIds);
  const itemSignatureRef = useRef(itemIds.join("\u0000"));
  const onMoveRef = useRef(onMove);
  const previewRef = useRef<HTMLDivElement>(null);
  const latestPointerRef = useRef({ x: 0, y: 0 });
  const autoScrollFrameRef = useRef<number | null>(null);
  const autoScrollVelocityRef = useRef(0);
  const committingRef = useRef(false);
  const mountedRef = useRef(true);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);

  itemIdsRef.current = itemIds;
  onMoveRef.current = onMove;

  function positionPreview(clientX: number, clientY: number) {
    latestPointerRef.current = { x: clientX, y: clientY };
    if (previewRef.current) {
      const left = Math.max(12, Math.min(clientX + 14, window.innerWidth - 274));
      const top = Math.max(12, Math.min(clientY + 14, window.innerHeight - 74));
      previewRef.current.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    }
  }

  function stopAutoScroll() {
    autoScrollVelocityRef.current = 0;
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }

  function updateDropTarget(clientY: number) {
    const session = sessionRef.current;
    const container = scrollContainerRef.current;
    if (!session || session.phase !== "dragging" || !container) return;

    const candidates = Array.from(
      container.querySelectorAll<HTMLElement>("[data-queue-track-id]"),
    ).filter((row) => row.dataset.queueTrackId !== session.trackId);
    let targetIndex = candidates.length;
    for (let index = 0; index < candidates.length; index += 1) {
      const row = candidates[index];
      if (row && clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2) {
        targetIndex = index;
        break;
      }
    }
    targetIndex = Math.max(0, Math.min(targetIndex, itemIdsRef.current.length - 1));
    const targetChanged = session.targetIndex !== targetIndex;
    session.targetIndex = targetIndex;

    const indicatorRow = candidates[targetIndex] ?? candidates.at(-1) ?? null;
    const indicatorEdge: DropEdge | null = indicatorRow
      ? (targetIndex >= candidates.length ? "after" : "before")
      : null;
    const indicatorTrackId = indicatorRow?.dataset.queueTrackId ?? null;
    setDragView((current) => {
      if (
        current
        && current.targetIndex === targetIndex
        && current.indicatorEdge === indicatorEdge
        && current.indicatorTrackId === indicatorTrackId
      ) {
        return current;
      }
      return {
        trackId: session.trackId,
        targetIndex,
        indicatorEdge,
        indicatorTrackId,
      };
    });
    if (targetChanged) setAnnouncement(`将《${session.label}》移动到第 ${targetIndex + indexOffset + 1} 位`);
  }

  function runAutoScrollFrame() {
    autoScrollFrameRef.current = null;
    const session = sessionRef.current;
    const container = scrollContainerRef.current;
    const velocity = autoScrollVelocityRef.current;
    if (!session || session.phase !== "dragging" || !container || velocity === 0) return;
    const previousScrollTop = container.scrollTop;
    container.scrollTop += velocity;
    if (container.scrollTop !== previousScrollTop) {
      updateDropTarget(latestPointerRef.current.y);
    }
    autoScrollFrameRef.current = requestAnimationFrame(runAutoScrollFrame);
  }

  function syncAutoScroll(clientY: number) {
    const container = scrollContainerRef.current;
    if (!container) return;
    autoScrollVelocityRef.current = autoScrollVelocity(container, clientY);
    if (autoScrollVelocityRef.current === 0) {
      stopAutoScroll();
    } else if (autoScrollFrameRef.current === null) {
      autoScrollFrameRef.current = requestAnimationFrame(runAutoScrollFrame);
    }
  }

  function clearSession(announce = "") {
    const session = sessionRef.current;
    if (session && session.holdTimer !== null) window.clearTimeout(session.holdTimer);
    if (
      session
      && typeof session.row.hasPointerCapture === "function"
      && session.row.hasPointerCapture(session.pointerId)
    ) {
      session.row.releasePointerCapture(session.pointerId);
    }
    session?.removeListeners();
    sessionRef.current = null;
    stopAutoScroll();
    setDragView(null);
    if (announce) setAnnouncement(announce);
  }

  function cancelSession() {
    const session = sessionRef.current;
    clearSession(session?.phase === "dragging" ? `已取消移动《${session.label}》` : "");
  }

  function activateDrag() {
    const session = sessionRef.current;
    if (!session || session.phase !== "armed") return;
    if (!itemIdsRef.current.includes(session.trackId)) {
      clearSession();
      return;
    }
    session.phase = "dragging";
    session.holdTimer = null;
    try {
      session.row.setPointerCapture(session.pointerId);
    } catch {
      // Window listeners keep the drag bounded even if pointer capture is unavailable.
    }
    positionPreview(latestPointerRef.current.x, latestPointerRef.current.y);
    updateDropTarget(latestPointerRef.current.y);
    setAnnouncement(`已拾取《${session.label}》`);
  }

  function onWindowPointerMove(event: PointerEvent) {
    const session = sessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    positionPreview(event.clientX, event.clientY);
    if (session.phase === "armed") {
      if (distanceFromStart(session, event) > ARMING_TOLERANCE_PX) clearSession();
      return;
    }
    event.preventDefault();
    updateDropTarget(event.clientY);
    syncAutoScroll(event.clientY);
  }

  function onWindowPointerUp(event: PointerEvent) {
    const session = sessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    if (session.phase === "armed") {
      clearSession();
      return;
    }

    event.preventDefault();
    suppressClickRef.current = true;
    if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      suppressClickTimerRef.current = null;
    }, 0);

    const currentIndex = itemIdsRef.current.indexOf(session.trackId);
    const targetIndex = session.targetIndex;
    const label = session.label;
    const shouldMove = currentIndex >= 0 && currentIndex !== targetIndex;
    clearSession(shouldMove ? `正在移动《${label}》` : `《${label}》位置未变`);
    if (!shouldMove) return;

    committingRef.current = true;
    void onMoveRef.current(session.trackId, targetIndex)
      .then(
        () => {
          if (mountedRef.current) setAnnouncement(`已将《${label}》移动到第 ${targetIndex + indexOffset + 1} 位`);
        },
        () => {
          if (mountedRef.current) setAnnouncement(`未能移动《${label}》，队列顺序保持不变`);
        },
      )
      .finally(() => {
        committingRef.current = false;
      });
  }

  function onWindowPointerCancel(event: PointerEvent) {
    const session = sessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    cancelSession();
  }

  function onWindowKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || sessionRef.current?.phase !== "dragging") return;
    event.preventDefault();
    event.stopPropagation();
    cancelSession();
  }

  function onPointerDown(
    event: ReactPointerEvent<HTMLElement>,
    trackId: string,
    label: string,
    index: number,
  ) {
    const target = event.target;
    if (
      disabled
      || committingRef.current
      || sessionRef.current
      || event.isPrimary === false
      || event.button !== 0
      || (target instanceof Element && target.closest(".queue-list__actions"))
    ) {
      return;
    }

    latestPointerRef.current = { x: event.clientX, y: event.clientY };
    const removeListeners = () => {
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerCancel);
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
    const session: DragSession = {
      phase: "armed",
      pointerId: event.pointerId,
      trackId,
      label,
      row: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      targetIndex: index,
      holdTimer: null,
      removeListeners,
    };
    session.holdTimer = window.setTimeout(activateDrag, HOLD_DELAY_MS);
    sessionRef.current = session;
    window.addEventListener("pointermove", onWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerCancel);
    window.addEventListener("keydown", onWindowKeyDown, true);
  }

  function onClickCapture(event: ReactMouseEvent<HTMLElement>) {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  }

  const itemSignature = itemIds.join("\u0000");
  useEffect(() => {
    const nextSignature = itemSignature;
    if (itemSignatureRef.current !== nextSignature && sessionRef.current) cancelSession();
    itemSignatureRef.current = nextSignature;
  }, [itemSignature]);

  useEffect(() => {
    if (!dragView) return;
    positionPreview(latestPointerRef.current.x, latestPointerRef.current.y);
  }, [dragView?.trackId]);

  useEffect(() => {
    document.body.classList.toggle("queue-drag-active", dragView !== null);
    return () => document.body.classList.remove("queue-drag-active");
  }, [dragView !== null]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearSession();
      if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
    };
  }, []);

  return {
    announcement,
    dragView,
    onClickCapture,
    onPointerDown,
    previewRef,
  };
}
