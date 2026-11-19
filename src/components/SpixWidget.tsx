"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  BookOpen,
  FileCode2,
  FileText,
  Layers,
  ListChecks,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useSpix } from "@/components/SpixContext";
import { StudioArtifactViewer } from "@/components/StudioArtifactViewer";
import { renderPdfPageToDataUrl } from "@/lib/pdf-client";
import type {
  PageImageInput,
  StudioArtifactContent,
  StudioArtifactKind,
} from "@/lib/studio";

export interface SpixSource {
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
  sources?: SpixSource[];
  scopeLabel?: string;
  imagePreviewUrl?: string;
  artifact?: {
    title: string;
    content: StudioArtifactContent;
  };
}

export function SpixWidget() {
  const router = useRouter();
  const {
    pageContext,
    isOpen,
    setIsOpen,
    navigateToDocPage,
    pendingImagePrompt,
    clearPendingImagePrompt,
  } = useSpix();

  const [scopeOverride, setScopeOverride] = useState<
    "AUTO" | "DOCUMENT" | "UE" | "GLOBAL"
  >("AUTO");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [ollamaOnline, setOllamaOnline] = useState<boolean | null>(null);
  const [ollamaHost, setOllamaHost] = useState("127.0.0.1:11434");
  const [ollamaModel, setOllamaModel] = useState("gemma3:12b");
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Reset scopeOverride back to AUTO whenever the active page/document changes
  useEffect(() => {
    setScopeOverride("AUTO");
  }, [pageContext.mode, pageContext.ueId, pageContext.documentId]);

  useEffect(() => {
    if (!isOpen) return;
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
        if (active) setOllamaOnline(false);
      }
    }
    fetchStatus();
    return () => {
      active = false;
    };
  }, [isOpen]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  // Compute effective scope label for display
  let effectiveScope: "DOCUMENT" | "UE" | "GLOBAL" = "GLOBAL";
  if (scopeOverride === "DOCUMENT" && pageContext.documentId) {
    effectiveScope = "DOCUMENT";
  } else if (scopeOverride === "UE" && pageContext.ueId) {
    effectiveScope = "UE";
  } else if (scopeOverride === "GLOBAL") {
    effectiveScope = "GLOBAL";
  } else if (pageContext.mode === "DOCUMENT" && pageContext.documentId) {
    effectiveScope = "DOCUMENT";
  } else if (pageContext.ueId) {
    effectiveScope = "UE";
  }

  const accentColor =
    pageContext.mode === "DOCUMENT"
      ? "#3B7A57"
      : pageContext.ueAccentColor || "#D99B26";

  const quickSuggestions =
    effectiveScope === "DOCUMENT"
      ? [
          `Résume la page ${pageContext.currentPage || 1} de ce cours`,
          "Explique les concepts clés de ce document",
        ]
      : effectiveScope === "UE"
      ? [
          `Fais une synthèse de l'UE ${pageContext.ueCode || ""}`,
          "Quelles notions reviennent dans les fiches ?",
        ]
      : ["Chercher une notion dans tous mes cours"];

  function handleSourceClick(source: SpixSource) {
    const handledInPlace = navigateToDocPage(
      source.documentId,
      source.pageNumber,
      source.ueId
    );
    if (!handledInPlace) {
      setIsOpen(false);
      router.push(
        `/ue/${source.ueId}?doc=${encodeURIComponent(
          source.documentId
        )}&page=${source.pageNumber}`
      );
    }
  }

  async function triggerStudio(
    kind: StudioArtifactKind,
    customPrompt?: string
  ) {
    if (isStreaming) return;
    setErrorBanner(null);

    const scopeLabel =
      effectiveScope === "DOCUMENT"
        ? `COURS · ${pageContext.fileName || pageContext.documentTitle} (P.${pageContext.currentPage || 1})`
        : effectiveScope === "UE"
        ? `UE · ${pageContext.ueCode || "MATIÈRE"}`
        : "PROMO GLOBALE";

    const kindActionName =
      kind === "SVG_DIAGRAM"
        ? "Générer un schéma vectoriel .svg"
        : kind === "FLASHCARDS"
        ? "Générer un paquet de flashcards"
        : kind === "QUIZ"
        ? "Générer un quiz ciblé"
        : "Générer une fiche synthèse";

    const userText = customPrompt?.trim() || kindActionName;
    const assistantId = `a-${Date.now()}`;

    setMessages((prev) => [
      ...prev,
      {
        id: `u-${Date.now()}`,
        role: "user",
        content: userText,
        scopeLabel,
      },
      {
        id: assistantId,
        role: "assistant",
        content: "Génération Studio Notebook en cours...",
      },
    ]);
    setQuestion("");
    setIsStreaming(true);

    try {
      const pageImagesBase64: PageImageInput[] = [];
      if (effectiveScope === "DOCUMENT" && pageContext.documentId) {
        const pageNum = pageContext.currentPage || 1;
        const dataUrl = await renderPdfPageToDataUrl(
          pageContext.documentId,
          pageNum,
          900
        );
        if (dataUrl) {
          pageImagesBase64.push({
            pageNumber: pageNum,
            documentTitle: pageContext.documentTitle,
            base64: dataUrl,
          });
        }
      }

      const res = await fetch("/api/studio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          ueId: effectiveScope !== "GLOBAL" ? pageContext.ueId : undefined,
          documentIds:
            effectiveScope === "DOCUMENT" && pageContext.documentId
              ? [pageContext.documentId]
              : undefined,
          pageNumber:
            effectiveScope === "DOCUMENT" ? pageContext.currentPage : undefined,
          prompt: customPrompt?.trim() || undefined,
          pageImagesBase64,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        artifact?: { title: string; contentJson: string };
        error?: string;
      };

      if (!res.ok || !data.artifact) {
        const msg =
          data.error || "Impossible de générer cette ressource Studio.";
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: msg } : m))
        );
        return;
      }

      const parsed = JSON.parse(
        data.artifact.contentJson
      ) as StudioArtifactContent;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: `${data.artifact!.title} — généré et sauvegardé dans le Studio Notebook.`,
                artifact: {
                  title: data.artifact!.title,
                  content: parsed,
                },
              }
            : m
        )
      );
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: "Erreur réseau lors de la génération Studio." }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
    }
  }

  async function sendQuestion(
    promptText: string,
    overrideCapture?: { imageDataUrl: string; pageNumber?: number }
  ) {
    const trimmed = promptText.trim();
    if (!trimmed || isStreaming) return;

    const lower = trimmed.toLowerCase();
    if (
      !overrideCapture &&
      /\b(svg|sch[eé]ma|diagramme)\b/i.test(lower) &&
      (lower.includes("fais") ||
        lower.includes("génère") ||
        lower.includes("genere") ||
        lower.includes("crée") ||
        lower.includes("cree") ||
        lower.includes("svg"))
    ) {
      await triggerStudio("SVG_DIAGRAM", trimmed);
      return;
    }
    if (!overrideCapture && /\b(flashcards?|cartes?\s+m[eé]moire)\b/i.test(lower)) {
      await triggerStudio("FLASHCARDS", trimmed);
      return;
    }
    if (!overrideCapture && /\b(quiz|qcm|qcu)\b/i.test(lower)) {
      await triggerStudio("QUIZ", trimmed);
      return;
    }

    setErrorBanner(null);

    const scopeLabel =
      effectiveScope === "DOCUMENT"
        ? `COURS · ${pageContext.fileName || pageContext.documentTitle} (P.${pageContext.currentPage || 1})`
        : effectiveScope === "UE"
        ? `UE · ${pageContext.ueCode || "MATIÈRE"}`
        : "PROMO GLOBALE";

    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
      scopeLabel,
      imagePreviewUrl: overrideCapture?.imageDataUrl,
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
      const pageImagesBase64: Array<{ pageNumber: number; base64: string }> = [];
      if (overrideCapture?.imageDataUrl) {
        pageImagesBase64.push({
          pageNumber: overrideCapture.pageNumber || pageContext.currentPage || 1,
          base64: overrideCapture.imageDataUrl,
        });
      } else if (effectiveScope === "DOCUMENT" && pageContext.documentId) {
        const pageNum = pageContext.currentPage || 1;
        const dataUrl = await renderPdfPageToDataUrl(
          pageContext.documentId,
          pageNum,
          850
        );
        if (dataUrl) {
          pageImagesBase64.push({ pageNumber: pageNum, base64: dataUrl });
        }
      }

      const res = await fetch("/api/spix/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: trimmed,
          scope: scopeOverride,
          context: pageContext,
          history: historyPayload,
          pageImagesBase64,
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
          errData.message || `Serveur Ollama hors-ligne (${ollamaHost})`;
        setErrorBanner(msg);
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: msg } : m))
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
              sources?: SpixSource[];
              content?: string;
              message?: string;
            };

            if (event.type === "sources" && event.sources) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, sources: event.sources } : m
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
            // Ignore partial chunk
          }
        }
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Erreur de communication avec Spix.";
      setErrorBanner(msg);
    } finally {
      setIsStreaming(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await sendQuestion(question);
  }

  useEffect(() => {
    if (!pendingImagePrompt || isStreaming) return;
    const req = pendingImagePrompt;
    clearPendingImagePrompt();
    void sendQuestion(req.prompt, {
      imageDataUrl: req.imageDataUrl,
      pageNumber: req.pageNumber,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingImagePrompt]);

  return (
    <>
      {/* Floating Popover Window above the Bottom Square */}
      {isOpen && (
        <div
          className="fixed bottom-24 right-4 z-50 flex h-[540px] max-h-[calc(100vh-120px)] w-[calc(100vw-2rem)] flex-col border border-ink bg-card sm:right-6 sm:w-[440px]"
          style={{ borderTop: `3px solid ${accentColor}` }}
        >
          {/* Top Bar */}
          <div className="flex items-center justify-between border-b border-border bg-ink px-4 py-2.5 text-card">
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5" />
              <span className="font-mono text-xs font-bold uppercase tracking-wider">
                SPIX · IA CONTEXTUELLE
              </span>
              <span
                className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
                  ollamaOnline === true
                    ? "border-forest bg-forest/20 text-card"
                    : ollamaOnline === false
                    ? "border-carmine bg-carmine/20 text-card"
                    : "border-card/30 text-card/80"
                }`}
              >
                {ollamaOnline === true
                  ? ollamaModel
                  : ollamaOnline === false
                  ? "HORS-LIGNE"
                  : "..."}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={() => setMessages([])}
                  title="Effacer la conversation"
                  className="p-1 text-card/75 hover:text-card"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                title="Réduire Spix"
                className="p-1 text-card/75 hover:text-card"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Detected Page Context Strip */}
          <div className="border-b border-border bg-pinned px-4 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-stone">
                CONTEXTE DÉTECTÉ :
              </span>
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-ink">
                {effectiveScope === "DOCUMENT"
                  ? `COURS · P.${pageContext.currentPage || 1}/${pageContext.pageCount || "?"}`
                  : effectiveScope === "UE"
                  ? `UE · ${pageContext.ueCode || "MATIÈRE"}`
                  : "PROMOTION GLOBALE"}
              </span>
            </div>

            <p className="mt-1 truncate text-xs font-semibold text-ink">
              {effectiveScope === "DOCUMENT"
                ? pageContext.documentTitle || pageContext.fileName
                : effectiveScope === "UE"
                ? `${pageContext.ueCode || ""} — ${pageContext.ueTitle || ""}`
                : "Toutes les UE et tous les documents indexés"}
            </p>

            {/* Quick Scope Switcher when deeper context exists */}
            {(pageContext.documentId || pageContext.ueId) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {pageContext.documentId && (
                  <button
                    type="button"
                    onClick={() => setScopeOverride("DOCUMENT")}
                    className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                      effectiveScope === "DOCUMENT"
                        ? "border-ink bg-ink text-card"
                        : "border-border bg-card text-stone hover:text-ink"
                    }`}
                  >
                    CE COURS PDF
                  </button>
                )}
                {pageContext.ueId && (
                  <button
                    type="button"
                    onClick={() => setScopeOverride("UE")}
                    className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                      effectiveScope === "UE"
                        ? "border-ink bg-ink text-card"
                        : "border-border bg-card text-stone hover:text-ink"
                    }`}
                  >
                    TOUTE L&apos;UE {pageContext.ueCode || ""}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setScopeOverride("GLOBAL")}
                  className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                    effectiveScope === "GLOBAL"
                      ? "border-ink bg-ink text-card"
                      : "border-border bg-card text-stone hover:text-ink"
                  }`}
                >
                  TOUTE LA PROMO
                </button>
              </div>
            )}
          </div>

          {/* Offline Banner */}
          {ollamaOnline === false && (
            <div className="flex items-center gap-2 border-b border-border bg-paper px-4 py-2 text-xs text-ink">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber" />
              <span className="font-mono text-[10px] uppercase tracking-wider">
                Serveur Ollama hors-ligne ({ollamaHost})
              </span>
            </div>
          )}

          {errorBanner && ollamaOnline !== false && (
            <div className="border-b border-carmine/30 bg-carmine/10 px-4 py-2 font-mono text-[10px] text-carmine">
              {errorBanner}
            </div>
          )}

          {/* Messages */}
          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto p-4 text-sm"
          >
            {messages.length === 0 ? (
              <div className="space-y-3">
                <div className="border border-border bg-paper p-3.5">
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-stone">
                    SPIX EST SYNCHRONISÉ SUR VOTRE ÉCRAN
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink">
                    {effectiveScope === "DOCUMENT"
                      ? `Posez une question sur « ${
                          pageContext.documentTitle || pageContext.fileName
                        } » ou directement sur la page ${
                          pageContext.currentPage || 1
                        } affichée dans votre lecteur.`
                      : effectiveScope === "UE"
                      ? `Posez une question globale sur l'UE ${
                          pageContext.ueCode || ""
                        }. Spix interroge tous les polycopiés et fiches validées de cette matière.`
                      : "Naviguez vers une UE ou ouvrez un PDF pour cibler Spix automatiquement, ou posez une question transversale."}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                    SUGGESTIONS CONTEXTUELLES :
                  </p>
                  {quickSuggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => sendQuestion(s)}
                      disabled={isStreaming}
                      className="block w-full border border-border bg-paper px-3 py-2 text-left font-mono text-[11px] text-ink transition-colors hover:border-ink hover:bg-pinned disabled:opacity-50"
                    >
                      → {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((turn) => (
                <div
                  key={turn.id}
                  className={`border p-3 ${
                    turn.role === "user"
                      ? "border-border bg-pinned"
                      : "border-border bg-paper"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-stone">
                      {turn.role === "user" ? "VOUS" : "SPIX"}
                    </span>
                    {turn.scopeLabel && (
                      <span className="font-mono text-[9px] uppercase tracking-wider text-stone">
                        {turn.scopeLabel}
                      </span>
                    )}
                  </div>

                  <div className="whitespace-pre-wrap text-xs leading-relaxed text-ink">
                    {turn.content ||
                      (isStreaming ? "Analyse en cours..." : "")}
                  </div>

                  {turn.imagePreviewUrl && (
                    <div className="mt-2 border border-border bg-card p-1.5">
                      <img
                        src={turn.imagePreviewUrl}
                        alt="Capture de page PDF"
                        className="max-h-36 w-auto border border-border object-contain"
                      />
                    </div>
                  )}

                  {turn.artifact && (
                    <div className="mt-2.5">
                      <StudioArtifactViewer
                        title={turn.artifact.title}
                        content={turn.artifact.content}
                        compact
                        onOpenSource={(src) =>
                          handleSourceClick({
                            ...src,
                          })
                        }
                      />
                    </div>
                  )}

                  {turn.role === "assistant" &&
                    turn.sources &&
                    turn.sources.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-border pt-2">
                        {turn.sources.map((src) => (
                          <button
                            key={`${src.documentId}-${src.pageNumber}`}
                            type="button"
                            onClick={() => handleSourceClick(src)}
                            className="inline-flex items-center gap-1 border border-badge-text/30 bg-badge-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-badge-text hover:bg-badge-text hover:text-card"
                          >
                            <FileText className="h-3 w-3" />
                            <span>{src.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                </div>
              ))
            )}
          </div>

          {/* Studio Quick Generation Strip + Input */}
          <form
            onSubmit={handleSubmit}
            className="border-t border-border bg-paper p-3"
          >
            <div className="mb-2 flex flex-wrap gap-1">
              <button
                type="button"
                disabled={isStreaming}
                onClick={() => triggerStudio("SVG_DIAGRAM", question)}
                className="inline-flex items-center gap-1 border border-border bg-card px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-50"
              >
                <FileCode2 className="h-3 w-3" />
                <span>+ SCHÉMA .SVG</span>
              </button>
              <button
                type="button"
                disabled={isStreaming}
                onClick={() => triggerStudio("FLASHCARDS", question)}
                className="inline-flex items-center gap-1 border border-border bg-card px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-50"
              >
                <Layers className="h-3 w-3" />
                <span>+ FLASHCARDS</span>
              </button>
              <button
                type="button"
                disabled={isStreaming}
                onClick={() => triggerStudio("QUIZ", question)}
                className="inline-flex items-center gap-1 border border-border bg-card px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-50"
              >
                <ListChecks className="h-3 w-3" />
                <span>+ QUIZ</span>
              </button>
              <button
                type="button"
                disabled={isStreaming}
                onClick={() => triggerStudio("SUMMARY", question)}
                className="inline-flex items-center gap-1 border border-border bg-card px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-50"
              >
                <BookOpen className="h-3 w-3" />
                <span>+ SYNTHÈSE</span>
              </button>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={
                  effectiveScope === "DOCUMENT"
                    ? `Question sur ce cours (p.${pageContext.currentPage || 1})...`
                    : effectiveScope === "UE"
                    ? `Question sur ${pageContext.ueCode || "cette UE"}...`
                    : "Poser une question à Spix..."
                }
                disabled={isStreaming}
                className="flex-1 border border-border bg-card px-3 py-2 text-xs text-ink placeholder:text-stone focus:border-ink focus:outline-none disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={isStreaming || !question.trim()}
                className="inline-flex items-center justify-center border border-ink bg-ink px-3 py-2 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
              >
                {isStreaming ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Strictly Square Floating Launcher at Bottom Right */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label="Ouvrir l'assistant Spix"
        title={
          pageContext.mode === "DOCUMENT"
            ? `Spix (Cours : ${pageContext.documentTitle || "PDF"} · p.${pageContext.currentPage || 1})`
            : pageContext.mode === "UE"
            ? `Spix (UE : ${pageContext.ueCode || ""})`
            : "Spix (Assistant IA)"
        }
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center border border-ink bg-ink text-card transition-colors hover:bg-ink/90 sm:bottom-6 sm:right-6"
        style={{ borderTop: `3px solid ${accentColor}` }}
      >
        <span className="font-mono text-xs font-bold uppercase tracking-wider">
          SPIX
        </span>
      </button>
    </>
  );
}
