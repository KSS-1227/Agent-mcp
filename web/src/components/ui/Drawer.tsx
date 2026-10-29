"use client";

import React, { useEffect } from "react";
import clsx from "clsx";
import { X } from "lucide-react";

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  width?: "md" | "lg" | "xl";
}

export const Drawer: React.FC<DrawerProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  badge,
  children,
  width = "lg",
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.body.style.overflow = "unset";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const widthStyles = {
    md: "max-w-md",
    lg: "max-w-xl",
    xl: "max-w-2xl",
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-[#242622]/40 transition-opacity"
        onClick={onClose}
      />

      <div className="fixed inset-y-0 right-0 flex pl-10 max-w-full">
        <div
          className={clsx(
            "w-screen bg-white border-l border-[#E5E4DE] shadow-xl flex flex-col justify-between animate-in slide-in-from-right duration-200",
            widthStyles[width]
          )}
        >
          {/* Header */}
          <div className="px-5 py-4 border-b border-[#E5E4DE] flex items-center justify-between bg-[#F9F8F5]">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-[#252722]">{title}</h2>
                {badge}
              </div>
              {subtitle && <p className="text-xs text-[#777A73] mt-0.5">{subtitle}</p>}
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded text-[#777A73] hover:text-[#252722] hover:bg-[#E5E4DE] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-5 text-xs text-[#252722] space-y-4">
            {children}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-[#E5E4DE] bg-[#F9F8F5] flex justify-end">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium bg-white border border-[#E5E4DE] text-[#252722] rounded hover:bg-[#F0EFEA] transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

