"use client";

import { useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Loader2,
  Trash2,
  Upload,
  X,
} from "lucide-react";

const MAX_BULK_BYTES = 300 * 1024 * 1024; // 300 Mo

export interface BulkUploadChapterGroup {
  key: string;
  label: string;
  chapters: Array<{
    id: string;
    title: string;
    depth: number;
  }>;
}

type FileItemStatus = "pending" | "uploading" | "queued" | "error";

interface QueuedFileItem {
  id: string;
  file: File;
  status: FileItemStatus;
  errorMessage?: string;
  pageCount?: number;
  chunkCount?: number;
  documentId?: string;
}

interface ApiPerFileResult {
  index: number;
  fileName: string;
  ok: boolean;
  status: "queued" | "error";
  error?: string;
  document?: {
    id: string;
    title: string;
    pageCount?: number;
  };
  indexing?: {
    indexed: boolean;
    chunkCount: number;
    scheduledNightly: boolean;
  };
  scheduledNightly?: boolean;
}

interface BulkPdfUploaderProps {
  chapterGroups: BulkUploadChapterGroup[];
  defaultChapterId: string;
  canManage: boolean;
  defaultCategory: "OFFICIAL_COURSE" | "STUDENT_NOTE";
  onClose: () => void;
  onUploaded: (info: {
    uploadedCount: number;
    firstDoc?: { id: string; title: string; scheduledNightly: boolean };
  }) => Promise<void> | void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}

export function BulkPdfUploader({
  chapterGroups,
  defaultChapterId,
  canManage,
  defaultCategory,
  onClose,
  onUploaded,
}: BulkPdfUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [chapterId, setChapterId] = useState(defaultChapterId);
  const [category, setCategory] = useState<"OFFICIAL_COURSE" | "STUDENT_NOTE">(
    defaultCategory
  );
  const [singleTitle, setSingleTitle] = useState("");
  const [items, setItems] = useState<QueuedFileItem[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [batchSummary, setBatchSummary] = useState<{
    total: number;
    succeeded: number;
    failed: number;
    continuousGeneration24h?: boolean;
  } | null>(null);

  const hasChapters = chapterGroups.some((g) => g.chapters.length > 0);
  const pendingItems = items.filter((i) => i.status === "pending");
  const totalPendingBytes = pendingItems.reduce(
    (sum, item) => sum + item.file.size,
    0
  );
  const exceedsSizeLimit = totalPendingBytes > MAX_BULK_BYTES;

  function addFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    setGlobalError(null);
    setBatchSummary(null);

    const rejectedNames: string[] = [];

    setItems((prev) => {
      const existingKeys = new Set(
        prev.map((p) => `${p.file.name}::${p.file.size}::${p.file.lastModified}`)
      );
      const next = [...prev];

      for (const file of incoming) {
        const key = `${file.name}::${file.size}::${file.lastModified}`;
        if (existingKeys.has(key)) continue;

        const isPdf =
          file.type === "application/pdf" ||
          file.name.toLowerCase().endsWith(".pdf");

        if (!isPdf) {
          rejectedNames.push(file.name);
          next.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            file,
            status: "error",
            errorMessage: "Format non pris en charge : seuls les fichiers .pdf sont acceptés.",
          });
          existingKeys.add(key);
          continue;
        }

        if (file.size === 0) {
          next.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            file,
            status: "error",
            errorMessage: "Le fichier PDF est vide (0 octet).",
          });
          existingKeys.add(key);
          continue;
        }

        existingKeys.add(key);
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          status: "pending",
        });
      }

      return next;
    });

    if (rejectedNames.length > 0) {
      setGlobalError(
        `Fichier(s) non PDF ignoré(s) : ${rejectedNames.slice(0, 3).join(", ")}${
          rejectedNames.length > 3 ? ` (+${rejectedNames.length - 3})` : ""
        }.`
      );
    }
  }

  function removeItem(id: string) {
    if (uploading) return;
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function clearFinished() {
    if (uploading) return;
    setItems((prev) => prev.filter((item) => item.status === "pending"));
    setBatchSummary(null);
    setGlobalError(null);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragOver) setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (uploading) return;
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (uploading || !chapterId || pendingItems.length === 0 || exceedsSizeLimit) {
      return;
    }

    const toSend = pendingItems;
    const toSendIds = toSend.map((item) => item.id);
    const idSet = new Set(toSendIds);

    setUploading(true);
    setGlobalError(null);
    setBatchSummary(null);
    setItems((prev) =>
      prev.map((item) =>
        idSet.has(item.id)
          ? { ...item, status: "uploading", errorMessage: undefined }
          : item
      )
    );

    try {
      const formData = new FormData();
      formData.append("chapterId", chapterId);
      formData.append("category", category);
      if (toSend.length === 1 && singleTitle.trim()) {
        formData.append("title", singleTitle.trim());
      }
      for (const item of toSend) {
        formData.append("files", item.file);
      }

      const res = await fetch("/api/documents", {
        method: "POST",
        body: formData,
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        document?: { id: string; title: string };
        scheduledNightly?: boolean;
        continuousGeneration24h?: boolean;
        results?: ApiPerFileResult[];
        summary?: { total: number; succeeded: number; failed: number };
      };

      if (Array.isArray(data.results) && data.results.length > 0) {
        const resultByIndex = new Map<number, ApiPerFileResult>();
        for (const r of data.results) {
          resultByIndex.set(r.index, r);
        }

        setItems((prev) =>
          prev.map((item) => {
            const sentIdx = toSendIds.indexOf(item.id);
            if (sentIdx === -1) return item;
            const r = resultByIndex.get(sentIdx);
            if (!r) {
              return {
                ...item,
                status: "error",
                errorMessage: "Réponse serveur manquante pour ce fichier.",
              };
            }
            if (r.ok) {
              return {
                ...item,
                status: "queued",
                errorMessage: undefined,
                pageCount: r.document?.pageCount,
                chunkCount: r.indexing?.chunkCount,
                documentId: r.document?.id,
              };
            }
            return {
              ...item,
              status: "error",
              errorMessage: r.error || "Erreur lors de l'enregistrement du PDF.",
            };
          })
        );

        const summary = data.summary || {
          total: data.results.length,
          succeeded: data.results.filter((r) => r.ok).length,
          failed: data.results.filter((r) => !r.ok).length,
        };
        setBatchSummary({
          ...summary,
          continuousGeneration24h: Boolean(data.continuousGeneration24h),
        });

        if (summary.succeeded > 0) {
          setSingleTitle("");
          const firstOk = data.results.find((r) => r.ok && r.document);
          await onUploaded({
            uploadedCount: summary.succeeded,
            firstDoc: firstOk?.document
              ? {
                  id: firstOk.document.id,
                  title: firstOk.document.title,
                  scheduledNightly: Boolean(firstOk.scheduledNightly),
                }
              : data.document
              ? {
                  id: data.document.id,
                  title: data.document.title,
                  scheduledNightly: Boolean(data.scheduledNightly),
                }
              : undefined,
          });
        } else if (data.error) {
          setGlobalError(data.error);
        }
      } else if (!res.ok) {
        const msg = data.error || `Échec de l'envoi (HTTP ${res.status}).`;
        setGlobalError(msg);
        setItems((prev) =>
          prev.map((item) =>
            idSet.has(item.id)
              ? { ...item, status: "error", errorMessage: msg }
              : item
          )
        );
      } else {
        // Legacy single-document response fallback
        setItems((prev) =>
          prev.map((item) =>
            idSet.has(item.id)
              ? { ...item, status: "queued", documentId: data.document?.id }
              : item
          )
        );
        setBatchSummary({
          total: toSend.length,
          succeeded: toSend.length,
          failed: 0,
        });
        setSingleTitle("");
        await onUploaded({
          uploadedCount: toSend.length,
          firstDoc: data.document
            ? {
                id: data.document.id,
                title: data.document.title,
                scheduledNightly: Boolean(data.scheduledNightly),
              }
            : undefined,
        });
      }
    } catch {
      const msg = "Erreur réseau lors de l'envoi des fichiers PDF.";
      setGlobalError(msg);
      setItems((prev) =>
        prev.map((item) =>
          idSet.has(item.id)
            ? { ...item, status: "error", errorMessage: msg }
            : item
        )
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="ara-animate-in border border-ink bg-card p-5"
    >
      <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
        <div>
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
            TÉLÉVERSEMENT MULTIPLE DE PDF (FILE DU BATCH NOCTURNE)
          </span>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-stone">
            DÉPOSEZ UN OU PLUSIEURS POLYCOPIÉS · EXTRACTION DU TEXTE IMMÉDIATE ·
            INDEXATION &amp; IA LA NUIT (00H–07H)
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={uploading}
          className="text-stone hover:text-ink disabled:opacity-40"
          title="Fermer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {globalError && (
        <div className="mb-4 flex items-start gap-2 border border-carmine/40 bg-carmine/10 px-3 py-2 font-mono text-xs text-carmine">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{globalError}</span>
        </div>
      )}

      {batchSummary && (
        <div
          className={`mb-4 flex flex-wrap items-center justify-between gap-2 border px-3 py-2 font-mono text-xs ${
            batchSummary.failed === 0
              ? "border-forest/50 bg-forest/10 text-forest"
              : batchSummary.succeeded > 0
              ? "border-amber bg-pinned text-ink"
              : "border-carmine/50 bg-carmine/10 text-carmine"
          }`}
        >
          <span>
            RÉSULTAT DU LOT : {batchSummary.succeeded}/{batchSummary.total}{" "}
            {batchSummary.continuousGeneration24h
              ? "PRIS EN CHARGE (MODE CONTINU 24H/24)"
              : "PRÊT(S) POUR LE BATCH DE NUIT"}
            {batchSummary.failed > 0
              ? ` · ${batchSummary.failed} ERREUR(S) ISOLÉE(S)`
              : ""}
          </span>
          <button
            type="button"
            onClick={clearFinished}
            className="border border-border bg-card px-2 py-0.5 text-[10px] uppercase tracking-wider text-ink hover:border-ink"
          >
            VIDER LA LISTE
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
            CHAPITRE CIBLE
          </label>
          <select
            required
            disabled={uploading}
            value={chapterId}
            onChange={(e) => setChapterId(e.target.value)}
            className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none disabled:opacity-50"
          >
            {!hasChapters && <option value="">Aucun chapitre</option>}
            {chapterGroups.map((grp) => (
              <optgroup key={grp.key} label={grp.label}>
                {grp.chapters.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {"↳ ".repeat(ch.depth)}
                    {ch.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
            CATÉGORIE
          </label>
          <select
            disabled={uploading}
            value={category}
            onChange={(e) =>
              setCategory(
                e.target.value === "OFFICIAL_COURSE"
                  ? "OFFICIAL_COURSE"
                  : "STUDENT_NOTE"
              )
            }
            className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink focus:border-ink focus:outline-none disabled:opacity-50"
          >
            <option value="STUDENT_NOTE">NOTE ÉTUDIANTE</option>
            {canManage && (
              <option value="OFFICIAL_COURSE">COURS OFFICIEL</option>
            )}
          </select>
        </div>

        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
            TITRE PERSONNALISÉ (SI 1 SEUL PDF)
          </label>
          <input
            type="text"
            disabled={uploading || pendingItems.length > 1}
            value={singleTitle}
            onChange={(e) => setSingleTitle(e.target.value)}
            placeholder={
              pendingItems.length > 1
                ? "Auto : nom de chaque fichier"
                : "Optionnel (sinon nom du fichier)"
            }
            className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none disabled:opacity-50"
          />
        </div>
      </div>

      {/* Drag & Drop multi-PDF zone */}
      <div
        role="button"
        tabIndex={0}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => {
          if (!uploading) fileInputRef.current?.click();
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !uploading) {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`mt-4 flex cursor-pointer flex-col items-center justify-center border-2 border-dashed px-4 py-6 text-center transition-colors ${
          isDragOver
            ? "border-ink bg-pinned"
            : "border-border bg-paper hover:border-ink/60 hover:bg-paper/80"
        } ${uploading ? "pointer-events-none opacity-60" : ""}`}
      >
        <Upload className="mb-2 h-6 w-6 text-ink" />
        <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
          GLISSEZ-DÉPOSEZ VOS FICHIERS .PDF ICI OU CLIQUEZ POUR PARCOURIR
        </p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-stone">
          SÉLECTION MULTIPLE AUTORISÉE · JUSQU&apos;À 300 MO PAR LOT · PDF AVEC
          TEXTE SÉLECTIONNABLE
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              addFiles(e.target.files);
              // Reset input so re-selecting the same filename works after removal
              e.target.value = "";
            }
          }}
        />
      </div>

      {/* Selected files list with size, remove button and per-file live status */}
      {items.length > 0 && (
        <div className="mt-4 border border-border bg-paper">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3.5 py-2 font-mono text-[10px] uppercase tracking-wider text-stone">
            <span>
              FICHIERS SÉLECTIONNÉS ({items.length}) ·{" "}
              {pendingItems.length} EN ATTENTE D&apos;ENVOI
            </span>
            <span
              className={
                exceedsSizeLimit ? "font-bold text-carmine" : "text-ink"
              }
            >
              LOT À ENVOYER : {formatFileSize(totalPendingBytes)} / 300 Mo
            </span>
          </div>

          {exceedsSizeLimit && (
            <div className="border-b border-carmine/40 bg-carmine/10 px-3.5 py-2 font-mono text-[11px] text-carmine">
              Le lot dépasse 300 Mo. Retirez quelques fichiers avant l&apos;envoi.
            </div>
          )}

          <div className="max-h-64 divide-y divide-border overflow-y-auto bg-card">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 px-3.5 py-2.5"
              >
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-stone" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-xs font-semibold text-ink">
                        {item.file.name}
                      </span>
                      <span className="font-mono text-[10px] uppercase text-stone">
                        {formatFileSize(item.file.size)}
                      </span>
                    </div>

                    {item.status === "queued" && item.pageCount && (
                      <p className="mt-0.5 font-mono text-[10px] uppercase text-forest">
                        {item.pageCount} PAGE(S)
                        {typeof item.chunkCount === "number"
                          ? ` · ${item.chunkCount} EXTRAITS TEXTUELS ENREGISTRÉS`
                          : ""}
                      </p>
                    )}

                    {item.status === "error" && item.errorMessage && (
                      <p className="mt-0.5 font-mono text-[10px] text-carmine">
                        {item.errorMessage}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {item.status === "pending" && (
                    <span className="border border-border bg-paper px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-stone">
                      En attente
                    </span>
                  )}
                  {item.status === "uploading" && (
                    <span className="inline-flex items-center gap-1 border border-amber bg-pinned px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Envoi...</span>
                    </span>
                  )}
                  {item.status === "queued" && (
                    <span className="inline-flex items-center gap-1 border border-forest/40 bg-forest/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-forest">
                      <CheckCircle2 className="h-3 w-3" />
                      <span>Prêt pour le batch de nuit</span>
                    </span>
                  )}
                  {item.status === "error" && (
                    <span className="inline-flex items-center gap-1 border border-carmine/40 bg-carmine/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-carmine">
                      <AlertCircle className="h-3 w-3" />
                      <span>Erreur</span>
                    </span>
                  )}

                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => removeItem(item.id)}
                    title="Retirer ce fichier"
                    className="border border-border bg-paper p-1 text-stone hover:border-carmine hover:text-carmine disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
          UN FICHIER CORROMPU OU SCANNÉ N&apos;INTERROMPT PAS L&apos;ENVOI DES
          AUTRES PDF DU LOT
        </p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={uploading}
            onClick={onClose}
            className="border border-border bg-paper px-4 py-2 font-mono text-xs uppercase tracking-wider text-ink disabled:opacity-50"
          >
            FERMER
          </button>
          <button
            type="submit"
            disabled={
              uploading ||
              pendingItems.length === 0 ||
              !chapterId ||
              exceedsSizeLimit
            }
            className="inline-flex items-center gap-1.5 border border-ink bg-ink px-5 py-2 font-mono text-xs uppercase tracking-wider text-card disabled:opacity-50"
          >
            {uploading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>ENVOI EN COURS...</span>
              </>
            ) : (
              <span>
                {pendingItems.length > 1
                  ? `ENVOYER LES ${pendingItems.length} PDF`
                  : "PUBLIER LE PDF"}
              </span>
            )}
          </button>
        </div>
      </div>
    </form>
  );
}
