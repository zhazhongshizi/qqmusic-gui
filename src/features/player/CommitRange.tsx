import { useRef, useState, type CSSProperties, type InputHTMLAttributes } from "react";

const RANGE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** Preview a gesture locally and send one confirmed value at its end. */
export function CommitRange({ value, onCommit, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const draftRef = useRef<number | null>(null);
  const gesture = useRef<"pointer" | "keyboard" | null>(null);
  function cancel() { gesture.current = null; draftRef.current = null; setDraft(null); }
  function commit() {
    const next = draftRef.current;
    cancel();
    if (next !== null) onCommit(next);
  }
  return <input {...props} type="range" value={draft ?? value}
    style={{ ...props.style, "--range-progress": `${((draft ?? value) - Number(props.min ?? 0)) / Math.max(1e-9, Number(props.max ?? 100) - Number(props.min ?? 0)) * 100}%` } as CSSProperties}
    onChange={event => {
      const next = Number(event.currentTarget.value);
      if (!gesture.current) { onCommit(next); return; }
      draftRef.current = next; setDraft(next);
    }}
    onPointerDown={event => {
      if (event.button > 0) return;
      gesture.current = "pointer";
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }}
    onPointerUp={commit}
    onPointerCancel={cancel}
    onLostPointerCapture={() => { if (gesture.current === "pointer") cancel(); }}
    onKeyDown={event => {
      if (RANGE_KEYS.has(event.key)) gesture.current = "keyboard";
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
    }}
    onKeyUp={event => { if (RANGE_KEYS.has(event.key)) commit(); }}
    onBlur={commit}
  />;
}
