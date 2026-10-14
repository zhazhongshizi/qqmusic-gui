import { useLayoutEffect, useRef, useState } from "react";
import type { CatalogEntity } from "../../contracts/catalogBrowse";
import type { RecommendationKind } from "../../backend/catalogDiscoveryAdapter";
import { CatalogDetails } from "../catalog/CatalogDetails";
import { DiscoveryTabs } from "../catalog/RecommendationPanel";
import { RecommendationShelf } from "./RecommendationShelf";
import "./discovery-shelf.css";

type Props = { active: boolean; accountKey: string; onClose: () => void; onDeck?: () => void; motionDisabled?: boolean };

export function ArchiveDiscovery(props: Props) {
  return <DiscoveryContent key={props.accountKey} {...props} />;
}

function DiscoveryContent({ active, accountKey, onClose, onDeck, motionDisabled = false }: Props) {
  const [kind, setKind] = useState<RecommendationKind>("guess");
  const [visited, setVisited] = useState<RecommendationKind[]>(["guess"]);
  const [entity, setEntity] = useState<CatalogEntity | null>(null);
  const root = useRef<HTMLElement>(null);
  const scroll = useRef<Partial<Record<RecommendationKind, number>>>({});
  const origin = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const scroller = () => root.current?.closest<HTMLElement>(".rhine-local-page") ?? root.current;
  function remember() { scroll.current[kind] = scroller()?.scrollTop ?? 0; }
  function open(next: CatalogEntity) {
    remember(); origin.current = document.activeElement as HTMLElement | null; setEntity(next);
  }
  function back() { restoreFocus.current = true; setEntity(null); }
  useLayoutEffect(() => {
    const host = scroller();
    if (host) host.scrollTop = entity ? 0 : scroll.current[kind] ?? 0;
    if (!entity && restoreFocus.current) { origin.current?.focus({ preventScroll: true }); restoreFocus.current = false; }
  }, [entity, kind]);
  return <section ref={root} className="rhine-discovery" aria-label="发现音乐" hidden={!active} data-motion={motionDisabled ? "off" : "on"}
    onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.stopPropagation(); if (entity) back(); else onClose();
    } }}>
    <header className="discovery-header">
      <div><p className="rhine-eyebrow">DISCOVERY / MUSIC ARCHIVE</p><h1>发现音乐</h1></div>
      <nav aria-label="发现页面导航"><button type="button" onClick={onClose}>← 返回档案</button>
        {onDeck && <button type="button" onClick={onDeck}>进入磁带机 ↗</button>}</nav>
    </header>
    <div hidden={!!entity}>
      <DiscoveryTabs value={kind} includeNewSongs={false} onChange={value => {
        const next = value as RecommendationKind;
        remember(); setKind(next); setVisited(current => current.includes(next) ? current : [...current, next]);
      }} />
      {visited.map(tab => <RecommendationShelf key={tab} kind={tab} accountKey={accountKey}
        active={active && !entity && tab === kind} hidden={tab !== kind || !!entity} onOpen={open} />)}
    </div>
    {entity && <div className="discovery-details"><CatalogDetails key={`${entity.kind}:${entity.id}`} entity={entity} onBack={back} /></div>}
  </section>;
}
