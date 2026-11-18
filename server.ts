import http from "node:http";
import next from "next";
import { Server as SocketIOServer } from "socket.io";
import { prisma } from "./src/lib/prisma";
import type { WhiteboardCollaborator } from "./src/lib/socket-types";
import { runNightlyOffPeakStudyGeneration } from "./src/lib/studio";
import { getUserAccountMeta } from "./src/lib/user-schema";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = Number.parseInt(process.env.PORT || "3000", 10);

const globalForSocket = globalThis as typeof globalThis & {
  __araSocketIo?: SocketIOServer;
  __araNightlyWorkerStarted?: boolean;
};

const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();

// Presence tracking: whiteboardId -> Map<socketId, WhiteboardCollaborator>
const whiteboardPresence = new Map<string, Map<string, WhiteboardCollaborator>>();

function emitWhiteboardPresence(io: SocketIOServer, whiteboardId: string) {
  const members = whiteboardPresence.get(whiteboardId);
  const list = members ? Array.from(members.values()) : [];
  io.to(`whiteboard:${whiteboardId}`).emit("whiteboard-presence", list);
}

app.prepare().then(() => {
  const httpServer = http.createServer((req, res) => {
    res.removeHeader("X-Powered-By");
    res.setHeader(
      "X-Robots-Tag",
      "noindex, nofollow, noarchive, nosnippet, noimageindex"
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), interest-cohort=()"
    );
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    handler(req, res);
  });

  const io = new SocketIOServer(httpServer, {
    path: "/api/socketio",
    addTrailingSlash: false,
    cors: {
      origin: false,
    },
  });

  io.use((socket, nextMiddleware) => {
    const cookieHeader = socket.handshake.headers.cookie || "";
    const hasSessionCookie =
      /(?:^|;\s*)(?:__Secure-)?(?:authjs|next-auth)\.session-token(?:\.\d+)?=([^;\s]+)/.test(
        cookieHeader
      );
    if (!hasSessionCookie) {
      return nextMiddleware(new Error("Non authentifié"));
    }
    return nextMiddleware();
  });

  globalForSocket.__araSocketIo = io;

  io.on("connection", (socket) => {
    socket.on("join-channel", (channelId: string) => {
      if (typeof channelId === "string" && channelId) {
        socket.join(`channel:${channelId}`);
      }
    });

    socket.on("leave-channel", (channelId: string) => {
      if (typeof channelId === "string" && channelId) {
        socket.leave(`channel:${channelId}`);
      }
    });

    socket.on(
      "send-message",
      async (payload: {
        channelId?: string;
        authorId?: string;
        content?: string;
        attachmentJson?: string | null;
      }) => {
        try {
          const channelId = payload.channelId?.trim();
          const authorId = payload.authorId?.trim();
          const content = payload.content?.trim() || "";
          const attachmentJson = payload.attachmentJson ?? null;

          if (!channelId || !authorId || (!content && !attachmentJson)) {
            return;
          }

          const authorRecord = await prisma.user.findUnique({
            where: { id: authorId },
            select: { id: true, globalRole: true },
          });
          if (!authorRecord) {
            return;
          }
          const authorMeta = await getUserAccountMeta(authorId);
          if (!authorMeta.isApproved && authorRecord.globalRole !== "YEAR_ADMIN") {
            return;
          }

          const message = await prisma.message.create({
            data: {
              channelId,
              authorId,
              content,
              attachmentJson,
            },
            include: {
              author: {
                select: {
                  id: true,
                  name: true,
                  globalRole: true,
                },
              },
            },
          });

          io.to(`channel:${channelId}`).emit("new-message", {
            id: message.id,
            channelId: message.channelId,
            authorId: message.authorId,
            content: message.content,
            attachmentJson: message.attachmentJson,
            createdAt: message.createdAt.toISOString(),
            author: message.author,
          });
        } catch (err) {
          console.error("[Socket.io] send-message error:", err);
        }
      }
    );

    socket.on(
      "join-whiteboard",
      (payload: {
        whiteboardId?: string;
        userId?: string;
        userName?: string;
        color?: string;
      }) => {
        const whiteboardId = payload.whiteboardId?.trim();
        if (!whiteboardId) return;

        socket.join(`whiteboard:${whiteboardId}`);

        if (!whiteboardPresence.has(whiteboardId)) {
          whiteboardPresence.set(whiteboardId, new Map());
        }

        const roomMap = whiteboardPresence.get(whiteboardId)!;
        roomMap.set(socket.id, {
          socketId: socket.id,
          userId: payload.userId || socket.id,
          userName: payload.userName || "Étudiant",
          color: payload.color || "#3D6B99",
        });

        emitWhiteboardPresence(io, whiteboardId);
      }
    );

    socket.on("leave-whiteboard", (whiteboardId: string) => {
      if (!whiteboardId) return;
      socket.leave(`whiteboard:${whiteboardId}`);
      const roomMap = whiteboardPresence.get(whiteboardId);
      if (roomMap) {
        roomMap.delete(socket.id);
        if (roomMap.size === 0) {
          whiteboardPresence.delete(whiteboardId);
        } else {
          emitWhiteboardPresence(io, whiteboardId);
        }
      }
    });

    socket.on(
      "whiteboard-cursor",
      (payload: {
        whiteboardId?: string;
        userId?: string;
        userName?: string;
        color?: string;
        x?: number;
        y?: number;
      }) => {
        const whiteboardId = payload.whiteboardId?.trim();
        if (!whiteboardId) return;

        socket.to(`whiteboard:${whiteboardId}`).emit("whiteboard-remote-cursor", {
          socketId: socket.id,
          userId: payload.userId || socket.id,
          userName: payload.userName || "Étudiant",
          color: payload.color || "#3D6B99",
          x: Number(payload.x ?? 0),
          y: Number(payload.y ?? 0),
        });
      }
    );

    socket.on(
      "whiteboard-update",
      (payload: {
        whiteboardId?: string;
        userId?: string;
        snapshot?: string;
      }) => {
        const whiteboardId = payload.whiteboardId?.trim();
        if (!whiteboardId || typeof payload.snapshot !== "string") return;

        socket.to(`whiteboard:${whiteboardId}`).emit("whiteboard-remote-update", {
          whiteboardId,
          userId: payload.userId || socket.id,
          snapshot: payload.snapshot,
        });
      }
    );

    socket.on("disconnect", () => {
      whiteboardPresence.forEach((roomMap, whiteboardId) => {
        if (roomMap.has(socket.id)) {
          roomMap.delete(socket.id);
          if (roomMap.size === 0) {
            whiteboardPresence.delete(whiteboardId);
          } else {
            emitWhiteboardPresence(io, whiteboardId);
          }
        }
      });
    });
  });

  httpServer.listen(port, hostname, () => {
    console.log(`> Ara prêt sur http://localhost:${port}`);

    if (!globalForSocket.__araNightlyWorkerStarted) {
      globalForSocket.__araNightlyWorkerStarted = true;
      setInterval(() => {
        const hour = new Date().getHours();
        if (hour >= 0 && hour < 7) {
          void runNightlyOffPeakStudyGeneration({ mode: "NIGHTLY_AUTO" })
            .then((res) => {
              if (
                !res.skipped &&
                (res.indexedCount > 0 || res.generatedCount > 0)
              ) {
                console.log(
                  `[NightlyStudio] Heures creuses : ${res.indexedCount} PDF indexé(s), ${res.generatedCount} ressource(s) IA générée(s).`
                );
              }
            })
            .catch((err) => {
              console.warn("[NightlyStudio] Background tick warning:", err);
            });
        }
      }, 30 * 60 * 1000);
    }
  });
});
