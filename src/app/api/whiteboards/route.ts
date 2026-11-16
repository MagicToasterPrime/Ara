import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManageUE, getCurrentUser } from "@/lib/auth";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const ueId = searchParams.get("ueId");
  const scope = searchParams.get("scope");

  const visibilityWhere =
    scope === "mine"
      ? { creatorId: user.id }
      : scope === "public"
      ? { OR: [{ isPublic: true }, { isIntegrated: true }] }
      : {
          OR: [
            { creatorId: user.id },
            { isPublic: true },
            { isIntegrated: true },
          ],
        };

  const whiteboards = await prisma.whiteboard.findMany({
    where: {
      ...(ueId ? { ueId } : {}),
      ...visibilityWhere,
    },
    orderBy: [{ isIntegrated: "desc" }, { updatedAt: "desc" }],
    include: {
      ue: {
        select: {
          id: true,
          code: true,
          title: true,
          accentColor: true,
        },
      },
      creator: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  return NextResponse.json({ whiteboards });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      title?: string;
      ueId?: string | null;
      isPublic?: boolean;
      autoIntegrate?: boolean;
    };

    const title = body.title?.trim() || "Nouveau tableau blanc";
    const ueId = body.ueId?.trim() || null;

    let isPublic = Boolean(body.isPublic);
    let isIntegrated = false;

    if (ueId && body.autoIntegrate) {
      const allowed = await canManageUE(user.id, user.globalRole, ueId);
      if (allowed) {
        isPublic = true;
        isIntegrated = true;
      }
    }

    const whiteboard = await prisma.whiteboard.create({
      data: {
        title,
        ueId,
        creatorId: user.id,
        isPublic,
        isIntegrated,
        snapshotData: "{}",
      },
      include: {
        ue: {
          select: {
            id: true,
            code: true,
            title: true,
            accentColor: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return NextResponse.json({ whiteboard }, { status: 201 });
  } catch (error) {
    console.error("[Whiteboards POST] Error:", error);
    return NextResponse.json(
      { error: "Impossible de créer le tableau blanc." },
      { status: 500 }
    );
  }
}
