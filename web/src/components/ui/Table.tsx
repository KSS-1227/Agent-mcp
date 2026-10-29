import React from "react";
import clsx from "clsx";

interface Column<T> {
  header: string;
  accessorKey?: keyof T;
  cell?: (item: T) => React.ReactNode;
  className?: string;
  align?: "left" | "center" | "right";
}

interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (item: T) => string;
  onRowClick?: (item: T) => void;
  emptyMessage?: string;
  className?: string;
}

export function Table<T>({
  columns,
  data,
  keyExtractor,
  onRowClick,
  emptyMessage = "No records found",
  className,
}: TableProps<T>) {
  if (data.length === 0) {
    return (
      <div className="p-8 text-center text-xs text-[#777A73] border border-[#E5E4DE] rounded-md bg-white">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={clsx("overflow-x-auto border border-[#E5E4DE] rounded-md bg-white", className)}>
      <table className="w-full text-left text-xs border-collapse">
        <thead>
          <tr className="border-b border-[#E5E4DE] bg-[#F9F8F5] text-[#777A73]">
            {columns.map((col, idx) => (
              <th
                key={idx}
                className={clsx(
                  "py-2.5 px-3 font-semibold uppercase tracking-wider text-[11px]",
                  col.align === "right"
                    ? "text-right"
                    : col.align === "center"
                    ? "text-center"
                    : "text-left",
                  col.className
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#E5E4DE] text-[#252722]">
          {data.map((item) => (
            <tr
              key={keyExtractor(item)}
              onClick={() => onRowClick && onRowClick(item)}
              className={clsx(
                "transition-colors",
                onRowClick ? "cursor-pointer hover:bg-[#F9F8F5]" : "hover:bg-[#FCFBF9]"
              )}
            >
              {columns.map((col, idx) => (
                <td
                  key={idx}
                  className={clsx(
                    "py-2.5 px-3 align-middle",
                    col.align === "right"
                      ? "text-right"
                      : col.align === "center"
                      ? "text-center"
                      : "text-left",
                    col.className
                  )}
                >
                  {col.cell
                    ? col.cell(item)
                    : col.accessorKey
                    ? (item[col.accessorKey] as any)
                    : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

