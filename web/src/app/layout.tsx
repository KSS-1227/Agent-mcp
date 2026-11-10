import "./globals.css";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { DashboardProvider } from "@/lib/dashboard-context";

export const metadata: Metadata = {
  title: "Agent Safety MCP | Operational Control Plane",
  description:
    "Account-scoped activity dashboard for Agent Safety MCP.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const requestHeaders = await headers();
  const scope = requestHeaders.get("x-dashboard-scope") === "operator" ? "operator" : "user";
  const userEmail = scope === "user" ? requestHeaders.get("x-dashboard-user-email") : null;

  return (
    <html lang="en">
      <body className="bg-[#F6F5F1] text-[#252722]">
        <DashboardProvider scope={scope} userEmail={userEmail}>{children}</DashboardProvider>
      </body>
    </html>
  );
}

