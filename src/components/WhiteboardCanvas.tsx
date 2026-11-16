"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Tldraw, getSnapshot, loadSnapshot, type Editor } from "tldraw";
import "tldraw/tldraw.css";
import { io, type Socket } from "socket.io-client";
import type {
  WhiteboardCollaborator,
  WhiteboardCursorPayload,
  WhiteboardUpdatePayload,
} from "@/lib/socket-types";

interface WhiteboardCanvasProps {
  whiteboardId: string;
  initialSnapshot: string;
  userId: string;
  userName: string;
}

const COLLABORATOR_COLORS = [
  "#D99B26",
  "#C83E4D",
  "#3B7A57",
  "#3D6B99",
  "#2B547E",
];

function pickColorForUser(id: string): string {
  let sum = 0;
  for (let i = 0; i < id.length; i += 1) {
    sum += id.charCodeAt(i);
  }
  return COLLABORATOR_COLORS[sum % COLLABORATOR_COLORS.length];
}

interface RemoteCursorState {
  socketId: string;
  userId: string;
  userName: string;
  color: string;
  x: number;
  y: number;
  updatedAt: number;
}

export function WhiteboardCanvas({
  whiteboardId,
  initialSnapshot,
  userId,
  userName,
}: WhiteboardCanvasProps) {
  const editorRef = useRef<Editor | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const isApplyingRemoteRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBroadcastRef = useRef(0);
  const lastCursorSentRef = useRef(0);
  const myColor = pickColorForUser(userId);

  const [collaborators, setCollaborators] = useState<WhiteboardCollaborator[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<
    Record<string, RemoteCursorState>
  >({});
  const [saveStatus, setSaveStatus] = useState<string>("SYNCHRONISÉ");

  const persistSnapshot = useCallback(
    async (snapshotString: string) => {
      try {
        setSaveStatus("SAUVEGARDE...");
        const res = await fetch(`/api/whiteboards/${whiteboardId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ snapshotData: snapshotString }),
        });
        if (res.ok) {
          const now = new Date().toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          setSaveStatus(`SAUVEGARDÉ EN POSTGRESQL · ${now}`);
        } else {
          setSaveStatus("ERREUR DE SAUVEGARDE");
        }
      } catch {
        setSaveStatus("ERREUR RÉSEAU");
      }
    },
    [whiteboardId]
  );

  // Socket.io connection for live collaboration & cursors
  useEffect(() => {
    const socket = io({
      path: "/api/socketio",
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join-whiteboard", {
        whiteboardId,
        userId,
        userName,
        color: myColor,
      });
    });

    socket.on("whiteboard-presence", (list: WhiteboardCollaborator[]) => {
      setCollaborators(list);
    });

    socket.on(
      "whiteboard-remote-cursor",
      (payload: WhiteboardCursorPayload & { socketId: string }) => {
        if (payload.userId === userId) return;
        setRemoteCursors((prev) => ({
          ...prev,
          [payload.socketId]: {
            socketId: payload.socketId,
            userId: payload.userId,
            userName: payload.userName,
            color: payload.color,
            x: payload.x,
            y: payload.y,
            updatedAt: Date.now(),
          },
        }));
      }
    );

    socket.on(
      "whiteboard-remote-update",
      (payload: WhiteboardUpdatePayload) => {
        if (payload.userId === userId || !editorRef.current) return;
        try {
          const parsed = JSON.parse(payload.snapshot);
          if (parsed && typeof parsed === "object" && "document" in parsed) {
            isApplyingRemoteRef.current = true;
            loadSnapshot(editorRef.current.store, parsed);
          }
        } catch {
          // Ignore malformed snapshot update
        } finally {
          setTimeout(() => {
            isApplyingRemoteRef.current = false;
          }, 50);
        }
      }
    );

    const pruneInterval = setInterval(() => {
      const cutoff = Date.now() - 8000;
      setRemoteCursors((prev) => {
        const next: Record<string, RemoteCursorState> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (v.updatedAt >= cutoff) {
            next[k] = v;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 3000);

    return () => {
      clearInterval(pruneInterval);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      socket.emit("leave-whiteboard", whiteboardId);
      socket.disconnect();
    };
  }, [whiteboardId, userId, userName, myColor]);

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;

      if (initialSnapshot && initialSnapshot !== "{}") {
        try {
          const parsed = JSON.parse(initialSnapshot);
          if (parsed && typeof parsed === "object" && "document" in parsed) {
            isApplyingRemoteRef.current = true;
            loadSnapshot(editor.store, parsed);
            setTimeout(() => {
              isApplyingRemoteRef.current = false;
            }, 50);
          }
        } catch {
          // Start clean if snapshot JSON is empty or invalid
        }
      }

      const unsubscribe = editor.store.listen(
        () => {
          if (isApplyingRemoteRef.current) return;

          const snapshot = getSnapshot(editor.store);
          const serialized = JSON.stringify(snapshot);
          const now = Date.now();

          // Real-time broadcast throttled every 120ms
          if (socketRef.current && now - lastBroadcastRef.current >= 120) {
            lastBroadcastRef.current = now;
            socketRef.current.emit("whiteboard-update", {
              whiteboardId,
              userId,
              snapshot: serialized,
            });
          }

          // Debounced auto-save every 3s to PostgreSQL
          setSaveStatus("MODIFICATIONS EN ATTENTE...");
          if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
          }
          saveTimerRef.current = setTimeout(() => {
            if (socketRef.current) {
              socketRef.current.emit("whiteboard-update", {
                whiteboardId,
                userId,
                snapshot: serialized,
              });
            }
            void persistSnapshot(serialized);
          }, 3000);
        },
        { source: "user", scope: "document" }
      );

      return () => {
        unsubscribe();
      };
    },
    [initialSnapshot, persistSnapshot, userId, whiteboardId]
  );

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const now = Date.now();
    if (!socketRef.current || now - lastCursorSentRef.current < 60) return;
    const rect = e.currentTarget.getBoundingClientRect();
    lastCursorSentRef.current = now;
    socketRef.current.emit("whiteboard-cursor", {
      whiteboardId,
      userId,
      userName,
      color: myColor,
      x: Math.round(e.clientX - rect.left),
      y: Math.round(e.clientY - rect.top),
    });
  }

  return (
    <div className="flex h-full flex-col border border-border bg-card">
      {/* Status & Presence Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-paper px-4 py-2">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-stone">
          <span className="inline-block h-2 w-2 bg-forest" />
          <span>{saveStatus}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
            COLLABORATEURS ACTIFS ({collaborators.length}) :
          </span>
          {collaborators.map((member) => (
            <span
              key={member.socketId}
              className="inline-flex items-center gap-1.5 border border-border bg-card px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink"
            >
              <span
                className="inline-block h-2 w-2"
                style={{ backgroundColor: member.color }}
              />
              {member.userName}
            </span>
          ))}
        </div>
      </div>

      {/* Canvas Container */}
      <div
        onPointerMove={handlePointerMove}
        className="relative flex-1 overflow-hidden bg-card"
      >
        <Tldraw onMount={handleMount} />

        {/* Live Remote Cursors Overlay */}
        <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
          {Object.values(remoteCursors).map((cursor) => (
            <div
              key={cursor.socketId}
              className="absolute transition-transform duration-75"
              style={{
                transform: `translate(${cursor.x}px, ${cursor.y}px)`,
              }}
            >
              <div
                className="h-3 w-3 border border-card"
                style={{ backgroundColor: cursor.color }}
              />
              <span
                className="mt-0.5 inline-block px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-card"
                style={{ backgroundColor: cursor.color }}
              >
                {cursor.userName}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
