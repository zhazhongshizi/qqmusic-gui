import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { PLAYBACK_QUALITY_OPTIONS, type PlaybackQuality } from "../../contracts/settings";
import { playerActions } from "./playerStore";

export function PlaybackQualitySelector({ quality, variant = "stage" }: { quality: PlaybackQuality; variant?: "stage" | "rhine" }) {
  const prefix = variant === "rhine" ? "rhine-deck-quality" : "stage__quality";
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!open && !busy && restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open, busy]);

  useEffect(() => {
    if (!open) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>("button[aria-checked='true']")
      ?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitemradio']") ?? [],
    );
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    let nextIndex: number | null = null;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    else if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      items[nextIndex]?.focus();
    }
  }

  const selectedLabel = PLAYBACK_QUALITY_OPTIONS.find((option) => option.value === quality)?.label ?? "高品质 320k";

  return (
    <div className={`${prefix}-control`} ref={rootRef}>
      <button
        aria-busy={busy}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`期望音质：${selectedLabel}`}
        className={`${prefix}-trigger`}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <span>期望 {selectedLabel}</span>
        <span aria-hidden="true" className={`${prefix}-chevron`}>⌄</span>
      </button>
      {open ? (
        <div
          aria-label="选择播放音质"
          className={`${prefix}-menu`}
          onBlur={(event) => {
            const nextTarget = event.relatedTarget;
            if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setOpen(false);
          }}
          onKeyDown={onKeyDown}
          role="menu"
        >
          {PLAYBACK_QUALITY_OPTIONS.map((option) => (
            <button
              aria-checked={quality === option.value}
              disabled={busy}
              key={option.value}
              onClick={() => {
                setBusy(true);
                void playerActions.changeQuality(option.value).then(
                  (changed) => {
                    if (!changed) return;
                    restoreFocus.current = true;
                    setOpen(false);
                  },
                  () => undefined,
                ).finally(() => setBusy(false));
              }}
              role="menuitemradio"
              tabIndex={quality === option.value ? 0 : -1}
              type="button"
            >
              <span>{option.label}</span>
              <i aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
