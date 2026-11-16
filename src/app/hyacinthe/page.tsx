"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { HyacinthePanel } from "@/components/HyacinthePanel";

interface UEOption {
  id: string;
  code: string;
  title: string;
}

export default function HyacinthePage() {
  const [ues, setUes] = useState<UEOption[]>([]);

  useEffect(() => {
    fetch("/api/ues", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { ues?: UEOption[] } | null) => {
        if (data?.ues) setUes(data.ues);
      })
      .catch(() => {});
  }, []);

  return (
    <AppShell>
      <div className="mx-auto flex h-[calc(100vh-220px)] min-h-[580px] max-w-5xl flex-col border border-border bg-card">
        <HyacinthePanel ues={ues} />
      </div>
    </AppShell>
  );
}
