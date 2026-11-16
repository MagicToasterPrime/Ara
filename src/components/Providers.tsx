"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";
import { SpixProvider } from "@/components/SpixContext";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <SpixProvider>{children}</SpixProvider>
    </SessionProvider>
  );
}
