import React from "react";
import clsx from "clsx";

export type BadgeVariant = "success" | "warning" | "danger" | "neutral" | "olive";

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  dot?: boolean;
  className?: string;
  size?: "sm" | "md";
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "neutral",
  dot = false,
  className,
  size = "sm",
}) => {
  const variantStyles: Record<BadgeVariant, { container: string; dot: string }> = {
    success: {
      container: "bg-[#EEF3EE] text-[#3B6145] border-[#C8D7CA]",
      dot: "bg-[#52745B]",
    },
    warning: {
      container: "bg-[#FAF4E8] text-[#8C631B] border-[#E9D8B4]",
      dot: "bg-[#B58533]",
    },
    danger: {
      container: "bg-[#F9ECEB] text-[#872B28] border-[#E5BCB9]",
      dot: "bg-[#A8423F]",
    },
    neutral: {
      container: "bg-[#F3F4F6] text-[#4B5563] border-[#E5E7EB]",
      dot: "bg-[#777A73]",
    },
    olive: {
      container: "bg-[#F3F5EB] text-[#555C3A] border-[#D5DBC0]",
      dot: "bg-[#8A916A]",
    },
  };

  const current = variantStyles[variant];

  return (
    <span
      className={clsx(
        "inline-flex items-center font-medium border rounded",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs",
        current.container,
        className
      )}
    >
      {dot && <span className={clsx("w-1.5 h-1.5 rounded-full mr-1.5 shrink-0", current.dot)} />}
      {children}
    </span>
  );
};

