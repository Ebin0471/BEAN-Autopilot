import type { Metadata } from "next";
import "./globals.css";
import { Shell } from "@/components/Shell";

export const metadata: Metadata = {
  title: "BEAN Autopilot — Universal AI Operating System",
  description:
    "A permission-controlled, chat-first AI operating system for personal, professional and business workspaces. UI-01 foundation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
