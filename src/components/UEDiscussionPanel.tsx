"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { io, type Socket } from "socket.io-client";
import {
  FileText,
  Hash,
  MessageSquare,
  Paperclip,
  PenTool,
  Send,
  X,
} from "lucide-react";
import type { ChatAttachment, ChatMessagePayload } from "@/lib/socket-types";

interface UEDocOption {
  id: string;
  title: string;
  fileName: string;
}

interface UEBoardOption {
  id: string;
  title: string;
  isPublic: boolean;
  isIntegrated: boolean;
}

interface UEDiscussionPanelProps {
  channelId: string;
  channelName: string;
  ueId: string;
  ueCode: string;
  documents: UEDocOption[];
  whiteboards: UEBoardOption[];
  onOpenDocument?: (documentId: string) => void;
}

function parseAttachment(raw: string | null): ChatAttachment | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ChatAttachment;
    if (parsed && parsed.id && parsed.kind) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function UEDiscussionPanel({
  channelId,
  channelName,
  ueId,
  ueCode,
  documents,
  whiteboards,
  onOpenDocument,
}: UEDiscussionPanelProps) {
  const { data: session } = useSession();
  const [messages, setMessages] = useState<ChatMessagePayload[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [inputText, setInputText] = useState("");
  const [selectedAttachment, setSelectedAttachment] =
    useState<ChatAttachment | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!channelId) return;
    let active = true;

    const socket = io({ path: "/api/socketio" });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join-channel", channelId);
    });

    socket.on("new-message", (msg: ChatMessagePayload) => {
      if (msg.channelId !== channelId) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });

    setLoadingMessages(true);
    fetch(`/api/channels/${channelId}/messages`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { messages?: ChatMessagePayload[] } | null) => {
        if (active && data?.messages) {
          setMessages(data.messages);
        }
      })
      .finally(() => {
        if (active) setLoadingMessages(false);
      });

    return () => {
      active = false;
      socket.emit("leave-channel", channelId);
      socket.disconnect();
    };
  }, [channelId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!channelId || !session?.user?.id) return;
    const trimmed = inputText.trim();
    if (!trimmed && !selectedAttachment) return;

    const attachmentJson = selectedAttachment
      ? JSON.stringify(selectedAttachment)
      : null;

    setInputText("");
    setSelectedAttachment(null);

    if (socketRef.current?.connected) {
      socketRef.current.emit("send-message", {
        channelId,
        authorId: session.user.id,
        content: trimmed,
        attachmentJson,
      });
    } else {
      const res = await fetch(`/api/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: trimmed, attachmentJson }),
      });
      if (res.ok) {
        const data = (await res.json()) as { message: ChatMessagePayload };
        setMessages((prev) =>
          prev.some((m) => m.id === data.message.id)
            ? prev
            : [...prev, data.message]
        );
      }
    }
  }

  const shareableBoards = whiteboards.filter(
    (wb) => wb.isPublic || wb.isIntegrated
  );

  return (
    <div className="flex h-[640px] flex-col border border-border bg-card">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-5 py-3">
        <div className="flex items-center gap-2">
          <Hash className="h-4 w-4 text-stone" />
          <span className="font-mono text-sm font-bold uppercase tracking-wider text-ink">
            {channelName}
          </span>
          <span className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-badge-text">
            DISCUSSION DÉDIÉE · {ueCode}
          </span>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
          TEMPS RÉEL SOCKET.IO
        </span>
      </div>

      {/* Messages Feed */}
      <div className="flex-1 space-y-3 overflow-y-auto p-5">
        {loadingMessages ? (
          <p className="font-mono text-xs uppercase tracking-wider text-stone">
            CHARGEMENT DES ÉCHANGES...
          </p>
        ) : messages.length === 0 ? (
          <div className="border border-border bg-paper p-8 text-center">
            <MessageSquare className="mx-auto mb-3 h-6 w-6 text-stone" />
            <p className="font-mono text-xs uppercase tracking-wider text-ink">
              AUCUNE DISCUSSION DANS {channelName}
            </p>
            <p className="mt-1 text-sm text-stone">
              Posez vos questions entre étudiants sur {ueCode} ou partagez un
              cours / tableau blanc.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const attachment = parseAttachment(msg.attachmentJson);
            const timeStr = new Date(msg.createdAt).toLocaleTimeString(
              "fr-FR",
              { hour: "2-digit", minute: "2-digit" }
            );
            return (
              <div
                key={msg.id}
                className="border border-border bg-paper p-3.5"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-ink">
                      {msg.author.name}
                    </span>
                    {msg.author.globalRole === "YEAR_ADMIN" && (
                      <span className="bg-badge-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-badge-text">
                        RESP. D&apos;ANNÉE
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                    {timeStr}
                  </span>
                </div>

                {msg.content && (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
                    {msg.content}
                  </p>
                )}

                {attachment &&
                  (attachment.kind === "DOCUMENT" && onOpenDocument ? (
                    <button
                      type="button"
                      onClick={() => onOpenDocument(attachment.id)}
                      className="mt-2.5 flex w-full items-center justify-between border border-border bg-card px-3 py-2 text-left transition-colors hover:border-ink hover:bg-pinned"
                    >
                      <div className="flex items-center gap-2.5">
                        <FileText className="h-4 w-4 text-badge-text" />
                        <div>
                          <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                            DOCUMENT PDF · {ueCode}
                          </p>
                          <p className="text-sm font-semibold text-ink">
                            {attachment.title}
                          </p>
                        </div>
                      </div>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-badge-text">
                        LIRE LE PDF ↗
                      </span>
                    </button>
                  ) : (
                    <Link
                      href={
                        attachment.kind === "WHITEBOARD"
                          ? `/whiteboard/${attachment.id}`
                          : `/ue/${ueId}?doc=${attachment.id}`
                      }
                      className="mt-2.5 flex items-center justify-between border border-border bg-card px-3 py-2 transition-colors hover:border-ink hover:bg-pinned"
                    >
                      <div className="flex items-center gap-2.5">
                        <PenTool className="h-4 w-4 text-forest" />
                        <div>
                          <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                            TABLEAU BLANC · {ueCode}
                          </p>
                          <p className="text-sm font-semibold text-ink">
                            {attachment.title}
                          </p>
                        </div>
                      </div>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-badge-text">
                        OUVRIR ↗
                      </span>
                    </Link>
                  ))}
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Attachment Picker */}
      {pickerOpen && (
        <div className="border-t border-ink bg-pinned p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              JOINDRE UNE RESSOURCE DE {ueCode}
            </span>
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="text-stone hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid max-h-44 grid-cols-1 gap-3 overflow-y-auto md:grid-cols-2">
            <div className="space-y-1">
              <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                DOCUMENTS PDF ({documents.length})
              </p>
              {documents.length === 0 ? (
                <p className="font-mono text-[10px] text-stone">
                  Aucun PDF dans cette UE.
                </p>
              ) : (
                documents.map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => {
                      setSelectedAttachment({
                        kind: "DOCUMENT",
                        id: doc.id,
                        title: doc.title,
                        fileName: doc.fileName,
                        ueId,
                        ueCode,
                      });
                      setPickerOpen(false);
                    }}
                    className="block w-full truncate border border-border bg-card px-2.5 py-1.5 text-left text-xs font-medium text-ink hover:border-ink"
                  >
                    {doc.title}
                  </button>
                ))
              )}
            </div>

            <div className="space-y-1">
              <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                TABLEAUX PUBLICS / INTÉGRÉS ({shareableBoards.length})
              </p>
              {shareableBoards.length === 0 ? (
                <p className="font-mono text-[10px] text-stone">
                  Aucun tableau public dans cette UE.
                </p>
              ) : (
                shareableBoards.map((wb) => (
                  <button
                    key={wb.id}
                    type="button"
                    onClick={() => {
                      setSelectedAttachment({
                        kind: "WHITEBOARD",
                        id: wb.id,
                        title: wb.title,
                        ueId,
                        ueCode,
                      });
                      setPickerOpen(false);
                    }}
                    className="block w-full truncate border border-border bg-card px-2.5 py-1.5 text-left text-xs font-medium text-ink hover:border-ink"
                  >
                    {wb.title}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Composer */}
      <form
        onSubmit={handleSendMessage}
        className="border-t border-border bg-paper p-3.5"
      >
        {selectedAttachment && (
          <div className="mb-2 flex items-center justify-between border border-badge-text/30 bg-badge-bg px-3 py-1.5 font-mono text-xs text-badge-text">
            <span>
              PIÈCE JOINTE : {selectedAttachment.title} (
              {selectedAttachment.kind})
            </span>
            <button
              type="button"
              onClick={() => setSelectedAttachment(null)}
              className="text-badge-text hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPickerOpen((prev) => !prev)}
            title="Joindre un document ou un tableau"
            className="inline-flex items-center gap-1.5 border border-border bg-card px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:border-ink"
          >
            <Paperclip className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">JOINDRE</span>
          </button>

          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={`Écrire dans ${channelName}...`}
            className="flex-1 border border-border bg-card px-3 py-2 text-sm text-ink placeholder:text-stone focus:border-ink focus:outline-none"
          />

          <button
            type="submit"
            disabled={!inputText.trim() && !selectedAttachment}
            className="inline-flex items-center gap-1.5 border border-ink bg-ink px-4 py-2 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            <span>ENVOYER</span>
          </button>
        </div>
      </form>
    </div>
  );
}
