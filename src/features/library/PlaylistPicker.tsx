import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../../components/Icon";

export type PlaylistPickerOption = {
  id: string;
  title: string;
};

export type PlaylistPickerProps = {
  options: readonly PlaylistPickerOption[];
  value: string;
  onChange: (playlistId: string) => void;
  label: string;
};

type Placement = "top" | "bottom";

type PickerPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: Placement;
};

const OPTION_HEIGHT = 40;
const MAX_MENU_HEIGHT = OPTION_HEIGHT * 6;
const VIEWPORT_MARGIN = 8;
const MENU_GAP = 4;
const EMPTY_TITLE = "未命名歌单";

function safeTitle(title: string) {
  return title.trim() || EMPTY_TITLE;
}

function optionDomId(pickerId: string, option: PlaylistPickerOption, index: number) {
  const safeId = option.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${pickerId}-option-${safeId || "item"}-${index}`;
}

export default function PlaylistPicker({ options, value, onChange, label }: PlaylistPickerProps) {
  const pickerId = useId().replace(/:/g, "");
  const triggerId = `playlist-picker-${pickerId}`;
  const listboxId = `${triggerId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const activeIndexRef = useRef(0);
  const restoreFocusFrame = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<PickerPosition | null>(null);

  const setActive = useCallback((nextIndex: number) => {
    activeIndexRef.current = nextIndex;
    setActiveIndex(nextIndex);
  }, []);

  const selectedIndex = options.findIndex((option) => option.id === value);
  const effectiveSelectedIndex = selectedIndex >= 0 ? selectedIndex : (options.length > 0 ? 0 : -1);
  const displayOption = options[effectiveSelectedIndex];
  const displayTitle = displayOption ? safeTitle(displayOption.title) : "请选择歌单";

  const restoreFocus = useCallback(() => {
    if (restoreFocusFrame.current !== null) {
      window.cancelAnimationFrame(restoreFocusFrame.current);
    }
    restoreFocusFrame.current = window.requestAnimationFrame(() => {
      restoreFocusFrame.current = null;
      triggerRef.current?.focus();
    });
  }, []);

  const closePicker = useCallback(() => {
    setOpen(false);
    setPosition(null);
    triggerRef.current?.focus();
    restoreFocus();
  }, [restoreFocus]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || options.length === 0) return;

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const desiredHeight = Math.min(MAX_MENU_HEIGHT, options.length * OPTION_HEIGHT);
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom - VIEWPORT_MARGIN - MENU_GAP);
    const spaceAbove = Math.max(0, rect.top - VIEWPORT_MARGIN - MENU_GAP);
    const placement: Placement = spaceBelow >= desiredHeight || spaceBelow >= spaceAbove ? "bottom" : "top";
    const availableHeight = placement === "bottom" ? spaceBelow : spaceAbove;
    const maxHeight = Math.min(desiredHeight, availableHeight);
    const width = Math.max(0, rect.width);
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.left),
      Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN),
    );
    const unclampedTop = placement === "bottom"
      ? rect.bottom + MENU_GAP
      : rect.top - MENU_GAP - maxHeight;
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, unclampedTop),
      Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - maxHeight),
    );

    setPosition({ top, left, width, maxHeight, placement });
  }, [options.length]);

  useEffect(() => {
    if (!open) return;

    updatePosition();
    const handleViewportChange = () => updatePosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("scroll", handleViewportChange);
    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || listboxRef.current?.contains(target)) return;
      closePicker();
    };
    document.addEventListener("pointerdown", handleDocumentClick, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.visualViewport?.removeEventListener("resize", handleViewportChange);
      window.visualViewport?.removeEventListener("scroll", handleViewportChange);
      document.removeEventListener("pointerdown", handleDocumentClick, true);
    };
  }, [closePicker, open, updatePosition]);

  useEffect(() => {
    if (!open || options.length === 0) return;
    if (activeIndexRef.current >= options.length) {
      setActive(options.length - 1);
    }
  }, [open, options.length, setActive]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  useEffect(() => () => {
    if (restoreFocusFrame.current !== null) {
      window.cancelAnimationFrame(restoreFocusFrame.current);
    }
  }, []);

  const openPicker = useCallback(() => {
    if (options.length === 0) return;
    setActive(effectiveSelectedIndex >= 0 ? effectiveSelectedIndex : 0);
    setOpen(true);
  }, [effectiveSelectedIndex, options.length, setActive]);

  const chooseIndex = useCallback((index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.id);
    closePicker();
  }, [closePicker, onChange, options]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!open) return;
    if (options.length === 0) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((activeIndexRef.current + 1) % options.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((activeIndexRef.current - 1 + options.length) % options.length);
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
      case "Space":
      case "Spacebar":
        event.preventDefault();
        {
          const activeId = event.currentTarget.getAttribute("aria-activedescendant");
          const activeSuffix = activeId?.match(/-(\d+)$/);
          const domIndex = activeSuffix ? Number(activeSuffix[1]) : -1;
          chooseIndex(domIndex >= 0 ? domIndex : activeIndexRef.current);
        }
        break;
      case "Escape":
        event.preventDefault();
        closePicker();
        break;
      default:
        break;
    }
  }, [chooseIndex, closePicker, open, options.length, setActive]);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [closePicker, open]);

  const menu = open && position && typeof document !== "undefined"
    ? createPortal(
        <div
          aria-label={label}
          className="playlist-picker__menu"
          data-placement={position.placement}
          data-scrollable={options.length * OPTION_HEIGHT > position.maxHeight ? "true" : "false"}
          id={listboxId}
          onKeyDown={handleKeyDown}
          ref={listboxRef}
          role="listbox"
          style={{
            left: `${position.left}px`,
            maxHeight: `${position.maxHeight}px`,
            top: `${position.top}px`,
            width: `${position.width}px`,
          }}
          tabIndex={-1}
        >
          {options.map((option, index) => {
            const optionId = optionDomId(triggerId, option, index);
            return (
              <div
                aria-selected={index === effectiveSelectedIndex}
                className="playlist-picker__option"
                data-active={index === activeIndex ? "true" : "false"}
                id={optionId}
                key={option.id}
                onClick={() => chooseIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                ref={(element) => { optionRefs.current[index] = element; }}
                role="option"
              >
                <span className="playlist-picker__option-title" title={safeTitle(option.title)}>{safeTitle(option.title)}</span>
                <span aria-hidden="true" className="playlist-picker__check">✓</span>
              </div>
            );
          })}
        </div>,
        document.body,
      )
    : null;

  const activeOption = options[activeIndex];
  const activeOptionId = activeOption ? optionDomId(triggerId, activeOption, activeIndex) : undefined;

  return (
    <div className="playlist-picker">
      <button
        aria-activedescendant={open ? activeOptionId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${label}：${displayTitle}`}
        aria-controls={listboxId}
        className="playlist-picker__trigger"
        disabled={options.length === 0}
        id={triggerId}
        onClick={() => { if (open) closePicker(); else openPicker(); }}
        onKeyDown={handleKeyDown}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        <span className="playlist-picker__value" title={displayTitle}>{displayTitle}</span>
        <Icon name="down" size={16} />
      </button>
      {menu}
    </div>
  );
}
