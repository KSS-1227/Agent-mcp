"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { SystemHealth } from "@/types";

interface DashboardContextType {
  mode: "live" | "demo";
  setMode: (m: "live" | "demo") => void;
  toggleMode: () => void;
  health: SystemHealth | null;
  isBackendOffline: boolean;
  refreshKey: number;
  triggerRefresh: () => void;
  isRefreshing: boolean;
}

const DashboardContext = createContext<DashboardContextType | undefined>(undefined);

/**
 * Honest fallback used when /api/health cannot be read. Nothing here is inferred:
 * every probe is reported as unreachable and the provider stays unverified.
 */
function unreachableHealth(errorCode?: string): SystemHealth {
  return {
    status: "disconnected",
    mode: "live",
    database: { configured: false, reachable: false, errorCode },
    backend: { configured: false, reachable: false, liveness: false, readiness: false, errorCode },
    provider: {
      verified: false,
      note: "Provider health is not exposed by the backend.",
    },
    checkedAt: new Date().toISOString(),
  };
}

export const DashboardProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setMode] = useState<"live" | "demo">("demo"); // default to demo so users immediately see domain visuals
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        setHealth(body as SystemHealth);
        return;
      }
      setHealth(unreachableHealth(body?.code));
    } catch {
      setHealth(unreachableHealth("HEALTH_CHECK_UNREACHABLE"));
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const timer = setInterval(checkHealth, 30_000);
    return () => clearInterval(timer);
  }, [checkHealth, refreshKey]);

  const triggerRefresh = useCallback(() => {
    setIsRefreshing(true);
    setRefreshKey((k) => k + 1);
    setTimeout(() => setIsRefreshing(false), 600);
  }, []);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === "live" ? "demo" : "live"));
    triggerRefresh();
  }, [triggerRefresh]);

  const isBackendOffline = mode === "live" && health !== null && health.status !== "healthy";

  return (
    <DashboardContext.Provider
      value={{
        mode,
        setMode,
        toggleMode,
        health,
        isBackendOffline,
        refreshKey,
        triggerRefresh,
        isRefreshing,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
};

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) {
    throw new Error("useDashboard must be used within DashboardProvider");
  }
  return ctx;
}

