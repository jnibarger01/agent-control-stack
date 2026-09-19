import type { KeyboardEvent, ReactNode } from "react";

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Sort key id understood by the page; renders a sort control when set. */
  sortKey?: string;
}

/**
 * Accessible data table. Rows that navigate are real focusable rows with
 * Enter/Space activation and aria-selected; below 720px it reflows to labelled cards.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  selectedKey,
  onRowActivate,
  sort,
  onSort,
  empty
}: {
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  selectedKey?: string | undefined;
  onRowActivate?: (row: T) => void;
  sort?: { key: string; dir: "asc" | "desc" };
  onSort?: (key: string) => void;
  empty?: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRowActivate?.(row);
    }
  };
  return (
    <div className="table-wrap">
      <table className="table" data-stack="true">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                aria-sort={
                  sort && column.sortKey === sort.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
                }
              >
                {column.sortKey && onSort ? (
                  <button type="button" className="sort-btn" onClick={() => onSort(column.sortKey!)}>
                    {column.header}
                    {sort && column.sortKey === sort.key ? (
                      <span aria-hidden="true">{sort.dir === "asc" ? "▲" : "▼"}</span>
                    ) : null}
                  </button>
                ) : column.header ? (
                  column.header
                ) : (
                  <span className="visually-hidden">Actions</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                data-clickable={onRowActivate ? "true" : undefined}
                aria-selected={onRowActivate ? key === selectedKey : undefined}
                tabIndex={onRowActivate ? 0 : undefined}
                onClick={onRowActivate ? () => onRowActivate(row) : undefined}
                onKeyDown={onRowActivate ? (event) => onKeyDown(event, row) : undefined}
              >
                {columns.map((column) => (
                  <td key={column.id} data-label={column.header || undefined}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && empty}
    </div>
  );
}
