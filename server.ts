import http from "node:http";
import next from "next";
import { Server as SocketIOServer } from "socket.io";
import { prisma } from "./src/lib/prisma";
import type { WhiteboardCollaborator } from "./src/lib/socket-types";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = Number.parseInt(process.env.PORT || "3000", 10);

const globalForSocket = globalThis as typeof globalThis & {
  __araSocketIo?: SocketIOServer;
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
    handler(req, res);
  });

  const io = new SocketIOServer(httpServer, {
    path: "/api/socketio",
    addTrailingSlash: false,
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
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
  });
});
