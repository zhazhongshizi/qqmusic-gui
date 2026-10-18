import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { ArchivePageTransitionContext } from "./ArchivePageTransition";
import { ArchiveScene } from "./vendor/scene";
import { ArchiveScene2D } from "./vendor/scene-2d";
import type { ArchiveRenderer, RhineFrameLimit } from "./rhineSettings";
import { setArchiveCount } from "./vendor/data";
import { qualityPresets, type RenderQuality } from "./vendor/render-quality";
import { fullMotion, reducedMotion } from "./vendor/motion-preferences";
import { getCoverImage, getPlaylistImage } from "../../backend/coverAdapter";
import type { DiscoveryState, DiscoveryFrame } from "./vendor/discovery-layout";
import type { ArchiveTrack } from "./vendor/archive-artwork";

export function ArchiveCanvas({ discovery = null, onDiscoveryFrame, renderer = "webgl", frameLimit = 60, spatialUpscaling = false, booting = false, count, titles = [], archiveTracks, quality = qualityPresets.performance, superPerformance = false, disableCassetteMotionWhilePlaying = false, reduceCassetteMotionWhilePlaying = false, selected, detail, deck = false, queueOpen = false, playing = false, track, trackIndex = 0, queueLength = 0, active, onSelect, onOpen, onPlaybackCassetteOpen }: {
  discovery?: DiscoveryState | null; onDiscoveryFrame?: (frame: DiscoveryFrame) => void;
  renderer?: ArchiveRenderer;
  frameLimit?: RhineFrameLimit;
  spatialUpscaling?: boolean;
  booting?: boolean;
  archiveTracks?: readonly ArchiveTrack[];
  count: number; titles?: readonly string[]; quality?: RenderQuality; superPerformance?: boolean; disableCassetteMotionWhilePlaying?: boolean; reduceCassetteMotionWhilePlaying?: boolean; selected: number; detail: boolean; deck?: boolean; queueOpen?: boolean; playing?: boolean; track?: { id: string; title: string; artist: string; coverCacheKey?: string } | null; trackIndex?: number; queueLength?: number; active: boolean; onSelect: (index: number) => void; onOpen?: (index: number) => void; onPlaybackCassetteOpen?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const pageTransition = useContext(ArchivePageTransitionContext);
  const transitionDiscovery = useMemo<DiscoveryState | null>(() => pageTransition && active ? {
    open: pageTransition.phase === "leaving", ready: true, surfaceOnly: true,
    key: "archive-page", entries: [], selected: null, hovered: null, scroll: 0, top: 0,
    reduced: superPerformance || (playing && (disableCassetteMotionWhilePlaying || reduceCassetteMotionWhilePlaying)),
  } : null, [pageTransition, active, superPerformance, playing, disableCassetteMotionWhilePlaying, reduceCassetteMotionWhilePlaying]);
  const usingPageTransition = !discovery && !!transitionDiscovery;
  discovery = discovery ?? transitionDiscovery;
  if (usingPageTransition) onDiscoveryFrame = frame => {
    if (frame.phase === "ready" && pageTransition?.phase === "leaving") pageTransition.onExited();
    if (frame.phase === "closed" && pageTransition?.phase === "entering") pageTransition.onEntered();
    // Page frames must not settle a pending discovery-to-playback navigation.
  };
  const opening = useRef(booting);
  const scene = useRef<ArchiveScene | ArchiveScene2D | null>(null);
  const sceneSelection = useRef<number | null>(null);
  const currentTitles = useRef(titles);
  currentTitles.current = titles;
  const titleContents = JSON.stringify(titles);
  const current = useRef({ frameLimit, spatialUpscaling, selected, detail, deck, queueOpen, playing, active, quality, superPerformance, disableCassetteMotionWhilePlaying, reduceCassetteMotionWhilePlaying, onSelect, onOpen, onPlaybackCassetteOpen });
  current.current = { frameLimit, spatialUpscaling, selected, detail, deck, queueOpen, playing, active, quality, superPerformance, disableCassetteMotionWhilePlaying, reduceCassetteMotionWhilePlaying, onSelect, onOpen, onPlaybackCassetteOpen };
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const discoveryCallback = useRef(onDiscoveryFrame); discoveryCallback.current = onDiscoveryFrame;
  const currentDiscovery = useRef(discovery); currentDiscovery.current = discovery;
  const artworkContents = JSON.stringify(archiveTracks);
  useEffect(() => {
    const host = root.current;
    if (!host || !count) return;
    let disposed = false;
    let frame = 0;
    let updating = false;
    let invalidatedDuringUpdate = false;
    let lastUpdate = -Infinity;
    let previousLimit = current.current.frameLimit;
    let instance: ArchiveScene | ArchiveScene2D | undefined;
    let observer: ResizeObserver | undefined;
    let loading = true;
    let released = false;
    const release = () => { if (!released && instance) { released = true; instance.dispose(); } };
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    setError(false); setReady(false);
    const stop = () => { cancelAnimationFrame(frame); frame = 0; };
    const tick = (time: number) => {
      frame = 0;
      if (disposed || released || document.hidden || !current.current.active) return;
      const limit = current.current.frameLimit;
      if (previousLimit !== limit) { previousLimit = limit; lastUpdate = -Infinity; }
      const interval = limit ? 1000 / limit : 0;
      if (interval && time - lastUpdate < interval - .001) {
        frame = requestAnimationFrame(tick);
        return;
      }
      // Retain the fractional budget so 144/165Hz displays still deliver 30/60 FPS.
      lastUpdate = interval && Number.isFinite(lastUpdate)
        ? lastUpdate + Math.floor((time - lastUpdate + .001) / interval) * interval
        : time;
      updating = true;
      invalidatedDuringUpdate = false;
      let continuing: boolean | undefined;
      try { continuing = instance?.update(time / 1000); } finally { updating = false; }
      if ((continuing !== false || invalidatedDuringUpdate) && !frame && !disposed && !released && current.current.active && !document.hidden) frame = requestAnimationFrame(tick);
    };
    const resume = () => {
      if (disposed || released || loading || !current.current.active || document.hidden) { stop(); return; }
      if (updating) { invalidatedDuringUpdate = true; return; }
      if (!frame && !updating) { lastUpdate = -Infinity; instance?.resumeUpdates(); frame = requestAnimationFrame(tick); }
    };
    const changeMotion = () => {
      instance?.setMotion(motion.matches ? reducedMotion() : fullMotion());
      if (currentDiscovery.current && scene.current === instance) instance?.setDiscovery?.({...currentDiscovery.current, reduced: currentDiscovery.current.reduced || motion.matches});
    };
    host.addEventListener("rhine-renderability", resume);
    document.addEventListener("visibilitychange", resume);
    motion.addEventListener("change", changeMotion);
    void (async () => {
      try {
        setArchiveCount(count);
        instance = renderer === "canvas2d" ? new ArchiveScene2D(host, count, titles) : new ArchiveScene(host);
        instance.setTitles(currentTitles.current);
        instance.onInvalidate = resume;
        changeMotion();
        instance.setQuality(current.current.quality);
        instance.setDisableCassetteMotionWhilePlaying(current.current.disableCassetteMotionWhilePlaying);
        instance.setReduceCassetteMotionWhilePlaying(current.current.reduceCassetteMotionWhilePlaying);
        await instance.load();
        loading = false;
        if (disposed) { release(); return; }
        instance.setTitles(currentTitles.current);
        // Reapply the latest user settings after the models exist so texture and
        // material quality reach newly loaded assets. Super mode also swaps the
        // loaded cassette materials, so its first call must happen after load.
        instance.setQuality(current.current.quality);
        instance.setSuperPerformance(current.current.superPerformance);
        if (instance instanceof ArchiveScene) instance.setSpatialUpscaling(current.current.spatialUpscaling);
        instance.setDisableCassetteMotionWhilePlaying(current.current.disableCassetteMotionWhilePlaying);
        instance.setReduceCassetteMotionWhilePlaying(current.current.reduceCassetteMotionWhilePlaying);
        scene.current = instance;
        instance.select(current.current.selected);
        sceneSelection.current = current.current.selected;
        instance.setMode(current.current.queueOpen || (current.current.detail && !current.current.deck) ? "detail" : "archive");
        instance.setDeck(current.current.deck, current.current.playing);
        if (!opening.current) instance.revealImmediately();
        instance.onSelect = (index, cell) => {
          // Apply physical selection within the scene's drag transaction. A later
          // React effect would lose the cell and cancel the held pointer.
          instance!.select(index, cell ? { cell } : undefined);
          sceneSelection.current = index;
          current.current.onSelect(index);
        };
        instance.onOpen = (index) => { const state = current.current; if (state.active && !state.detail && !state.deck) state.onOpen?.(index); };
        instance.onPlaybackCassetteOpen = () => { const state = current.current; if (state.active && state.deck) state.onPlaybackCassetteOpen?.(); };
        instance.onNavigate = (axis, direction) => {
          if (axis !== "row" && axis !== "lane") return;
          const index = ((sceneSelection.current ?? current.current.selected) + direction + count) % count;
          instance!.select(index, { axis, direction });
          sceneSelection.current = index;
          current.current.onSelect(index);
        };
        observer = new ResizeObserver(() => instance?.resize());
        observer.observe(host);
        instance.resize();
        setReady(true); resume();
      } catch {
        loading = false;
        release();
        if (!disposed) { scene.current = null; setError(true); }
      }
    })();
    return () => {
      disposed = true; stop(); observer?.disconnect();
      // Retire the old surface immediately, even if its GLB loader still owns disposal.
      for (const canvas of host.querySelectorAll(":scope > canvas")) canvas.remove();
      host.removeEventListener("rhine-renderability", resume);
      document.removeEventListener("visibilitychange", resume);
      motion.removeEventListener("change", changeMotion);
      scene.current = null;
      sceneSelection.current = null;
      // An in-flight loader owns disposal when it resolves; do not dispose twice.
      if (!loading) release();
    };
  }, [count, renderer]);
  useEffect(() => { scene.current?.setTitles(currentTitles.current); }, [titleContents, ready]);
  useEffect(() => {
    if (!ready || !scene.current) return;
    scene.current.onDiscoveryFrame = frame => discoveryCallback.current?.(frame);
    scene.current.setDiscovery?.(discovery ? {...discovery, reduced: discovery.reduced || matchMedia("(prefers-reduced-motion: reduce)").matches} : null);
  }, [discovery, ready]);
  const discoveryArt = JSON.stringify(discovery?.entries.map(e => [e.id,e.kind,e.coverCacheKey]));
  const hasDiscovery = !!discovery;
  useEffect(() => {
    const instance = scene.current;
    if (!ready || !instance || !discovery) return;
    let alive = true;
    void Promise.allSettled(discovery.entries.map(async entry => {
      if (!entry.coverCacheKey) return;
      const payload = await (entry.kind === "playlist" ? getPlaylistImage : getCoverImage)(entry.coverCacheKey);
      const url = URL.createObjectURL(new Blob([new Uint8Array(payload.bytes).buffer], { type: payload.mimeType }));
      try { const image = new Image(); image.src = url; await image.decode(); if (alive) instance.setDiscoveryCover(entry.id,image); }
      finally { URL.revokeObjectURL(url); }
    }));
    return () => { alive = false; };
  }, [discoveryArt, hasDiscovery, ready]);
  useEffect(() => { scene.current?.setQuality(quality); }, [quality]);
  useEffect(() => { if (scene.current instanceof ArchiveScene) scene.current.setSpatialUpscaling(spatialUpscaling); }, [spatialUpscaling]);
  useEffect(() => { scene.current?.setSuperPerformance(superPerformance); }, [superPerformance]);
  useEffect(() => { scene.current?.setDisableCassetteMotionWhilePlaying(disableCassetteMotionWhilePlaying); }, [disableCassetteMotionWhilePlaying]);
  useEffect(() => { scene.current?.setReduceCassetteMotionWhilePlaying(reduceCassetteMotionWhilePlaying); }, [reduceCassetteMotionWhilePlaying]);
  useEffect(() => {
    if (scene.current && sceneSelection.current !== selected) {
      scene.current.select(selected);
      sceneSelection.current = selected;
    }
  }, [selected]);
  // Discovery captures the source camera/tapes. Keep its playback prints and
  // cell intact until the shared transition releases the scene at either end.
  useEffect(() => { if (!hasDiscovery) scene.current?.setMode(queueOpen || (detail && !deck) ? "detail" : "archive"); }, [detail, deck, queueOpen, hasDiscovery]);
  useEffect(() => { if (!hasDiscovery) scene.current?.setDeck(deck, playing); }, [deck, playing, hasDiscovery]);
  useEffect(() => {
    if (!hasDiscovery && deck && track) scene.current?.setPlaybackTrack(track.id, trackIndex, queueLength);
  }, [deck, track?.id, trackIndex, queueLength, ready, hasDiscovery]);
  useEffect(() => {
    if (!scene.current || hasDiscovery) return;
    if (archiveTracks?.length) return;
    let alive = true;
    scene.current?.setTrack(deck ? track?.title ?? "" : "", deck ? track?.artist ?? "" : "", null);
    if (deck && track?.coverCacheKey) void getCoverImage(track.coverCacheKey).then(async payload => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(payload.bytes).buffer], { type: payload.mimeType }));
      try {
        const cover = new Image();
        cover.src = url;
        await cover.decode();
        if (alive) scene.current?.setTrack(track.title, track.artist, cover);
      } finally { URL.revokeObjectURL(url); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [deck, track?.id, track?.title, track?.artist, track?.coverCacheKey, ready, Boolean(archiveTracks?.length), hasDiscovery]);
  useEffect(() => {
    const instance = scene.current;
    if (!instance || !archiveTracks) return;
    let alive = true;
    instance.setArchiveTracks(archiveTracks);
    const covers = new Map<string, Promise<HTMLImageElement>>();
    void Promise.allSettled(archiveTracks.map(async (item, index) => {
      if (!item.coverCacheKey) return;
      let image = covers.get(item.coverCacheKey);
      if (!image) {
        image = getCoverImage(item.coverCacheKey).then(async payload => {
          const url = URL.createObjectURL(new Blob([new Uint8Array(payload.bytes).buffer], { type: payload.mimeType }));
          try { const cover = new Image(); cover.src = url; await cover.decode(); return cover; }
          finally { URL.revokeObjectURL(url); }
        });
        covers.set(item.coverCacheKey, image);
      }
      const cover = await image;
      if (alive) instance.setArchiveCover(index, cover);
    }));
    return () => { alive = false; };
  }, [artworkContents, ready]);
  useEffect(() => { root.current?.dispatchEvent(new Event("rhine-renderability")); }, [active, frameLimit]);
  return <div className="rhine-scene" ref={root} inert={!!discovery} aria-hidden={discovery ? true : undefined} data-ready={ready} data-active={active} data-discovery-target={discovery?.open} data-deck={deck} data-renderer={renderer} data-frame-limit={frameLimit}>
    {!ready && <p className="rhine-scene-status" role="status">{error ? `${renderer === "canvas2d" ? "2D" : "三维"}场景加载失败，仍可从下方选择歌单` : "正在载入档案阵列…"}</p>}
  </div>;
}
