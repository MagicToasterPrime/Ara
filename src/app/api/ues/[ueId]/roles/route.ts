import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

export async function POST(
  req: Request,
  { params }: { params: { ueId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  if (user.globalRole !== "YEAR_ADMIN") {
    return NextResponse.json(
      { error: "Réservé au Responsable d'Année" },
      { status: 403 }
    );
  }

  try {
    const body = (await req.json()) as { userId?: string };
    const targetUserId = body.userId?.trim();
    if (!targetUserId) {
      return NextResponse.json({ error: "userId requis" }, { status: 400 });
    }

    const role = await prisma.uERole.upsert({
      where: {
        userId_ueId: {
          userId: targetUserId,
          ueId: params.ueId,
        },
      },
      update: { role: "UE_MANAGER" },
      create: {
        userId: targetUserId,
        ueId: params.ueId,
        role: "UE_MANAGER",
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    return NextResponse.json({ role }, { status: 201 });
  } catch (error) {
    console.error("[UE Roles POST] Error:", error);
    return NextResponse.json(
      { error: "Impossible d'attribuer le rôle UE_MANAGER." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: { ueId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  if (user.globalRole !== "YEAR_ADMIN") {
    return NextResponse.json(
      { error: "Réservé au Responsable d'Année" },
      { status: 403 }
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const targetUserId = searchParams.get("userId");
    if (!targetUserId) {
      return NextResponse.json({ error: "userId requis" }, { status: 400 });
    }

    await prisma.uERole.deleteMany({
      where: {
        userId: targetUserId,
        ueId: params.ueId,
      },
    });

    return NextResponse.json({ revoked: true });
  } catch (error) {
    console.error("[UE Roles DELETE] Error:", error);
    return NextResponse.json(
      { error: "Impossible de révoquer le rôle UE_MANAGER." },
      { status: 500 }
    );
  }
}
