import "./globals.css";
import type { Metadata } from "next";
import { DashboardProvider } from "@/lib/dashboard-context";

export const metadata: Metadata = {
  title: "Agent Safety MCP | Operational Control Plane",
  description:
    "Production-quality engineering dashboard for Agent Safety MCP: crash-safe action execution, conflict detection, and reconciliation.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-[#F6F5F1] text-[#252722]">
        <DashboardProvider>{children}</DashboardProvider>
      </body>
    </html>
  );
}

