import React from "react";
import clsx from "clsx";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = "secondary",
  size = "md",
  icon,
  className,
  disabled,
  ...props
}) => {
  const base =
    "inline-flex items-center justify-center font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#52745B] focus:ring-offset-1 disabled:opacity-50 disabled:pointer-events-none rounded select-none";

  const sizeStyles = {
    sm: "h-7 px-2.5 text-xs gap-1.5",
    md: "h-8 px-3 text-xs gap-2",
    lg: "h-9 px-4 text-sm gap-2",
  };

  const variantStyles = {
    primary: "bg-[#52745B] hover:bg-[#44624C] text-white border border-[#44624C] shadow-sm",
    secondary:
      "bg-white hover:bg-[#F9F8F5] text-[#252722] border border-[#E5E4DE] shadow-xs hover:border-[#D5D3CA]",
    outline: "bg-transparent hover:bg-[#F0EFEA] text-[#252722] border border-[#E5E4DE]",
    ghost: "bg-transparent hover:bg-[#F0EFEA] text-[#777A73] hover:text-[#252722]",
    danger: "bg-[#F9ECEB] hover:bg-[#F2D7D5] text-[#872B28] border border-[#E5BCB9]",
  };

  return (
    <button
      className={clsx(base, sizeStyles[size], variantStyles[variant], className)}
      disabled={disabled}
      {...props}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {children}
    </button>
  );
};

