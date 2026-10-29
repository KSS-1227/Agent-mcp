import React from "react";
import clsx from "clsx";

interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  title?: React.ReactNode;
  action?: React.ReactNode;
  description?: string;
  badge?: React.ReactNode;
}

export const Card: React.FC<CardProps> = ({
  children,
  className,
  onClick,
  title,
  action,
  description,
  badge,
}) => {
  return (
    <div
      onClick={onClick}
      className={clsx(
        "bg-white border border-[#E5E4DE] rounded-md transition-all",
        onClick && "cursor-pointer hover:border-[#D5D3CA] hover:shadow-xs",
        className
      )}
    >
      {(title || action || description || badge) && (
        <div className="px-4 py-3 border-b border-[#E5E4DE] flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              {title && <h3 className="text-sm font-semibold text-[#252722]">{title}</h3>}
              {badge}
            </div>
            {description && <p className="text-xs text-[#777A73] mt-0.5">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
};

