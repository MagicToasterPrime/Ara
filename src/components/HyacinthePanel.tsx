"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Send, Sparkles, FileText, Loader2 } from "lucide-react";

export interface HyacintheSource {
  documentId: string;
  documentTitle: string;
  fileName: string;
  pageNumber: number;
  ueId: string;
  ueCode: string;
  label: string;
}

interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: HyacintheSource[];
}

interface HyacinthePanelProps {
  fixedUeId?: string;
  fixedUeLabel?: string;
  ues?: Array<{ id: string; code: string; title: string }>;
  onOpenSource?: (source: HyacintheSource) => void;
  compact?: boolean;
}

export function HyacinthePanel({
  fixedUeId,
  fixedUeLabel,
  ues = [],
  onOpenSource,
  compact = false,
}: HyacinthePanelProps) {
  const router = useRouter();
  const [selectedUeId, setSelectedUeId] = useState<string>(fixedUeId || "");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [ollamaOnline, setOllamaOnline] = useState<boolean | null>(null);
  const [ollamaHost, setOllamaHost] = useState("127.0.0.1:11434");
  const [ollamaModel, setOllamaModel] = useState("qwen2.5:7b");
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (fixedUeId) {
      setSelectedUeId(fixedUeId);
    }
  }, [fixedUeId]);

  useEffect(() => {
    let active = true;
    async function fetchStatus() {
      try {
        const res = await fetch("/api/system/health", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          ollama?: {
            online: boolean;
            host: string;
            configuredModel: string;
          };
        };
        if (active && data.ollama) {
          setOllamaOnline(data.ollama.online);
          setOllamaHost(data.ollama.host.replace(/^https?:\/\//, ""));
          setOllamaModel(data.ollama.configuredModel);
        }
      } catch {
        if (active) {
          setOllamaOnline(false);
        }
      }
    }
    fetchStatus();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  function handleSourceClick(source: HyacintheSource) {
    if (onOpenSource) {
      onOpenSource(source);
      return;
    }
    router.push(
      `/ue/${source.ueId}?doc=${encodeURIComponent(source.documentId)}&page=${source.pageNumber}`
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || isStreaming) return;

    setErrorBanner(null);
    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
    };

    const assistantId = `a-${Date.now()}`;
    const assistantTurn: ChatTurn = {
      id: assistantId,
      role: "assistant",
      content: "",
      sources: [],
    };

    const historyPayload = messages.slice(-6).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setMessages((prev) => [...prev, userTurn, assistantTurn]);
    setQuestion("");
    setIsStreaming(true);

    try {
      const res = await fetch("/api/hyacinthe/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: trimmed,
          ueId: fixedUeId || selectedUeId || undefined,
          history: historyPayload,
        }),
      });

      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        if (errData.error === "OLLAMA_OFFLINE") {
          setOllamaOnline(false);
        }
        const msg =
          errData.message ||
          `Serveur Ollama hors-ligne (${ollamaHost})`;
        setErrorBanner(msg);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: msg } : m
          )
        );
        return;
      }

      if (!res.body) {
        throw new Error("Réponse streaming indisponible.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const clean = line.trim();
          if (!clean) continue;
          try {
            const event = JSON.parse(clean) as {
              type: "sources" | "token" | "done" | "error";
              sources?: HyacintheSource[];
              content?: string;
              message?: string;
            };

            if (event.type === "sources" && event.sources) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, sources: event.sources }
                    : m
                )
              );
            } else if (event.type === "token" && event.content) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content + event.content }
                    : m
                )
              );
            } else if (event.type === "error" && event.message) {
              setErrorBanner(event.message);
            }
          } catch {
            // Skip malformed NDJSON chunk
          }
        }
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Erreur de communication avec Hyacinthe.";
      setErrorBanner(msg);
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-card text-ink">
      {/* Header */}
      <div className="border-b border-border bg-paper px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-ink" />
            <span className="font-mono text-xs font-semibold uppercase tracking-wider">
              HYACINTHE IA · RAG LOCAL
            </span>
          </div>
          <span
            className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
              ollamaOnline === true
                ? "border-forest/40 bg-forest/10 text-forest"
                : ollamaOnline === false
                ? "border-carmine/40 bg-carmine/10 text-carmine"
                : "border-border bg-card text-stone"
            }`}
          >
            {ollamaOnline === true
              ? `EN LIGNE · ${ollamaModel}`
              : ollamaOnline === false
              ? "HORS-LIGNE"
              : "VÉRIFICATION..."}
          </span>
        </div>

        {/* Scope Selector */}
        <div className="mt-2.5">
          {fixedUeId ? (
            <div className="border border-border bg-card px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-stone">
              PÉRIMÈTRE :{" "}
              <span className="font-semibold text-ink">
                {fixedUeLabel || "UE ACTIVE"}
              </span>
            </div>
          ) : (
            <select
              value={selectedUeId}
              onChange={(e) => setSelectedUeId(e.target.value)}
              className="w-full border border-border bg-card px-2.5 py-1.5 font-mono text-xs uppercase tracking-wider text-ink focus:border-ink focus:outline-none"
            >
              <option value="">TOUTES LES UE (INDEX COMPLET)</option>
              {ues.map((ue) => (
                <option key={ue.id} value={ue.id}>
                  {ue.code} — {ue.title}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Offline Banner */}
      {ollamaOnline === false && (
        <div className="flex items-center gap-2.5 border-b border-border bg-pinned px-4 py-2.5 text-xs text-ink">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber" />
          <span className="font-mono text-[11px] uppercase tracking-wider">
            Serveur Ollama hors-ligne ({ollamaHost})
          </span>
        </div>
      )}

      {errorBanner && ollamaOnline !== false && (
        <div className="border-b border-carmine/30 bg-carmine/10 px-4 py-2 font-mono text-[11px] text-carmine">
          {errorBanner}
        </div>
      )}

      {/* Messages Feed */}
      <div
        ref={scrollRef}
        className={`flex-1 space-y-4 overflow-y-auto p-4 ${
          compact ? "text-sm" : "text-sm"
        }`}
      >
        {messages.length === 0 ? (
          <div className="border border-border bg-paper p-5">
            <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
              ASSISTANT DOCUMENTAIRE LOCAL (PGVECTOR + OLLAMA)
            </p>
            <p className="mt-2 text-sm leading-relaxed text-ink">
              Posez une question sur vos cours officiels ou notes étudiantes
              indexés. Hyacinthe recherche les passages pertinents dans
              PostgreSQL et cite chaque document avec sa page exacte.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="border border-border bg-card px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-stone">
                CHUNKS 800 CAR.
              </span>
              <span className="border border-border bg-card px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-stone">
                COSINUS PGVECTOR
              </span>
              <span className="border border-border bg-card px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-stone">
                CITATIONS CLIQUABLES
              </span>
            </div>
          </div>
        ) : (
          messages.map((turn) => (
            <div
              key={turn.id}
              className={`border p-3.5 ${
                turn.role === "user"
                  ? "border-border bg-pinned"
                  : "border-border bg-paper"
              }`}
            >
              <div className="mb-1.5 flex items-center justify-between">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-stone">
                  {turn.role === "user" ? "VOUS" : "HYACINTHE IA"}
                </span>
              </div>

              <div className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
                {turn.content || (isStreaming ? "Recherche vectorielle en cours..." : "")}
              </div>

              {turn.role === "assistant" &&
                turn.sources &&
                turn.sources.length > 0 && (
                  <div className="mt-3 border-t border-border pt-2.5">
                    <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-stone">
                      SOURCES DOCUMENTAIRES CLIQUABLES :
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {turn.sources.map((src) => (
                        <button
                          key={`${src.documentId}-${src.pageNumber}`}
                          type="button"
                          onClick={() => handleSourceClick(src)}
                          className="inline-flex items-center gap-1.5 border border-badge-text/30 bg-badge-bg px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-badge-text transition-colors hover:bg-badge-text hover:text-card"
                          title={`Ouvrir ${src.documentTitle} à la page ${src.pageNumber}`}
                        >
                          <FileText className="h-3 w-3" />
                          <span>{src.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
            </div>
          ))
        )}
      </div>

      {/* Input Bar */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-border bg-paper p-3"
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Interroger les PDF indexés..."
            disabled={isStreaming}
            className="flex-1 border border-border bg-card px-3 py-2 text-sm text-ink placeholder:text-stone focus:border-ink focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={isStreaming || !question.trim()}
            className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3.5 py-2 font-mono text-xs uppercase tracking-wider text-card transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStreaming ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            <span>ENVOYER</span>
          </button>
        </div>
      </form>
    </div>
  );
}
