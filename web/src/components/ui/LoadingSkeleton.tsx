import React from "react";
import clsx from "clsx";

export const Skeleton: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <div
      className={clsx(
        "animate-pulse bg-[#E5E4DE]/60 rounded",
        className
      )}
    />
  );
};

export const TableSkeleton: React.FC<{ rows?: number }> = ({ rows = 5 }) => {
  return (
    <div className="border border-[#E5E4DE] rounded-md bg-white p-4 space-y-3">
      <Skeleton className="h-6 w-1/4 mb-4" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 items-center">
          <Skeleton className="h-4 w-1/6" />
          <Skeleton className="h-4 w-2/6" />
          <Skeleton className="h-4 w-1/6" />
          <Skeleton className="h-4 w-2/6" />
        </div>
      ))}
    </div>
  );
};

