"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  CheckCircle2,
  Clock,
  Database,
  HardDrive,
  ListChecks,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  UserCheck,
  UserX,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import {
  CLASS_LEVELS,
  EXAM_TYPES,
  formatExamBadge,
  type ClassLevel,
} from "@/lib/class-levels";
import type { BackgroundQueueSnapshot, IndexingQueueItem } from "@/lib/studio";

const ACCENT_COLORS = [
  { label: "AMBRE", hex: "#D99B26" },
  { label: "CARMIN", hex: "#C83E4D" },
  { label: "VERT FORÊT", hex: "#3B7A57" },
  { label: "BLEU ARDOISE", hex: "#3D6B99" },
  { label: "TERRACOTTA", hex: "#C85A32" },
  { label: "BORDEAUX", hex: "#8C2D41" },
  { label: "INDIGO", hex: "#3F4E8C" },
  { label: "BLEU CANARD", hex: "#1F7A8C" },
  { label: "ÉMERAUDE", hex: "#2A8C6A" },
  { label: "VERT SAUGE", hex: "#6B8E63" },
  { label: "OCRE CUIVRÉ", hex: "#B87333" },
  { label: "PRUNE", hex: "#6E3B7A" },
  { label: "VIOLET COBALT", hex: "#5B4B8A" },
  { label: "VIEUX ROSE", hex: "#B55D7A" },
  { label: "BLEU NUIT", hex: "#243B55" },
  { label: "ANTHRACITE", hex: "#4A4E54" },
];

interface HealthData {
  ollama: {
    online: boolean;
    host: string;
    models: string[];
    configuredModel: string;
    embedModel: string;
    error?: string;
  };
  storage: {
    uploadDir: string;
    fileCount: number;
    totalBytes: number;
  };
  stats: {
    userCount: number;
    ueCount: number;
    documentCount: number;
    indexedDocumentCount: number;
    chunkCount: number;
    whiteboardCount: number;
    channelCount: number;
  };
  users?: Array<{
    id: string;
    name: string;
    email: string;
    globalRole: "STUDENT" | "YEAR_ADMIN";
    classLevel: ClassLevel;
    isApproved: boolean;
    createdAt: string;
    ueRoles: Array<{
      id: string;
      ueId: string;
      ue: { id: string; code: string; title: string };
    }>;
  }>;
}

interface UEAdminItem {
  id: string;
  code: string;
  title: string;
  description: string;
  semester: string;
  classLevel?: ClassLevel;
  examType?: string;
  examDate?: string | null;
  coeff?: number;
  accentColor: string;
  order: number;
  roles: Array<{
    id: string;
    user: { id: string; name: string; email: string };
  }>;
  channels: Array<{ id: string; name: string }>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}

function formatEtaSeconds(totalSeconds: number): string {
  const sec = Math.max(0, Math.round(totalSeconds));
  if (sec < 60) return `${sec} s`;
  const hours = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const remSec = sec % 60;
  if (hours > 0) {
    return `${hours} h ${String(mins).padStart(2, "0")} min`;
  }
  return remSec > 0 ? `${mins} min ${remSec} s` : `${mins} min`;
}

interface IndexingChapterGroup {
  chapterId: string;
  ueCode: string;
  chapterTitle: string;
  docCount: number;
  remainingChunks: number;
  hasRunningDoc: boolean;
}

function groupIndexingByChapter(
  items: IndexingQueueItem[]
): IndexingChapterGroup[] {
  const map = new Map<string, IndexingChapterGroup>();
  for (const item of items) {
    const remaining = Math.max(0, item.totalChunks - item.embeddedChunks);
    const existing = map.get(item.chapterId);
    if (existing) {
      existing.docCount += 1;
      existing.remainingChunks += remaining;
      if (item.status === "RUNNING") {
        existing.hasRunningDoc = true;
      }
    } else {
      map.set(item.chapterId, {
        chapterId: item.chapterId,
        ueCode: item.ueCode,
        chapterTitle: item.chapterTitle,
        docCount: 1,
        remainingChunks: remaining,
        hasRunningDoc: item.status === "RUNNING",
      });
    }
  }
  return Array.from(map.values());
}

export default function AdminPage() {
  const { data: session } = useSession();
  const isYearAdmin = session?.user?.globalRole === "YEAR_ADMIN";

  const [health, setHealth] = useState<HealthData | null>(null);
  const [ues, setUes] = useState<UEAdminItem[]>([]);
  const [queue, setQueue] = useState<BackgroundQueueSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  // Reindex RAG & Background Queue Controls
  const [reindexing, setReindexing] = useState(false);
  const [reindexMsg, setReindexMsg] = useState<string | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);

  // UE Form
  const [editingUeId, setEditingUeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [semester, setSemester] = useState("S1");
  const [ueClassLevel, setUeClassLevel] = useState<ClassLevel>("VET2");
  const [examType, setExamType] = useState<string>("PARTIEL");
  const [examDate, setExamDate] = useState<string>("");
  const [coeff, setCoeff] = useState<number>(4);
  const [accentColor, setAccentColor] = useState("#D99B26");
  const [order, setOrder] = useState(1);
  const [ueError, setUeError] = useState<string | null>(null);
  const [savingUe, setSavingUe] = useState(false);

  // Role assignment
  const [roleUeId, setRoleUeId] = useState("");
  const [roleUserId, setRoleUserId] = useState("");
  const [assigningRole, setAssigningRole] = useState(false);

  const fetchQueue = useCallback(async () => {
    try {
      const qRes = await fetch("/api/system/queue", { cache: "no-store" });
      if (qRes.ok) {
        const qData = (await qRes.json()) as {
          queue?: BackgroundQueueSnapshot;
        };
        if (qData.queue) {
          setQueue(qData.queue);
        }
      }
    } catch {
      // Ignore transient polling failures
    }
  }, []);

  const fetchAdminData = useCallback(async () => {
    try {
      const [hRes, uRes, qRes] = await Promise.all([
        fetch("/api/system/health", { cache: "no-store" }),
        fetch("/api/ues", { cache: "no-store" }),
        fetch("/api/system/queue", { cache: "no-store" }),
      ]);
      if (hRes.ok) {
        const hData = (await hRes.json()) as HealthData;
        setHealth(hData);
        if (hData.users?.length && !roleUserId) {
          setRoleUserId(hData.users[0].id);
        }
      }
      if (uRes.ok) {
        const uData = (await uRes.json()) as { ues: UEAdminItem[] };
        setUes(uData.ues);
        if (uData.ues.length && !roleUeId) {
          setRoleUeId(uData.ues[0].id);
        }
      }
      if (qRes.ok) {
        const qData = (await qRes.json()) as {
          queue?: BackgroundQueueSnapshot;
        };
        if (qData.queue) {
          setQueue(qData.queue);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [roleUeId, roleUserId]);

  useEffect(() => {
    void fetchAdminData();
  }, [fetchAdminData]);

  const wasRunningRef = useRef(false);

  useEffect(() => {
    const running = Boolean(queue?.worker.isRunning);
    if (wasRunningRef.current && !running) {
      void fetchAdminData();
    }
    wasRunningRef.current = running;

    if (!running) return;
    const interval = setInterval(() => {
      void fetchQueue();
    }, 3000);
    return () => {
      clearInterval(interval);
    };
  }, [queue?.worker.isRunning, fetchQueue, fetchAdminData]);

  async function handleQueueAction(
    action: "START_ALL" | "START_INDEXING" | "START_AI" | "STOP",
    target?: { chapterId?: string; documentId?: string }
  ) {
    setQueueBusy(true);
    setQueueError(null);
    try {
      const res = await fetch("/api/system/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          chapterId: target?.chapterId,
          documentId: target?.documentId,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        queue?: BackgroundQueueSnapshot;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        setQueueError(
          data.message || data.error || "Erreur lors du pilotage de la file."
        );
        return;
      }
      if (data.queue) {
        setQueue(data.queue);
      }
    } finally {
      setQueueBusy(false);
    }
  }

  async function handleReindexAll() {
    setReindexing(true);
    setReindexMsg(null);
    try {
      const res = await fetch("/api/system/reindex", { method: "POST" });
      const data = (await res.json()) as {
        indexedCount?: number;
        totalCount?: number;
        failedCount?: number;
        message?: string;
      };
      if (!res.ok) {
        setReindexMsg(data.message || "Erreur lors de la ré-indexation.");
      } else {
        setReindexMsg(
          `Ré-indexation terminée : ${data.indexedCount}/${data.totalCount} documents indexés dans pgvector.`
        );
        await fetchAdminData();
      }
    } finally {
      setReindexing(false);
    }
  }

  function startEditUe(ue: UEAdminItem) {
    setEditingUeId(ue.id);
    setCode(ue.code);
    setTitle(ue.title);
    setDescription(ue.description);
    setSemester(ue.semester);
    setUeClassLevel(ue.classLevel || "VET2");
    setExamType(ue.examType || "PARTIEL");
    setExamDate(ue.examDate || "");
    setCoeff(ue.coeff ?? 4);
    setAccentColor(ue.accentColor);
    setOrder(ue.order);
    setUeError(null);
  }

  function resetUeForm() {
    setEditingUeId(null);
    setCode("");
    setTitle("");
    setDescription("");
    setSemester("S1");
    setUeClassLevel("VET2");
    setExamType("PARTIEL");
    setExamDate("");
    setCoeff(4);
    setAccentColor("#D99B26");
    setOrder(ues.length + 1);
    setUeError(null);
  }

  async function handleSaveUe(e: React.FormEvent) {
    e.preventDefault();
    setUeError(null);
    setSavingUe(true);

    try {
      const endpoint = editingUeId ? `/api/ues/${editingUeId}` : "/api/ues";
      const method = editingUeId ? "PATCH" : "POST";

      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          title: title.trim(),
          description: description.trim(),
          semester: semester.trim(),
          classLevel: ueClassLevel,
          examType,
          examDate: examDate.trim() || null,
          coeff: Number(coeff),
          accentColor,
          order: Number(order),
        }),
      });

      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setUeError(data.error || "Erreur lors de l'enregistrement.");
        return;
      }

      resetUeForm();
      await fetchAdminData();
    } finally {
      setSavingUe(false);
    }
  }

  async function handleDeleteUe(ueId: string) {
    if (
      !confirm(
        "Supprimer cette UE ainsi que tous ses chapitres, PDF et son canal ?"
      )
    ) {
      return;
    }
    const res = await fetch(`/api/ues/${ueId}`, { method: "DELETE" });
    if (res.ok) {
      if (editingUeId === ueId) resetUeForm();
      await fetchAdminData();
    }
  }

  async function handleAssignRole(e: React.FormEvent) {
    e.preventDefault();
    if (!roleUeId || !roleUserId || assigningRole) return;
    setAssigningRole(true);
    try {
      const res = await fetch(`/api/ues/${roleUeId}/roles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: roleUserId }),
      });
      if (res.ok) {
        await fetchAdminData();
      }
    } finally {
      setAssigningRole(false);
    }
  }

  async function handleRevokeRole(ueId: string, userId: string) {
    const res = await fetch(
      `/api/ues/${ueId}/roles?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      await fetchAdminData();
    }
  }

  async function handleUpdateUser(
    userId: string,
    patch: {
      isApproved?: boolean;
      classLevel?: ClassLevel;
      globalRole?: "STUDENT" | "YEAR_ADMIN";
    }
  ) {
    const res = await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, ...patch }),
    });
    if (res.ok) {
      await fetchAdminData();
    }
  }

  async function handleDeleteUser(userId: string, label: string) {
    if (
      !confirm(
        `Refuser et supprimer définitivement le compte de ${label} ?`
      )
    ) {
      return;
    }
    const res = await fetch(
      `/api/admin/users?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      await fetchAdminData();
    }
  }

  const allUsers = health?.users || [];
  const pendingUsers = allUsers.filter((u) => !u.isApproved);
  const approvedUsers = allUsers.filter((u) => u.isApproved);

  if (!isYearAdmin) {
    return (
      <AppShell>
        <div className="border border-carmine/40 bg-card p-8 text-center">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-carmine" />
          <h1 className="font-mono text-sm font-bold uppercase tracking-wider text-ink">
            ACCÈS RESTREINT · RESPONSABLE D&apos;ANNÉE UNIQUEMENT
          </h1>
          <p className="mt-2 text-sm text-stone">
            Cette console de gouvernance est réservée au compte{" "}
            <span className="font-mono">YEAR_ADMIN</span>.
          </p>
        </div>
      </AppShell>
    );
  }

  const indexingChapters = queue
    ? groupIndexingByChapter(queue.indexingQueue)
    : [];

  return (
    <AppShell>
      <div className="space-y-8">
        {/* Page Header */}
        <div className="border-b border-border pb-4">
          <h1 className="text-lg font-bold uppercase tracking-tight text-ink">
            CONSOLE DE GOUVERNANCE &amp; SANTÉ SYSTÈME
          </h1>
          <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
            [ PILOTAGE YEAR_ADMIN · CRUD UE · NOMINATION UE_MANAGER · INDEXATION RAG ]
          </p>
        </div>

        {/* Section 1: System Health & Off-Peak Queue */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              01 / MONITORING SANTÉ, FILES D&apos;ATTENTE HEURES CREUSES (00H–07H) &amp; ETA
            </h2>
            <button
              type="button"
              onClick={handleReindexAll}
              disabled={reindexing}
              className="inline-flex items-center gap-2 border border-border bg-paper px-3.5 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:border-ink disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${reindexing ? "animate-spin" : ""}`}
              />
              <span>
                {reindexing
                  ? "RÉ-INDEXATION COMPLÈTE..."
                  : "FORCER RÉ-INDEXATION SYNCHRONE"}
              </span>
            </button>
          </div>

          {reindexMsg && (
            <div className="border border-border bg-pinned px-4 py-2.5 font-mono text-xs text-ink">
              {reindexMsg}
            </div>
          )}

          {loading || !health ? (
            <div className="border border-border bg-card p-6 font-mono text-xs uppercase text-stone">
              COLLECTE DES MÉTRIQUES SYSTÈME...
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {/* Ollama Card */}
                <div
                  className="border border-border bg-card p-4"
                  style={{
                    borderTop: `3px solid ${
                      health.ollama.online ? "#3B7A57" : "#C83E4D"
                    }`,
                  }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-stone">
                      SERVEUR OLLAMA LOCAL
                    </span>
                    <Server className="h-4 w-4 text-stone" />
                  </div>
                  <p
                    className={`font-mono text-sm font-bold uppercase ${
                      health.ollama.online ? "text-forest" : "text-carmine"
                    }`}
                  >
                    {health.ollama.online
                      ? "EN LIGNE"
                      : `HORS-LIGNE (${health.ollama.host.replace(
                          /^https?:\/\//,
                          ""
                        )})`}
                  </p>
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-stone">
                    LLM : {health.ollama.configuredModel} · EMBED :{" "}
                    {health.ollama.embedModel}
                  </p>
                </div>

                {/* Storage Card */}
                <div
                  className="border border-border bg-card p-4"
                  style={{ borderTop: "3px solid #D99B26" }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-stone">
                      STOCKAGE LOCAL PDF
                    </span>
                    <HardDrive className="h-4 w-4 text-stone" />
                  </div>
                  <p className="font-mono text-sm font-bold text-ink">
                    {formatBytes(health.storage.totalBytes)} ·{" "}
                    {health.storage.fileCount} FICHIERS
                  </p>
                  <p className="mt-2 truncate font-mono text-[10px] uppercase tracking-wider text-stone">
                    ./storage/uploads/
                  </p>
                </div>

                {/* Vector DB Card */}
                <div
                  className="border border-border bg-card p-4"
                  style={{ borderTop: "3px solid #3D6B99" }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-stone">
                      INDEX VECTORIEL PGVECTOR
                    </span>
                    <Database className="h-4 w-4 text-stone" />
                  </div>
                  <p className="font-mono text-sm font-bold text-ink">
                    {health.stats.indexedDocumentCount} /{" "}
                    {health.stats.documentCount} PDF INDEXÉS
                  </p>
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-stone">
                    {health.stats.chunkCount} CHUNKS · {health.stats.userCount}{" "}
                    UTILISATEURS · {health.stats.ueCount} UE
                  </p>
                </div>
              </div>

              {/* Live Background Queue, Progress & ETA Console */}
              {queue && (
                <div
                  className="border border-ink bg-card p-5"
                  style={{
                    borderTop: `3px solid ${
                      queue.worker.isRunning ? "#D99B26" : "#1A1A1A"
                    }`,
                  }}
                >
                  <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${
                            queue.worker.isRunning
                              ? "border-amber bg-amber/15 text-ink"
                              : "border-border bg-paper text-stone"
                          }`}
                        >
                          {queue.worker.isRunning ? (
                            <Loader2 className="h-3 w-3 animate-spin text-amber" />
                          ) : (
                            <Clock className="h-3 w-3" />
                          )}
                          <span>
                            {queue.worker.isRunning
                              ? queue.worker.mode === "NIGHTLY_AUTO"
                                ? "EN COURS · MODE AUTO 00H–07H"
                                : "EN COURS · LANCÉ PAR ADMIN"
                              : `EN VEILLE · ${queue.worker.nextNightlyWindowLabel}`}
                          </span>
                        </span>

                        <span className="border border-ink bg-ink px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-card">
                          ETA TOTAL :{" "}
                          {queue.eta.totalEtaSeconds > 0
                            ? `~${formatEtaSeconds(queue.eta.totalEtaSeconds)}`
                            : "FILE VIDE (0 S)"}
                        </span>
                      </div>

                      <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
                        INDEXATION :{" "}
                        <span className="font-semibold text-ink">
                          {queue.eta.indexingEtaSeconds > 0
                            ? `~${formatEtaSeconds(queue.eta.indexingEtaSeconds)}`
                            : "0 s"}
                        </span>{" "}
                        ({queue.counts.pendingIndexingChunks} CHUNKS) · CONTENU
                        IA :{" "}
                        <span className="font-semibold text-ink">
                          {queue.eta.aiEtaSeconds > 0
                            ? `~${formatEtaSeconds(queue.eta.aiEtaSeconds)}`
                            : "0 s"}
                        </span>{" "}
                        ({queue.counts.pendingAiArtifacts} TÂCHES)
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void fetchQueue()}
                        disabled={queueBusy}
                        className="inline-flex items-center gap-1.5 border border-border bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-50"
                      >
                        <RefreshCw className="h-3 w-3" />
                        <span>ACTUALISER</span>
                      </button>

                      {!queue.worker.isRunning ? (
                        <>
                          <button
                            type="button"
                            disabled={
                              queueBusy ||
                              (queue.counts.unindexedDocuments === 0 &&
                                queue.counts.pendingAiArtifacts === 0)
                            }
                            onClick={() => void handleQueueAction("START_ALL")}
                            className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-45"
                          >
                            <Play className="h-3 w-3" />
                            <span>LANCER TOUTE LA FILE</span>
                          </button>

                          <button
                            type="button"
                            disabled={
                              queueBusy || queue.counts.unindexedDocuments === 0
                            }
                            onClick={() =>
                              void handleQueueAction("START_INDEXING")
                            }
                            className="inline-flex items-center gap-1.5 border border-border bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-45"
                          >
                            <Database className="h-3 w-3" />
                            <span>
                              INDEXER PDF ({queue.counts.unindexedDocuments})
                            </span>
                          </button>

                          <button
                            type="button"
                            disabled={
                              queueBusy || queue.counts.pendingAiArtifacts === 0
                            }
                            onClick={() => void handleQueueAction("START_AI")}
                            className="inline-flex items-center gap-1.5 border border-border bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-45"
                          >
                            <Sparkles className="h-3 w-3" />
                            <span>
                              GÉNÉRER IA ({queue.counts.pendingAiArtifacts})
                            </span>
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={queueBusy || queue.worker.stopRequested}
                          onClick={() => void handleQueueAction("STOP")}
                          className="inline-flex items-center gap-1.5 border border-carmine bg-carmine px-3.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-card hover:bg-carmine/90 disabled:opacity-60"
                        >
                          <Square className="h-3 w-3" />
                          <span>
                            {queue.worker.stopRequested
                              ? "ARRÊT EN COURS..."
                              : "STOPPER APRÈS LA TÂCHE EN COURS"}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>

                  {queueError && (
                    <div className="mt-3 border border-carmine/40 bg-carmine/10 px-3 py-2 font-mono text-xs text-carmine">
                      {queueError}
                    </div>
                  )}

                  {/* Progress Bars */}
                  <div className="mt-4 space-y-3">
                    <div>
                      <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider">
                        <span className="text-ink">
                          PROGRESSION GLOBALE
                          {queue.worker.isRunning &&
                          queue.worker.totalItemsInRun > 0
                            ? ` · EXÉCUTION EN COURS (${queue.worker.completedItemsInRun}/${queue.worker.totalItemsInRun})`
                            : ` · COUVERTURE BASE (${
                                queue.counts.indexedDocuments
                              }/${queue.counts.totalDocuments} PDF INDEXÉS${
                                queue.counts.errorDocuments > 0
                                  ? ` · ${queue.counts.errorDocuments} EN ERREUR`
                                  : ""
                              } · ${
                                queue.counts.completedPublicAiArtifacts
                              }/${queue.counts.totalExpectedAiArtifacts} CONTENUS IA)`}
                        </span>
                        <span className="font-bold text-ink">
                          {queue.worker.overallProgressPercent}%
                        </span>
                      </div>
                      <div className="h-2.5 w-full border border-border bg-paper">
                        <div
                          className="h-full transition-all duration-300"
                          style={{
                            width: `${queue.worker.overallProgressPercent}%`,
                            backgroundColor: queue.worker.isRunning
                              ? "#D99B26"
                              : "#3B7A57",
                          }}
                        />
                      </div>
                    </div>

                    {queue.worker.isRunning && queue.worker.currentTaskLabel && (
                      <div className="border border-amber/60 bg-pinned p-3">
                        <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider">
                          <span className="flex items-center gap-1.5 font-bold text-ink">
                            <Loader2 className="h-3 w-3 animate-spin text-amber" />
                            <span>
                              TÂCHE ACTIVE : {queue.worker.currentTaskLabel}
                            </span>
                          </span>
                          <span className="font-bold text-ink">
                            {queue.worker.currentItemProgressPercent}%
                          </span>
                        </div>
                        <div className="h-2 w-full border border-border bg-card">
                          <div
                            className="h-full bg-ink transition-all duration-300"
                            style={{
                              width: `${queue.worker.currentItemProgressPercent}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {!queue.worker.isRunning && queue.worker.lastRunSummary && (
                      <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                        DERNIÈRE EXÉCUTION{" "}
                        {queue.worker.lastRunAt
                          ? `(${new Date(
                              queue.worker.lastRunAt
                            ).toLocaleTimeString("fr-FR")}) `
                          : ""}
                        : {queue.worker.lastRunSummary}
                      </p>
                    )}
                  </div>

                  {/* Two Queue Columns: Indexing Queue & AI Generation Queue */}
                  <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {/* Queue 1: RAG Indexing */}
                    <div className="border border-border bg-paper/40">
                      <div className="flex items-center justify-between border-b border-border bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-ink">
                        <span className="inline-flex items-center gap-1.5">
                          <Database className="h-3.5 w-3.5 text-slate" />
                          <span>
                            FILE D&apos;INDEXATION RAG ({queue.indexingQueue.length}
                            )
                          </span>
                        </span>
                        <span className="text-[10px] text-stone">
                          {queue.eta.avgMsPerChunk} MS / CHUNK
                        </span>
                      </div>

                      {queue.indexingQueue.length === 0 ? (
                        <div className="flex items-center gap-2 p-4 font-mono text-xs text-forest">
                          <CheckCircle2 className="h-4 w-4" />
                          <span>
                            TOUS LES DOCUMENTS PDF SONT INDEXÉS DANS PGVECTOR.
                          </span>
                        </div>
                      ) : (
                        <div>
                          {/* Quick Force Indexing by Chapter */}
                          <div className="border-b border-border bg-paper/70 px-3.5 py-2.5">
                            <div className="mb-2 flex items-center justify-between font-mono text-[10px] font-semibold uppercase tracking-wider text-stone">
                              <span>FORCER L&apos;INDEXATION D&apos;UN CHAPITRE</span>
                              <span>
                                {indexingChapters.length} CHAPITRE(S)
                              </span>
                            </div>
                            <div className="max-h-36 space-y-1.5 overflow-y-auto pr-0.5">
                              {indexingChapters.map((grp) => {
                                  const grpEtaSec = Math.ceil(
                                    (grp.remainingChunks * queue.eta.avgMsPerChunk) /
                                      1000
                                  );
                                  return (
                                    <div
                                      key={grp.chapterId}
                                      className="flex items-center justify-between gap-2 border border-border bg-card px-2.5 py-1.5"
                                    >
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5">
                                          <span className="bg-badge-bg px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-badge-text">
                                            {grp.ueCode}
                                          </span>
                                          <span className="truncate text-xs font-semibold text-ink">
                                            {grp.chapterTitle}
                                          </span>
                                        </div>
                                        <p className="mt-0.5 font-mono text-[9px] uppercase text-stone">
                                          {grp.docCount} PDF · ~
                                          {formatEtaSeconds(grpEtaSec)}
                                        </p>
                                      </div>
                                      <button
                                        type="button"
                                        disabled={queueBusy || queue.worker.isRunning}
                                        onClick={() =>
                                          handleQueueAction("START_INDEXING", {
                                            chapterId: grp.chapterId,
                                          })
                                        }
                                        className="inline-flex shrink-0 items-center gap-1 border border-ink bg-ink px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-40"
                                      >
                                        <Play className="h-2.5 w-2.5" />
                                        <span>
                                          {grp.hasRunningDoc
                                            ? "EN COURS"
                                            : "FORCER CE CHAPITRE"}
                                        </span>
                                      </button>
                                    </div>
                                  );
                                })}
                            </div>
                          </div>

                          <div className="max-h-64 divide-y divide-border overflow-y-auto bg-card">
                            {queue.indexingQueue.map((item) => {
                              const remChunks = Math.max(
                                0,
                                item.totalChunks - item.embeddedChunks
                              );
                              const itemEtaSec = Math.ceil(
                                (remChunks * queue.eta.avgMsPerChunk) / 1000
                              );
                              const pct =
                                item.totalChunks > 0
                                  ? Math.round(
                                      (item.embeddedChunks / item.totalChunks) *
                                        100
                                    )
                                  : 0;

                              return (
                                <div
                                  key={item.documentId}
                                  className={`flex items-center justify-between gap-3 px-3.5 py-2.5 ${
                                    item.status === "RUNNING"
                                      ? "bg-pinned"
                                      : "bg-card"
                                  }`}
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <span className="bg-badge-bg px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-badge-text">
                                        {item.ueCode}
                                      </span>
                                      <span
                                        className={`border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase ${
                                          item.status === "RUNNING"
                                            ? "border-amber bg-amber/20 text-ink"
                                            : "border-border bg-paper text-stone"
                                        }`}
                                      >
                                        {item.status === "RUNNING"
                                          ? "EN COURS"
                                          : "00H–07H"}
                                      </span>
                                      <span className="truncate font-mono text-[9px] uppercase text-stone">
                                        {item.chapterTitle}
                                      </span>
                                    </div>
                                    <p className="mt-1 truncate text-xs font-bold text-ink">
                                      {item.title}
                                    </p>
                                    <p className="font-mono text-[10px] uppercase text-stone">
                                      {item.pageCount} P. · {item.embeddedChunks}/
                                      {item.totalChunks} CHUNKS ({pct}%)
                                    </p>
                                  </div>

                                  <div className="flex shrink-0 flex-col items-end gap-1">
                                    <span className="font-mono text-[10px] font-semibold uppercase text-ink">
                                      ~{formatEtaSeconds(itemEtaSec)}
                                    </span>
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        disabled={queueBusy || queue.worker.isRunning}
                                        onClick={() =>
                                          handleQueueAction("START_INDEXING", {
                                            chapterId: item.chapterId,
                                          })
                                        }
                                        className="inline-flex items-center gap-1 border border-border bg-paper px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-ink hover:border-ink disabled:opacity-40"
                                      >
                                        <Play className="h-2.5 w-2.5" />
                                        <span>INDEXER CHAPITRE</span>
                                      </button>
                                      <button
                                        type="button"
                                        disabled={queueBusy || queue.worker.isRunning}
                                        onClick={() =>
                                          handleQueueAction("START_INDEXING", {
                                            documentId: item.documentId,
                                          })
                                        }
                                        className="inline-flex items-center gap-1 border border-border bg-paper px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-ink hover:border-ink disabled:opacity-40"
                                      >
                                        <Play className="h-2.5 w-2.5" />
                                        <span>INDEXER PDF</span>
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Queue 2: AI Content Generation */}
                    <div className="border border-border bg-paper/40">
                      <div className="flex items-center justify-between border-b border-border bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-ink">
                        <span className="inline-flex items-center gap-1.5">
                          <ListChecks className="h-3.5 w-3.5 text-forest" />
                          <span>
                            FILE CONTENUS IA ({queue.aiContentQueue.length})
                          </span>
                        </span>
                        <span className="text-[10px] text-stone">
                          ~{Math.round(queue.eta.avgMsPerAiArtifact / 1000)} S /
                          TÂCHE
                        </span>
                      </div>

                      {queue.aiContentQueue.length === 0 ? (
                        <div className="flex items-center gap-2 p-4 font-mono text-xs text-forest">
                          <CheckCircle2 className="h-4 w-4" />
                          <span>
                            TOUS LES COURS ONT LEUR FICHE, FLASHCARDS ET QUIZ
                            PUBLICS.
                          </span>
                        </div>
                      ) : (
                        <div className="max-h-64 divide-y divide-border overflow-y-auto bg-card">
                          {queue.aiContentQueue.map((item) => {
                            const itemEtaSec = Math.ceil(
                              queue.eta.avgMsPerAiArtifact / 1000
                            );
                            return (
                              <div
                                key={item.id}
                                className={`flex items-center justify-between gap-3 px-3.5 py-2.5 ${
                                  item.status === "RUNNING"
                                    ? "bg-pinned"
                                    : "bg-card"
                                }`}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="bg-badge-bg px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-badge-text">
                                      {item.ueCode}
                                    </span>
                                    <span className="border border-ink bg-ink px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-card">
                                      {item.label}
                                    </span>
                                    <span
                                      className={`border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase ${
                                        item.status === "RUNNING"
                                          ? "border-amber bg-amber/20 text-ink"
                                          : "border-border bg-paper text-stone"
                                      }`}
                                    >
                                      {item.status === "RUNNING"
                                        ? "EN COURS"
                                        : "00H–07H"}
                                    </span>
                                  </div>
                                  <p className="mt-1 truncate text-xs font-bold text-ink">
                                    {item.documentTitle}
                                  </p>
                                  <p className="font-mono text-[10px] uppercase text-stone">
                                    {item.chapterTitle} · {item.fileName}
                                  </p>
                                </div>

                                <span className="shrink-0 font-mono text-[10px] font-semibold uppercase text-ink">
                                  ~{formatEtaSeconds(itemEtaSec)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Section 2: Pending Account Approvals & Class Governance */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              02 / VALIDATION DES COMPTES &amp; GESTION DES CLASSES (PACENV · VET2–VET6)
            </h2>
            <span
              className={`border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                pendingUsers.length > 0
                  ? "border-amber bg-amber/15 text-ink"
                  : "border-forest/40 bg-forest/10 text-forest"
              }`}
            >
              {pendingUsers.length > 0
                ? `${pendingUsers.length} EN ATTENTE DE VALIDATION`
                : "AUCUNE DEMANDE EN ATTENTE"}
            </span>
          </div>

          <div
            className="border border-border bg-card"
            style={{
              borderTop: `3px solid ${
                pendingUsers.length > 0 ? "#D99B26" : "#3B7A57"
              }`,
            }}
          >
            <div className="border-b border-border bg-paper px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              FILE D&apos;ATTENTE D&apos;INSCRIPTION ({pendingUsers.length})
            </div>

            {pendingUsers.length === 0 ? (
              <div className="flex items-center gap-2.5 p-5 font-mono text-xs uppercase tracking-wider text-stone">
                <CheckCircle2 className="h-4 w-4 text-forest" />
                <span>
                  TOUS LES COMPTES INSCRITS ONT ÉTÉ TRAITÉS PAR L&apos;ADMINISTRATION.
                </span>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {pendingUsers.map((u) => (
                  <div
                    key={u.id}
                    className="flex flex-wrap items-center justify-between gap-4 p-4"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1 border border-amber/60 bg-amber/15 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink">
                          <Clock className="h-3 w-3 text-amber" />
                          EN ATTENTE
                        </span>
                        <span className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-badge-text">
                          {u.classLevel}
                        </span>
                        <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                          INSCRIT LE{" "}
                          {new Date(u.createdAt).toLocaleDateString("fr-FR")}
                        </span>
                      </div>
                      <p className="mt-1 text-sm font-bold text-ink">
                        {u.name}
                      </p>
                      <p className="font-mono text-[11px] text-stone">
                        {u.email}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={u.classLevel}
                        onChange={(e) =>
                          handleUpdateUser(u.id, {
                            classLevel: e.target.value as ClassLevel,
                          })
                        }
                        aria-label={`Classe de ${u.name}`}
                        className="border border-border bg-paper px-2.5 py-1.5 font-mono text-xs uppercase text-ink focus:border-ink focus:outline-none"
                      >
                        {CLASS_LEVELS.map((lvl) => (
                          <option key={lvl} value={lvl}>
                            {lvl}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateUser(u.id, { isApproved: true })
                        }
                        className="inline-flex items-center gap-1.5 border border-ink bg-forest px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-wider text-card hover:bg-forest/90"
                      >
                        <UserCheck className="h-3.5 w-3.5" />
                        <span>VALIDER L&apos;ACCÈS</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteUser(u.id, u.name)}
                        className="inline-flex items-center gap-1.5 border border-carmine bg-paper px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-carmine hover:bg-carmine hover:text-card"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>REFUSER &amp; SUPPRIMER</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Section 3: CRUD UE */}
        <section className="space-y-4">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
            03 / CRÉATION &amp; GESTION DES UNITÉS D&apos;ENSEIGNEMENT
          </h2>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* UE Form */}
            <form
              onSubmit={handleSaveUe}
              className="space-y-4 border border-border bg-card p-5 lg:col-span-5"
              style={{ borderTop: `3px solid ${accentColor}` }}
            >
              <div className="flex items-center justify-between border-b border-border pb-2.5">
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                  {editingUeId ? "MODIFIER L'UE" : "NOUVELLE UE (+ CANAL #UE AUTO)"}
                </span>
                {editingUeId && (
                  <button
                    type="button"
                    onClick={resetUeForm}
                    className="font-mono text-[10px] uppercase tracking-wider text-stone underline"
                  >
                    ANNULER ÉDITION
                  </button>
                )}
              </div>

              {ueError && (
                <div className="border border-carmine/40 bg-carmine/10 px-3 py-2 font-mono text-xs text-carmine">
                  {ueError}
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                    CODE UE
                  </label>
                  <input
                    type="text"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="UE-101"
                    className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase text-ink focus:border-ink focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                    SEMESTRE
                  </label>
                  <input
                    type="text"
                    required
                    value={semester}
                    onChange={(e) => setSemester(e.target.value)}
                    placeholder="S1"
                    className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase text-ink focus:border-ink focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                    ORDRE
                  </label>
                  <input
                    type="number"
                    value={order}
                    onChange={(e) => setOrder(Number(e.target.value))}
                    className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs text-ink focus:border-ink focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                  INTITULÉ DE LA MATIÈRE
                </label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Anatomie Comparée"
                  className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                    CLASSE CIBLE
                  </label>
                  <select
                    value={ueClassLevel}
                    onChange={(e) =>
                      setUeClassLevel(e.target.value as ClassLevel)
                    }
                    className="w-full border border-border bg-paper px-2 py-2 font-mono text-xs uppercase text-ink focus:border-ink focus:outline-none"
                  >
                    {CLASS_LEVELS.map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {lvl}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                    ÉPREUVE
                  </label>
                  <select
                    value={examType}
                    onChange={(e) => setExamType(e.target.value)}
                    className="w-full border border-border bg-paper px-2 py-2 font-mono text-xs uppercase text-ink focus:border-ink focus:outline-none"
                  >
                    {EXAM_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                    DATE EXAMEN
                  </label>
                  <input
                    type="date"
                    value={examDate}
                    onChange={(e) => setExamDate(e.target.value)}
                    className="w-full border border-border bg-paper px-2 py-2 font-mono text-xs text-ink focus:border-ink focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                    COEFF.
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={coeff}
                    onChange={(e) => setCoeff(Number(e.target.value))}
                    className="w-full border border-border bg-paper px-2 py-2 font-mono text-xs text-ink focus:border-ink focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                  DESCRIPTION
                </label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Programme, modalités d'examen et contenu..."
                  className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-stone">
                  COULEUR BARRE SUPÉRIEURE (3PX)
                </label>
                <div className="mb-2 border border-border bg-paper">
                  <div
                    className="h-[3px] w-full transition-colors"
                    style={{
                      backgroundColor: /^#[0-9A-Fa-f]{3,6}$/.test(accentColor)
                        ? accentColor
                        : "#D99B26",
                    }}
                  />
                  <div className="flex items-center justify-between px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-stone">
                    <span>APERÇU BANDEAU UE</span>
                    <span className="font-semibold text-ink">
                      {accentColor.toUpperCase()}
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {ACCENT_COLORS.map((c) => {
                    const isSelected =
                      accentColor.toUpperCase() === c.hex.toUpperCase();
                    return (
                      <button
                        key={c.hex}
                        type="button"
                        onClick={() => setAccentColor(c.hex)}
                        className={`flex items-center gap-2 border px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider transition-colors ${
                          isSelected
                            ? "border-ink bg-pinned font-semibold text-ink"
                            : "border-border bg-paper text-stone hover:border-ink/40 hover:text-ink"
                        }`}
                      >
                        <span
                          className="inline-block h-3 w-3 shrink-0 border border-ink/20"
                          style={{ backgroundColor: c.hex }}
                        />
                        <span className="truncate">{c.label}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center gap-2 border border-border bg-paper px-2.5 py-1.5">
                  <input
                    type="color"
                    aria-label="Sélecteur de couleur personnalisée"
                    value={
                      /^#[0-9A-Fa-f]{6}$/.test(accentColor)
                        ? accentColor
                        : "#D99B26"
                    }
                    onChange={(e) => setAccentColor(e.target.value.toUpperCase())}
                    className="h-6 w-8 shrink-0 cursor-pointer border border-border bg-transparent p-0"
                  />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                    HEX LIBRE
                  </span>
                  <input
                    type="text"
                    value={accentColor}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      setAccentColor(raw.startsWith("#") ? raw.toUpperCase() : `#${raw.toUpperCase()}`);
                    }}
                    placeholder="#D99B26"
                    maxLength={7}
                    className="ml-auto w-24 border border-border bg-card px-2 py-1 font-mono text-xs uppercase text-ink focus:border-ink focus:outline-none"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={savingUe}
                className="inline-flex w-full items-center justify-center gap-2 border border-ink bg-ink px-4 py-2.5 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>
                  {savingUe
                    ? "ENREGISTREMENT..."
                    : editingUeId
                    ? "METTRE À JOUR L'UE"
                    : "CRÉER L'UE"}
                </span>
              </button>
            </form>

            {/* UE List */}
            <div className="border border-border bg-card lg:col-span-7">
              <div className="border-b border-border bg-paper px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                UNITÉS EXISTANTES ({ues.length})
              </div>

              {ues.length === 0 ? (
                <div className="p-8 text-center font-mono text-xs uppercase tracking-wider text-stone">
                  AUCUNE UE CRÉÉE POUR LE MOMENT.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {ues.map((ue) => {
                    const ex = formatExamBadge(ue.examType, ue.examDate);
                    return (
                    <div
                      key={ue.id}
                      className="flex flex-wrap items-center justify-between gap-3 p-4"
                      style={{ borderLeft: `4px solid ${ue.accentColor}` }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-bold uppercase text-ink">
                            {ue.code} · {ue.semester}
                          </span>
                          <span className="bg-badge-bg px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-badge-text">
                            {ue.classLevel || "VET2"}
                          </span>
                          <span className="border border-border bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase text-stone">
                            {ex.typeLabel} : {ex.dateLabel} · COEFF {ue.coeff ?? 4}
                          </span>
                          {ue.channels[0] && (
                            <span className="border border-border bg-paper px-1.5 py-0.5 font-mono text-[10px] text-stone">
                              {ue.channels[0].name}
                            </span>
                          )}
                        </div>
                        <p className="text-sm font-bold text-ink">{ue.title}</p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {ue.roles.map((r) => (
                            <span
                              key={r.id}
                              className="inline-flex items-center gap-1 bg-badge-bg px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-badge-text"
                            >
                              <span>RESP: {r.user.name}</span>
                              <button
                                type="button"
                                onClick={() => handleRevokeRole(ue.id, r.user.id)}
                                title="Révoquer ce responsable"
                                className="ml-1 hover:text-carmine"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => startEditUe(ue)}
                          className="border border-border bg-paper p-2 text-ink hover:border-ink"
                          title="Modifier"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteUe(ue.id)}
                          className="border border-border bg-paper p-2 text-stone hover:border-carmine hover:text-carmine"
                          title="Supprimer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Section 4: UE Manager Governance */}
        <section className="space-y-4">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
            04 / NOMINATION DES RESPONSABLES D&apos;UE (UE_MANAGER) &amp; MEMBRES
          </h2>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <form
              onSubmit={handleAssignRole}
              className="space-y-4 border border-border bg-card p-5 lg:col-span-5"
            >
              <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                NOMMER UN RESPONSABLE SUR UNE UE
              </p>

              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                  UTILISATEUR VALIDÉ
                </label>
                <select
                  value={roleUserId}
                  onChange={(e) => setRoleUserId(e.target.value)}
                  className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                >
                  {approvedUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} · {u.classLevel} ({u.email}) — {u.globalRole}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                  UNITÉ D&apos;ENSEIGNEMENT
                </label>
                <select
                  value={roleUeId}
                  onChange={(e) => setRoleUeId(e.target.value)}
                  className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase text-ink focus:border-ink focus:outline-none"
                >
                  {ues.map((ue) => (
                    <option key={ue.id} value={ue.id}>
                      {ue.code} — {ue.title}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                disabled={assigningRole || !roleUeId || !roleUserId}
                className="inline-flex w-full items-center justify-center gap-2 border border-ink bg-ink px-4 py-2.5 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
              >
                <UserCheck className="h-3.5 w-3.5" />
                <span>ATTRIBUER LE RÔLE UE_MANAGER</span>
              </button>
            </form>

            <div className="border border-border bg-card lg:col-span-7">
              <div className="border-b border-border bg-paper px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                MEMBRES DE LA PROMOTION ({allUsers.length})
              </div>
              <div className="divide-y divide-border">
                {allUsers.map((u) => {
                  const isSelf = session?.user?.id === u.id;
                  return (
                    <div
                      key={u.id}
                      className="flex flex-wrap items-center justify-between gap-3 p-3.5"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="text-sm font-bold text-ink">
                            {u.name}
                          </p>
                          <span className="border border-border bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase text-stone">
                            {u.globalRole}
                          </span>
                          <span className="bg-badge-bg px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-badge-text">
                            {u.classLevel}
                          </span>
                          <span
                            className={`border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                              u.isApproved
                                ? "border-forest/40 bg-forest/10 text-forest"
                                : "border-amber/60 bg-amber/15 text-ink"
                            }`}
                          >
                            {u.isApproved ? "VALIDÉ" : "EN ATTENTE"}
                          </span>
                        </div>
                        <p className="font-mono text-[11px] text-stone">
                          {u.email}
                        </p>
                        {u.ueRoles.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {u.ueRoles.map((r) => (
                              <button
                                key={r.id}
                                type="button"
                                onClick={() => handleRevokeRole(r.ueId, u.id)}
                                className="inline-flex items-center gap-1 border border-badge-text/30 bg-badge-bg px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-badge-text hover:border-carmine hover:bg-carmine/10 hover:text-carmine"
                                title="Cliquer pour révoquer"
                              >
                                <span>{r.ue.code}</span>
                                <UserX className="h-3 w-3" />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <select
                          value={u.classLevel}
                          onChange={(e) =>
                            handleUpdateUser(u.id, {
                              classLevel: e.target.value as ClassLevel,
                            })
                          }
                          aria-label={`Classe de ${u.name}`}
                          className="border border-border bg-paper px-2 py-1 font-mono text-[10px] uppercase text-ink focus:border-ink focus:outline-none"
                        >
                          {CLASS_LEVELS.map((lvl) => (
                            <option key={lvl} value={lvl}>
                              {lvl}
                            </option>
                          ))}
                        </select>

                        {!isSelf && u.globalRole !== "YEAR_ADMIN" && (
                          <button
                            type="button"
                            onClick={() =>
                              handleUpdateUser(u.id, {
                                isApproved: !u.isApproved,
                              })
                            }
                            className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${
                              u.isApproved
                                ? "border-border bg-paper text-stone hover:border-amber hover:text-ink"
                                : "border-ink bg-forest text-card"
                            }`}
                          >
                            {u.isApproved ? "SUSPENDRE" : "VALIDER"}
                          </button>
                        )}

                        {!isSelf && (
                          <button
                            type="button"
                            onClick={() => handleDeleteUser(u.id, u.name)}
                            className="border border-border bg-paper p-1.5 text-stone hover:border-carmine hover:text-carmine"
                            title="Supprimer ce compte"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
