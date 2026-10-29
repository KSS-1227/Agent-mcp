import React from "react";
import clsx from "clsx";
import { AlertCircle, Inbox } from "lucide-react";

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  icon,
  action,
  className,
}) => {
  return (
    <div
      className={clsx(
        "p-10 border border-dashed border-[#E5E4DE] rounded-md bg-white text-center flex flex-col items-center justify-center max-w-lg mx-auto my-6",
        className
      )}
    >
      <div className="w-10 h-10 rounded-full bg-[#F3F4F6] text-[#777A73] flex items-center justify-center mb-3">
        {icon || <Inbox className="w-5 h-5" />}
      </div>
      <h4 className="text-sm font-semibold text-[#252722] mb-1">{title}</h4>
      <p className="text-xs text-[#777A73] max-w-sm mb-4 leading-relaxed">{description}</p>
      {action}
    </div>
  );
};

