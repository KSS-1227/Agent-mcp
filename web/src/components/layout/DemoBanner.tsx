import React from "react";
import { Info, AlertCircle } from "lucide-react";

interface DemoBannerProps {
  mode: "live" | "demo";
  isBackendOffline?: boolean;
  onSwitchToDemo?: () => void;
}

export const DemoBanner: React.FC<DemoBannerProps> = ({
  mode,
  isBackendOffline,
  onSwitchToDemo,
}) => {
  if (mode === "demo") {
    return (
      <div className="bg-[#FAF4E8] border-b border-[#E9D8B4] px-4 py-1.5 text-xs text-[#8C631B] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Info className="w-4 h-4 shrink-0 text-[#B58533]" />
          <span>
            <strong>DEMO MODE:</strong> Showing deterministic domain telemetry for verification and screenshots. No records are written to PostgreSQL or Supabase.
          </span>
        </div>
        <span className="text-[10px] font-mono uppercase bg-[#E9D8B4] px-1.5 py-0.5 rounded text-[#6E4B0E]">
          Read-Only Fixtures
        </span>
      </div>
    );
  }

  if (isBackendOffline) {
    return (
      <div className="bg-[#F9ECEB] border-b border-[#E5BCB9] px-4 py-2 text-xs text-[#872B28] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-[#A8423F]" />
          <span>
            <strong>Live data unavailable:</strong> this dashboard process could not verify PostgreSQL
            and/or the Agent Safety MCP daemon, so live queries cannot be shown. Open Settings to see
            the exact probe result recorded for this session.
          </span>
        </div>
        {onSwitchToDemo && (
          <button
            onClick={onSwitchToDemo}
            className="text-xs font-semibold underline hover:text-[#5B1B18] transition-colors"
          >
            Switch to Demo Mode →
          </button>
        )}
      </div>
    );
  }

  return null;
};

