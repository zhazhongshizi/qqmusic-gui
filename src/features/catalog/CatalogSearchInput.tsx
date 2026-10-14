import { useEffect, useId, useRef, useState, type Ref } from "react";
import { getSearchSuggestions } from "../../backend/catalogDiscoveryAdapter";
import { Icon } from "../../components/Icon";

export function CatalogSearchInput({ value, onChange, onSubmit, inputRef, active = true,
  placeholder = "搜索歌曲、歌手或专辑", label = "搜索歌曲、歌手或专辑", autoFocus = false,
}: {
  value: string; onChange: (value: string) => void; onSubmit?: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>; active?: boolean; placeholder?: string; label?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const generation = useRef(0);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selected, setSelected] = useState(-1);
  const [result, setResult] = useState<{ keyword: string; items: readonly string[] } | null>(null);
  const normalized = value.trim();
  useEffect(() => {
    const epoch = ++generation.current;
    if (!active || !focused || composing || !normalized || [...normalized].length > 100 ||
        dismissed === normalized) return;
    const timer = window.setTimeout(() => {
      void getSearchSuggestions(normalized, epoch).then(reply => {
        if (epoch !== generation.current) return;
        setResult({ keyword: normalized, items: [...new Set(reply.items)].slice(0, 8) });
        setSelected(-1);
      }).catch(() => { if (epoch === generation.current) setResult(null); });
    }, 250);
    return () => { generation.current++; window.clearTimeout(timer); };
  }, [active, focused, composing, normalized, dismissed]);
  const items = active && focused && !composing && dismissed !== normalized &&
    result?.keyword === normalized ? result.items : [];
  function choose(keyword: string) {
    generation.current++;
    setDismissed(keyword.trim()); setSelected(-1); setResult(null);
    onChange(keyword); onSubmit?.(keyword);
  }
  return <div className="catalog-search-combobox">
    <label className="catalog-search">
      <Icon name="search" size={18} /><span className="sr-only">{label}</span>
      <input ref={inputRef} type="search" autoFocus={autoFocus} maxLength={100}
        value={value} placeholder={placeholder} role="combobox" aria-autocomplete="list"
        aria-expanded={items.length > 0} aria-controls={items.length ? `${id}-list` : undefined}
        aria-activedescendant={selected >= 0 && selected < items.length ? `${id}-${selected}` : undefined}
        onFocus={() => { setFocused(true); setDismissed(null); }} onBlur={() => setFocused(false)}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
        onChange={event => { setDismissed(null); setSelected(-1); onChange(event.currentTarget.value); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || composing) return;
          if (event.key === "Escape" && items.length) {
            event.preventDefault(); event.stopPropagation(); setDismissed(normalized); setSelected(-1);
          } else if (items.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setSelected(index => event.key === "ArrowDown" ? (index + 1) % items.length :
              (index <= 0 ? items.length - 1 : index - 1));
          } else if (event.key === "Enter") {
            if (selected >= 0 && items[selected]) {
              event.preventDefault(); event.stopPropagation(); choose(items[selected]);
            } else {
              setDismissed(normalized);
              if (onSubmit) { event.preventDefault(); onSubmit(value); }
            }
          }
        }} />
      {value ? <button type="button" aria-label="清空搜索" onClick={() => {
        setResult(null); setSelected(-1); onChange("");
      }}><Icon name="close" size={16} /></button> : null}
    </label>
    {!!items.length && <ul id={`${id}-list`} role="listbox" aria-label="搜索联想" className="catalog-suggestions">
      {items.map((keyword, index) => <li key={keyword} id={`${id}-${index}`} role="option"
        aria-selected={index === selected} onMouseDown={event => event.preventDefault()}
        onPointerMove={() => setSelected(index)}>
        <button type="button" tabIndex={-1} onClick={() => choose(keyword)}>
          <Icon name="search" size={14} /><span>{keyword}</span>
        </button>
      </li>)}
    </ul>}
  </div>;
}
