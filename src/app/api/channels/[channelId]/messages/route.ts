import { NextResponse } from "next/server";
import type { Server as SocketIOServer } from "socket.io";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: { channelId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const messages = await prisma.message.findMany({
    where: { channelId: params.channelId },
    orderBy: { createdAt: "asc" },
    take: 200,
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

  return NextResponse.json({ messages });
}

export async function POST(
  req: Request,
  { params }: { params: { channelId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      content?: string;
      attachmentJson?: string | null;
    };

    const content = body.content?.trim() || "";
    const attachmentJson = body.attachmentJson ?? null;

    if (!content && !attachmentJson) {
      return NextResponse.json(
        { error: "Le message ne peut pas être vide." },
        { status: 400 }
      );
    }

    const message = await prisma.message.create({
      data: {
        channelId: params.channelId,
        authorId: user.id,
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

    const io = (
      globalThis as typeof globalThis & { __araSocketIo?: SocketIOServer }
    ).__araSocketIo;

    if (io) {
      io.to(`channel:${params.channelId}`).emit("new-message", {
        id: message.id,
        channelId: message.channelId,
        authorId: message.authorId,
        content: message.content,
        attachmentJson: message.attachmentJson,
        createdAt: message.createdAt.toISOString(),
        author: message.author,
      });
    }

    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    console.error("[Messages POST] Error:", error);
    return NextResponse.json(
      { error: "Impossible d'envoyer le message." },
      { status: 500 }
    );
  }
}
