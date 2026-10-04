import { useEffect, useRef } from "react";
import { WindowControls } from "../../components/WindowControls";
import { BootSequence } from "./vendor/boot";
import { bootMarkup } from "./vendor/boot-markup";
import "./rhine-boot.css";

// Upstream starts on the white frame at video 6.76s (app time 1.76s).
const START = 1.76;
const END = 21.92;

export function RhineBoot({ active, onComplete }: { active: boolean; onComplete: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const elapsed = useRef(START);
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const finished = useRef(false);
  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    complete.current();
  };
  useEffect(() => {
    const host = root.current;
    const surface = stage.current;
    if (!host || !surface) return;
    // BootSequence owns these children; recreate them for StrictMode setup/cleanup.
    surface.innerHTML = bootMarkup;
    const sequence = new BootSequence(surface);
    const resize = () => {
      const scale = Math.min(host.clientWidth / 1920, host.clientHeight / 1080);
      surface.style.transform = `translate(-50%, -50%) scale(${scale})`;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let previous: number | null = null;
    const tick = (now: number) => {
      if (finished.current) return;
      if (previous !== null) elapsed.current += (now - previous) / 1000;
      previous = now;
      if (elapsed.current >= END) { finish(); return; }
      const state = sequence.update(elapsed.current);
      surface.dataset.boot = state.step;
      frame = requestAnimationFrame(tick);
    };
    const resume = () => {
      cancelAnimationFrame(frame);
      previous = null;
      if (finished.current || !active) return;
      if (motion.matches) { finish(); return; }
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };
    document.addEventListener("visibilitychange", resume);
    motion.addEventListener("change", resume);
    sequence.update(elapsed.current);
    resume();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", resume);
      motion.removeEventListener("change", resume);
      surface.replaceChildren();
    };
  }, [active]);
  return <div className="rhine-boot" ref={root} aria-label="莱茵启动动画" onKeyDown={event => {
    if (event.key === "Escape" || event.key === "Enter") { event.stopPropagation(); finish(); }
  }}>
    <div className="rhine-boot-stage" ref={stage} aria-hidden="true" />
    <button className="rhine-boot-skip" autoFocus onClick={finish}>跳过动画 · ENTER SYSTEM ↗</button>
    <div className="rhine-boot-window" data-tauri-drag-region><WindowControls /></div>
  </div>;
}
