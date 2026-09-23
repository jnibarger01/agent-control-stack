import { useEffect, useId, useMemo, useRef, useState } from "react";
import { searchIndex, type SearchHit } from "../domain/search";
import { useProjectedActors, useRegistryAgents, useWorkItems } from "../state/data";
import { useRouter } from "../router";

const KIND_LABEL: Record<SearchHit["kind"], string> = {
  work: "Work item",
  agent: "Agent",
  connector: "Connector",
  execution: "Execution"
};

/**
 * Global search. The gateway has no search endpoint, so this indexes the
 * datasets already loaded in this tab (work items, registry agents, connector
 * actors) and says so in the dialog.
 */
export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const { go } = useRouter();
  const work = useWorkItems();
  const agents = useRegistryAgents();
  const actors = useProjectedActors();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 120);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      setQuery("");
      setDebounced("");
      setActive(0);
      queueMicrotask(() => inputRef.current?.focus());
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  const hits = useMemo(
    () =>
      searchIndex(
        { workItems: work.data ?? [], registryAgents: agents.data ?? [], actors: actors.data ?? [] },
        debounced
      ),
    [work.data, agents.data, actors.data, debounced]
  );

  useEffect(() => setActive(0), [debounced]);

  const choose = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onClose();
    go(hit.href);
  };
  const activeHit = hits[active];

  return (
    <dialog
      ref={ref}
      className="dialog palette"
      aria-label="Global search"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-body">
        <input
          ref={inputRef}
          className="input"
          type="search"
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls={listId}
          aria-activedescendant={activeHit ? `${listId}-${active}` : undefined}
          aria-label="Search work items, agents, connectors, executions"
          placeholder="Search work items, agents, connectors, attempts…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((i) => Math.min(hits.length - 1, i + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(activeHit);
            }
          }}
        />
        <p className="hint" id={`${listId}-hint`}>
          Searches data loaded in this session (
          {(work.data?.length ?? 0) + (agents.data?.length ?? 0) + (actors.data?.length ?? 0)} records). The gateway has
          no server-side search.
        </p>
        {debounced.trim() !== "" && (
          <ul className="palette-results" role="listbox" id={listId} aria-label="Search results">
            {hits.map((hit, index) => (
              <li
                key={`${hit.kind}:${hit.id}`}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                data-active={index === active}
              >
                <button type="button" onClick={() => choose(hit)} tabIndex={-1}>
                  <span className="kind-tag">{KIND_LABEL[hit.kind]}</span>
                  <span className="truncate">
                    <strong>{hit.title}</strong> <span className="muted">{hit.subtitle}</span>
                  </span>
                </button>
              </li>
            ))}
            {hits.length === 0 && (
              <li className="muted" style={{ padding: "var(--space-3) var(--space-4)" }}>
                No matches in loaded data.
              </li>
            )}
          </ul>
        )}
        <div aria-live="polite" className="visually-hidden">
          {debounced.trim() !== "" ? `${hits.length} results` : ""}
        </div>
      </div>
    </dialog>
  );
}
