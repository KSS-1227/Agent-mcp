"use client";

import React from "react";
import { Menu, RefreshCw, Activity, Database, CheckCircle2, AlertTriangle, XCircle, Info } from "lucide-react";
import clsx from "clsx";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { SystemHealth } from "@/types";

interface TopBarProps {
  onOpenMobileNav: () => void;
  title: string;
  health: SystemHealth | null;
  mode: "live" | "demo";
  onToggleMode: () => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  onOpenMobileNav,
  title,
  health,
  mode,
  onToggleMode,
  onRefresh,
  isRefreshing = false,
}) => {
  const getBackendBadge = () => {
    if (mode === "demo") {
      return (
        <Badge variant="olive" dot size="sm">
          DEMO MODE
        </Badge>
      );
    }

    if (!health) {
      return (
        <Badge variant="neutral" dot size="sm">
          CHECKING BACKEND...
        </Badge>
      );
    }

    if (health.status === "healthy") {
      return (
        <Badge variant="success" dot size="sm">
          POSTGRES & MCP HEALTHY
        </Badge>
      );
    }

    if (health.status === "unhealthy") {
      return (
        <Badge variant="warning" dot size="sm">
          DEGRADED (PARTIAL)
        </Badge>
      );
    }

    return (
      <Badge variant="danger" dot size="sm">
        BACKEND OFFLINE
      </Badge>
    );
  };

  return (
    <header className="h-14 bg-white border-b border-[#E5E4DE] px-4 md:px-6 flex items-center justify-between sticky top-0 z-20">
      {/* Left: Mobile Nav & Page Title */}
      <div className="flex items-center gap-3">
        <button
          onClick={onOpenMobileNav}
          className="md:hidden p-1 text-[#777A73] hover:text-[#252722] hover:bg-[#F0EFEA] rounded"
          aria-label="Open Navigation"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#777A73] hidden sm:inline">Agent Safety MCP</span>
          <span className="text-xs text-[#D5D3CA] hidden sm:inline">/</span>
          <h1 className="text-sm font-semibold text-[#252722]">{title}</h1>
        </div>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-2.5">
        {/* Backend Connectivity Status */}
        <div className="hidden sm:flex items-center gap-1.5">{getBackendBadge()}</div>

        {/* Mode Toggle Switch */}
        <div className="flex items-center bg-[#F6F5F1] p-0.5 rounded border border-[#E5E4DE]">
          <button
            onClick={() => mode !== "live" && onToggleMode()}
            className={clsx(
              "px-2.5 py-1 text-[11px] font-medium rounded transition-all",
              mode === "live"
                ? "bg-white text-[#252722] shadow-2xs font-semibold"
                : "text-[#777A73] hover:text-[#252722]"
            )}
            title="Query real live backend services"
          >
            Live Mode
          </button>
          <button
            onClick={() => mode !== "demo" && onToggleMode()}
            className={clsx(
              "px-2.5 py-1 text-[11px] font-medium rounded transition-all",
              mode === "demo"
                ? "bg-[#242622] text-white shadow-2xs font-semibold"
                : "text-[#777A73] hover:text-[#252722]"
            )}
            title="Inspect deterministic domain fixtures"
          >
            Demo Mode
          </button>
        </div>

        {/* Refresh Button */}
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isRefreshing}
          title="Refresh dashboard data"
        >
          <RefreshCw className={clsx("w-3.5 h-3.5", isRefreshing && "animate-spin")} />
          <span className="hidden md:inline">Refresh</span>
        </Button>
      </div>
    </header>
  );
};

