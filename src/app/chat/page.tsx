"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { io, type Socket } from "socket.io-client";
import {
  FileText,
  Hash,
  MessageSquare,
  Paperclip,
  PenTool,
  Plus,
  Send,
  X,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import type { ChatAttachment, ChatMessagePayload } from "@/lib/socket-types";

interface ChannelItem {
  id: string;
  name: string;
  type: "GENERAL" | "UE_CHANNEL" | "GROUP";
  ueId: string | null;
  ue: {
    id: string;
    code: string;
    title: string;
    accentColor: string;
  } | null;
  _count: { messages: number };
}

interface PickerDoc {
  id: string;
  title: string;
  fileName: string;
  chapter: {
    ue: { id: string; code: string; title: string };
  };
}

interface PickerBoard {
  id: string;
  title: string;
  ue: { id: string; code: string } | null;
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

function ChatWorkspaceContent() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  const requestedChannelId = searchParams.get("channelId");

  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string>("");
  const activeChannelIdRef = useRef<string>("");

  const [messages, setMessages] = useState<ChatMessagePayload[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const [inputText, setInputText] = useState("");
  const [selectedAttachment, setSelectedAttachment] =
    useState<ChatAttachment | null>(null);

  // Create group channel
  const [newChannelName, setNewChannelName] = useState("");
  const [creatingChannel, setCreatingChannel] = useState(false);

  // Attachment picker
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerDocs, setPickerDocs] = useState<PickerDoc[]>([]);
  const [pickerBoards, setPickerBoards] = useState<PickerBoard[]>([]);

  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch("/api/channels", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { channels: ChannelItem[] };
      setChannels(data.channels);

      setActiveChannelId((prev) => {
        if (
          requestedChannelId &&
          data.channels.some((c) => c.id === requestedChannelId)
        ) {
          return requestedChannelId;
        }
        if (prev && data.channels.some((c) => c.id === prev)) {
          return prev;
        }
        return data.channels[0]?.id || "";
      });
    } finally {
      setLoadingChannels(false);
    }
  }, [requestedChannelId]);

  useEffect(() => {
    void fetchChannels();
  }, [fetchChannels]);

  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
  }, [activeChannelId]);

  // Socket.io setup
  useEffect(() => {
    const socket = io({ path: "/api/socketio" });
    socketRef.current = socket;

    socket.on("connect", () => {
      if (activeChannelIdRef.current) {
        socket.emit("join-channel", activeChannelIdRef.current);
      }
    });

    socket.on("new-message", (msg: ChatMessagePayload) => {
      if (msg.channelId !== activeChannelIdRef.current) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Load messages & join Socket.io room when activeChannelId changes
  useEffect(() => {
    if (!activeChannelId) return;
    let active = true;

    const socket = socketRef.current;
    if (socket) {
      socket.emit("join-channel", activeChannelId);
    }

    setLoadingMessages(true);
    fetch(`/api/channels/${activeChannelId}/messages`, { cache: "no-store" })
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
      if (socket) {
        socket.emit("leave-channel", activeChannelId);
      }
    };
  }, [activeChannelId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function openAttachmentPicker() {
    setPickerOpen((prev) => !prev);
    if (pickerDocs.length === 0 && pickerBoards.length === 0) {
      const [docsRes, boardsRes] = await Promise.all([
        fetch("/api/documents", { cache: "no-store" }),
        fetch("/api/whiteboards", { cache: "no-store" }),
      ]);
      if (docsRes.ok) {
        const d = (await docsRes.json()) as { documents?: PickerDoc[] };
        setPickerDocs(d.documents || []);
      }
      if (boardsRes.ok) {
        const b = (await boardsRes.json()) as { whiteboards?: PickerBoard[] };
        setPickerBoards(b.whiteboards || []);
      }
    }
  }

  async function handleCreateChannel(e: React.FormEvent) {
    e.preventDefault();
    if (!newChannelName.trim() || creatingChannel) return;
    setCreatingChannel(true);
    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newChannelName.trim() }),
      });
      if (res.ok) {
        const data = (await res.json()) as { channel: ChannelItem };
        setNewChannelName("");
        await fetchChannels();
        setActiveChannelId(data.channel.id);
      }
    } finally {
      setCreatingChannel(false);
    }
  }

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!activeChannelId || !session?.user?.id) return;
    const trimmed = inputText.trim();
    if (!trimmed && !selectedAttachment) return;

    const attachmentJson = selectedAttachment
      ? JSON.stringify(selectedAttachment)
      : null;

    setInputText("");
    setSelectedAttachment(null);

    if (socketRef.current?.connected) {
      socketRef.current.emit("send-message", {
        channelId: activeChannelId,
        authorId: session.user.id,
        content: trimmed,
        attachmentJson,
      });
    } else {
      const res = await fetch(`/api/channels/${activeChannelId}/messages`, {
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

  const activeChannel = channels.find((c) => c.id === activeChannelId);
  const generalChannels = channels.filter((c) => c.type === "GENERAL");
  const ueChannels = channels.filter((c) => c.type === "UE_CHANNEL");
  const groupChannels = channels.filter((c) => c.type === "GROUP");

  return (
    <div className="grid h-[calc(100vh-220px)] min-h-[540px] grid-cols-1 border border-border bg-card lg:grid-cols-12">
      {/* Left Channels Sidebar */}
      <aside className="flex flex-col border-b border-border bg-paper lg:col-span-3 lg:border-b-0 lg:border-r">
        <div className="border-b border-border px-4 py-3 font-mono text-xs font-semibold uppercase tracking-wider text-ink">
          CANAUX DE PROMOTION
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-3">
          {loadingChannels ? (
            <p className="font-mono text-xs uppercase text-stone">
              CHARGEMENT...
            </p>
          ) : (
            <>
              <div>
                <p className="mb-1.5 px-2 font-mono text-[10px] uppercase tracking-wider text-stone">
                  GÉNÉRAL
                </p>
                {generalChannels.map((ch) => (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => setActiveChannelId(ch.id)}
                    className={`flex w-full items-center justify-between px-2.5 py-2 font-mono text-xs transition-colors ${
                      activeChannelId === ch.id
                        ? "border border-ink bg-card font-semibold text-ink"
                        : "text-stone hover:bg-pinned hover:text-ink"
                    }`}
                  >
                    <span className="truncate">{ch.name}</span>
                  </button>
                ))}
              </div>

              <div>
                <p className="mb-1.5 px-2 font-mono text-[10px] uppercase tracking-wider text-stone">
                  CANAUX PAR UE ({ueChannels.length})
                </p>
                {ueChannels.length === 0 ? (
                  <p className="px-2 font-mono text-[10px] text-stone">
                    CRÉÉS AUTO. AVEC CHAQUE UE
                  </p>
                ) : (
                  ueChannels.map((ch) => (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => setActiveChannelId(ch.id)}
                      className={`mb-0.5 flex w-full items-center justify-between px-2.5 py-2 font-mono text-xs transition-colors ${
                        activeChannelId === ch.id
                          ? "border border-ink bg-card font-semibold text-ink"
                          : "text-stone hover:bg-pinned hover:text-ink"
                      }`}
                    >
                      <span className="truncate">{ch.name}</span>
                      {ch.ue && (
                        <span
                          className="h-2 w-2 shrink-0"
                          style={{ backgroundColor: ch.ue.accentColor }}
                        />
                      )}
                    </button>
                  ))
                )}
              </div>

              <div>
                <p className="mb-1.5 px-2 font-mono text-[10px] uppercase tracking-wider text-stone">
                  GROUPES D&apos;ÉTUDE ({groupChannels.length})
                </p>
                {groupChannels.map((ch) => (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => setActiveChannelId(ch.id)}
                    className={`mb-0.5 flex w-full items-center justify-between px-2.5 py-2 font-mono text-xs transition-colors ${
                      activeChannelId === ch.id
                        ? "border border-ink bg-card font-semibold text-ink"
                        : "text-stone hover:bg-pinned hover:text-ink"
                    }`}
                  >
                    <span className="truncate">{ch.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Create Group Channel */}
        <form
          onSubmit={handleCreateChannel}
          className="border-t border-border bg-card p-3"
        >
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-stone">
            NOUVEAU CANAL GROUPE
          </p>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              placeholder="#revision-tp"
              className="min-w-0 flex-1 border border-border bg-paper px-2.5 py-1.5 font-mono text-xs text-ink focus:border-ink focus:outline-none"
            />
            <button
              type="submit"
              disabled={creatingChannel || !newChannelName.trim()}
              className="border border-ink bg-ink px-2.5 py-1.5 text-card disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </form>
      </aside>

      {/* Main Chat Feed */}
      <section className="flex min-h-0 flex-col lg:col-span-9">
        {/* Channel Header */}
        <div className="flex items-center justify-between border-b border-border bg-paper px-5 py-3">
          <div className="flex items-center gap-2">
            <Hash className="h-4 w-4 text-stone" />
            <span className="font-mono text-sm font-bold uppercase tracking-wider text-ink">
              {activeChannel?.name || "CANAL"}
            </span>
            {activeChannel?.ue && (
              <Link
                href={`/ue/${activeChannel.ue.id}`}
                className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-badge-text hover:underline"
              >
                {activeChannel.ue.code} · {activeChannel.ue.title}
              </Link>
            )}
          </div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
            SOCKET.IO TEMPS RÉEL
          </span>
        </div>

        {/* Messages */}
        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {loadingMessages ? (
            <p className="font-mono text-xs uppercase tracking-wider text-stone">
              CHARGEMENT DES MESSAGES...
            </p>
          ) : messages.length === 0 ? (
            <div className="border border-border bg-paper p-8 text-center">
              <MessageSquare className="mx-auto mb-3 h-6 w-6 text-stone" />
              <p className="font-mono text-xs uppercase tracking-wider text-ink">
                AUCUN MESSAGE DANS {activeChannel?.name || "CE CANAL"}
              </p>
              <p className="mt-1 text-sm text-stone">
                Démarrez la discussion ou partagez un cours PDF / tableau blanc
                avec votre promotion.
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

                  {attachment && (
                    <Link
                      href={
                        attachment.kind === "DOCUMENT" && attachment.ueId
                          ? `/ue/${attachment.ueId}?doc=${attachment.id}`
                          : attachment.kind === "WHITEBOARD"
                          ? `/whiteboard/${attachment.id}`
                          : "/"
                      }
                      className="mt-2.5 flex items-center justify-between border border-border bg-card px-3 py-2 transition-colors hover:border-ink hover:bg-pinned"
                    >
                      <div className="flex items-center gap-2.5">
                        {attachment.kind === "DOCUMENT" ? (
                          <FileText className="h-4 w-4 text-badge-text" />
                        ) : (
                          <PenTool className="h-4 w-4 text-forest" />
                        )}
                        <div>
                          <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                            {attachment.kind === "DOCUMENT"
                              ? `COURS / NOTE PDF ${
                                  attachment.ueCode
                                    ? `· ${attachment.ueCode}`
                                    : ""
                                }`
                              : `TABLEAU BLANC COLLABORATIF ${
                                  attachment.ueCode
                                    ? `· ${attachment.ueCode}`
                                    : ""
                                }`}
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
                  )}
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Attachment Picker Modal/Popover */}
        {pickerOpen && (
          <div className="border-t border-ink bg-pinned p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                JOINDRE UN COURS PDF OU UN TABLEAU BLANC
              </span>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="text-stone hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid max-h-48 grid-cols-1 gap-3 overflow-y-auto md:grid-cols-2">
              <div className="space-y-1">
                <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                  DOCUMENTS PDF ({pickerDocs.length})
                </p>
                {pickerDocs.length === 0 ? (
                  <p className="font-mono text-[10px] text-stone">
                    Aucun document PDF.
                  </p>
                ) : (
                  pickerDocs.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => {
                        setSelectedAttachment({
                          kind: "DOCUMENT",
                          id: doc.id,
                          title: doc.title,
                          fileName: doc.fileName,
                          ueId: doc.chapter.ue.id,
                          ueCode: doc.chapter.ue.code,
                        });
                        setPickerOpen(false);
                      }}
                      className="flex w-full items-center justify-between border border-border bg-card px-2.5 py-1.5 text-left text-xs hover:border-ink"
                    >
                      <span className="truncate font-medium text-ink">
                        {doc.title}
                      </span>
                      <span className="ml-2 shrink-0 font-mono text-[10px] text-stone">
                        {doc.chapter.ue.code}
                      </span>
                    </button>
                  ))
                )}
              </div>

              <div className="space-y-1">
                <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                  TABLEAUX BLANCS ({pickerBoards.length})
                </p>
                {pickerBoards.length === 0 ? (
                  <p className="font-mono text-[10px] text-stone">
                    Aucun tableau blanc.
                  </p>
                ) : (
                  pickerBoards.map((wb) => (
                    <button
                      key={wb.id}
                      type="button"
                      onClick={() => {
                        setSelectedAttachment({
                          kind: "WHITEBOARD",
                          id: wb.id,
                          title: wb.title,
                          ueId: wb.ue?.id || null,
                          ueCode: wb.ue?.code || null,
                        });
                        setPickerOpen(false);
                      }}
                      className="flex w-full items-center justify-between border border-border bg-card px-2.5 py-1.5 text-left text-xs hover:border-ink"
                    >
                      <span className="truncate font-medium text-ink">
                        {wb.title}
                      </span>
                      <span className="ml-2 shrink-0 font-mono text-[10px] text-stone">
                        {wb.ue?.code || "GÉNÉRAL"}
                      </span>
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
              onClick={openAttachmentPicker}
              title="Joindre un cours ou un tableau blanc"
              className="inline-flex items-center gap-1.5 border border-border bg-card px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:border-ink"
            >
              <Paperclip className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">JOINDRE</span>
            </button>

            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={`Écrire dans ${activeChannel?.name || "le canal"}...`}
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
      </section>
    </div>
  );
}

export default function ChatPage() {
  return (
    <AppShell>
      <Suspense
        fallback={
          <div className="border border-border bg-card p-8 font-mono text-xs uppercase tracking-wider text-stone">
            CHARGEMENT DU CHAT PROMO...
          </div>
        }
      >
        <ChatWorkspaceContent />
      </Suspense>
    </AppShell>
  );
}
