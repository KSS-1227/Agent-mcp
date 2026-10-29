"use client";

import React, { useState } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { DemoBanner } from "./DemoBanner";
import { useDashboard } from "@/lib/dashboard-context";

interface AppLayoutProps {
  title: string;
  children: React.ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ title, children }) => {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { mode, toggleMode, setMode, health, isBackendOffline, triggerRefresh, isRefreshing } =
    useDashboard();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#F6F5F1] font-sans antialiased text-[#252722]">
      {/* Sidebar */}
      <Sidebar
        isOpenMobile={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      {/* Main Column */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Navigation */}
        <TopBar
          title={title}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          health={health}
          mode={mode}
          onToggleMode={toggleMode}
          onRefresh={triggerRefresh}
          isRefreshing={isRefreshing}
        />

        {/* Demo / Offline Warning Banner */}
        <DemoBanner
          mode={mode}
          isBackendOffline={isBackendOffline}
          onSwitchToDemo={() => setMode("demo")}
        />

        {/* Scrollable Viewport */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 space-y-6">
          {children}
        </main>
      </div>
    </div>
  );
};

