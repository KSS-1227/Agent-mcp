"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Bot,
  Layers,
  ShieldAlert,
  GitCommit,
  LifeBuoy,
  FileCheck2,
  Settings,
  Shield,
  X,
} from "lucide-react";
import clsx from "clsx";

interface SidebarProps {
  isOpenMobile?: boolean;
  onCloseMobile?: () => void;
}

export const NAV_ITEMS = [
  { name: "Overview", href: "/", icon: LayoutDashboard },
  { name: "Agents", href: "/agents", icon: Bot },
  { name: "Intents & Resources", href: "/intents", icon: Layers },
  { name: "Conflict Monitor", href: "/conflicts", icon: ShieldAlert, badge: "Gate" },
  { name: "Action Lifecycle", href: "/actions", icon: GitCommit },
  { name: "Recovery Center", href: "/recovery", icon: LifeBuoy, badge: "Reconcile" },
  { name: "Evidence & Audit", href: "/evidence", icon: FileCheck2 },
  { name: "Settings", href: "/settings", icon: Settings },
];

export const Sidebar: React.FC<SidebarProps> = ({
  isOpenMobile = false,
  onCloseMobile,
}) => {
  const pathname = usePathname();

  const content = (
    <div className="flex flex-col h-full bg-[#242622] text-[#F6F5F1] select-none border-r border-[#343731]">
      {/* Brand Header */}
      <div className="h-14 px-4 flex items-center justify-between border-b border-[#343731]">
        <Link href="/" className="flex items-center gap-2.5 group">
          <div className="w-7 h-7 rounded bg-[#52745B] flex items-center justify-center text-white font-semibold text-xs shadow-xs">
            <Shield className="w-4 h-4" />
          </div>
          <div>
            <div className="text-xs font-semibold tracking-wide text-white group-hover:text-[#EEF3EE] transition-colors">
              Agent Safety MCP
            </div>
            <div className="text-[10px] text-[#9B9E96] font-mono leading-none">
              v0.1.0 · Postgres
            </div>
          </div>
        </Link>
        {onCloseMobile && (
          <button
            onClick={onCloseMobile}
            className="md:hidden p-1 text-[#9B9E96] hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Navigation List */}
      <nav className="flex-1 px-2.5 py-4 space-y-1 overflow-y-auto">
        <div className="px-2 pb-1.5 text-[10px] font-semibold text-[#777A73] uppercase tracking-wider">
          Control Plane
        </div>
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onCloseMobile}
              className={clsx(
                "flex items-center justify-between px-2.5 py-2 rounded text-xs font-medium transition-all group",
                isActive
                  ? "bg-[#333730] text-white border-l-2 border-[#52745B]"
                  : "text-[#B2B5AD] hover:bg-[#2C2E29] hover:text-white"
              )}
            >
              <div className="flex items-center gap-2.5">
                <Icon
                  className={clsx(
                    "w-4 h-4 shrink-0 transition-colors",
                    isActive ? "text-[#52745B]" : "text-[#8A916A] group-hover:text-white"
                  )}
                />
                <span>{item.name}</span>
              </div>
              {item.badge && (
                <span
                  className={clsx(
                    "text-[10px] px-1.5 py-0.2 rounded font-mono font-medium",
                    isActive
                      ? "bg-[#52745B]/30 text-[#C8D7CA]"
                      : "bg-[#333730] text-[#9B9E96]"
                  )}
                >
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Safety Protocol Status Indicator Footer */}
      <div className="p-3 border-t border-[#343731] bg-[#1E201C] text-[11px]">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[#9B9E96]">Protocol Guarantees</span>
          <span className="w-1.5 h-1.5 rounded-full bg-[#52745B] animate-pulse" />
        </div>
        <div className="text-[10px] text-[#777A73] font-mono leading-tight space-y-0.5">
          <div>• Exactly-once action commit</div>
          <div>• Deterministic conflict gate</div>
        </div>
        <button
          onClick={async () => {
            // Server-side session invalidation, then return to the login gate.
            try {
              await fetch("/api/auth/logout", { method: "POST" });
            } finally {
              window.location.assign("/login");
            }
          }}
          className="mt-2 w-full text-left text-[10px] text-[#9B9E96] hover:text-white hover:underline"
        >
          Sign out of dashboard
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <aside className="hidden md:block w-60 h-screen shrink-0 sticky top-0 z-30">
        {content}
      </aside>

      {/* Mobile Drawer */}
      {isOpenMobile && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-black/60 transition-opacity"
            onClick={onCloseMobile}
          />
          <div className="relative w-64 max-w-[80vw] h-full z-50">
            {content}
          </div>
        </div>
      )}
    </>
  );
};

