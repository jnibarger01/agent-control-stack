import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Kbd } from "../design/primitives";
import { NAV_ITEMS } from "./nav";

/** Ctrl/Cmd+K page switcher. Pages only; it does not search data it has not loaded. */
export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const results = useMemo(
    () => NAV_ITEMS.filter((n) => `${n.label} ${n.description}`.toLowerCase().includes(query.trim().toLowerCase())),
    [query]
  );
  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      input.current?.focus();
    }
  }, [open]);
  if (!open) return null;
  const go = (i: number) => {
    const item = results[i];
    if (!item) return;
    onClose();
    if (item.route) navigate(item.route);
    else if (item.classic) window.location.assign(item.classic);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 p-4 pt-[14vh]" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Go to page" onClick={(e) => e.stopPropagation()} className="acs-in w-full max-w-lg overflow-hidden rounded-card border border-line-strong bg-surface shadow-2xl">
        <input
          ref={input}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") go(index);
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={results[index] ? `palette-${results[index].key}` : undefined}
          aria-label="Search pages"
          placeholder="Go to page…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none placeholder:text-faint"
        />
        <ul id="palette-results" role="listbox" aria-label="Pages" className="max-h-72 overflow-y-auto p-2">
          {results.length === 0 && <li className="px-3 py-4 text-sm text-muted">No page matches “{query}”.</li>}
          {results.map((item, i) => (
            <li key={item.key} id={`palette-${item.key}`} role="option" aria-selected={i === index}>
              <button type="button" onClick={() => go(i)} onMouseEnter={() => setIndex(i)} className={`flex w-full items-center justify-between rounded-ctl px-3 py-2 text-left text-sm ${i === index ? "bg-accent-soft text-ink" : "text-muted"}`}>
                <span><span className="font-medium text-ink">{item.label}</span> <span className="text-xs">{item.description}</span></span>
                {!item.route && <span className="text-[11px] text-faint">classic</span>}
              </button>
            </li>
          ))}
        </ul>
        <p className="border-t border-line px-4 py-2 text-xs text-muted"><Kbd>↑</Kbd> <Kbd>↓</Kbd> to move · <Kbd>Enter</Kbd> to open · <Kbd>Esc</Kbd> to close</p>
      </div>
    </div>
  );
}
