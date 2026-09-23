import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabDef {
  id: string;
  label: string;
}

/** WAI-ARIA tabs: roving tabindex, arrow/Home/End keys, panel linked by aria-controls. */
export function Tabs({
  tabs,
  active,
  onChange,
  label,
  children
}: {
  tabs: readonly TabDef[];
  active: string;
  onChange: (id: string) => void;
  label: string;
  children: ReactNode;
}) {
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const activeId = tabs.some((tab) => tab.id === active) ? active : tabs[0]?.id;
  const onKeyDown = (event: KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const last = tabs.length - 1;
    const targets: Record<string, number> = {
      ArrowRight: index >= last ? 0 : index + 1,
      ArrowLeft: index <= 0 ? last : index - 1,
      Home: 0,
      End: last
    };
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = tabs[next];
    if (target) {
      onChange(target.id);
      refs.current.get(target.id)?.focus();
    }
  };
  return (
    <div>
      <div role="tablist" aria-label={label} className="tabs" onKeyDown={onKeyDown}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) refs.current.set(tab.id, node);
              else refs.current.delete(tab.id);
            }}
            role="tab"
            type="button"
            className="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={tab.id === activeId}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={tab.id === activeId ? 0 : -1}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        className="tabpanel"
        id={`${base}-panel-${activeId}`}
        aria-labelledby={`${base}-tab-${activeId}`}
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}
