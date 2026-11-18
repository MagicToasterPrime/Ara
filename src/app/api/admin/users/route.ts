import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import {
  ensureUserAccountSchema,
  isValidClassLevel,
  normalizeClassLevel,
  setUserAccountMeta,
} from "@/lib/user-schema";

export async function PATCH(req: Request) {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  if (admin.globalRole !== "YEAR_ADMIN") {
    return NextResponse.json({ error: "Accès réservé YEAR_ADMIN" }, { status: 403 });
  }

  await ensureUserAccountSchema();

  try {
    const body = (await req.json()) as {
      userId?: string;
      isApproved?: boolean;
      classLevel?: string;
      globalRole?: "STUDENT" | "YEAR_ADMIN";
    };

    const userId = body.userId?.trim();
    if (!userId) {
      return NextResponse.json({ error: "userId requis" }, { status: 400 });
    }

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, globalRole: true },
    });
    if (!target) {
      return NextResponse.json(
        { error: "Utilisateur introuvable" },
        { status: 404 }
      );
    }

    if (userId === admin.id) {
      if (body.isApproved === false) {
        return NextResponse.json(
          { error: "Impossible de suspendre votre propre compte." },
          { status: 400 }
        );
      }
      if (body.globalRole === "STUDENT") {
        return NextResponse.json(
          { error: "Impossible de rétrograder votre propre compte YEAR_ADMIN." },
          { status: 400 }
        );
      }
    }

    let nextClassLevel = undefined;
    if (body.classLevel !== undefined) {
      if (!isValidClassLevel(body.classLevel)) {
        return NextResponse.json(
          { error: "Classe invalide (PACENV ou VET2 à VET6)." },
          { status: 400 }
        );
      }
      nextClassLevel = normalizeClassLevel(body.classLevel);
    }

    if (body.isApproved !== undefined || nextClassLevel !== undefined) {
      await setUserAccountMeta(userId, {
        ...(nextClassLevel !== undefined ? { classLevel: nextClassLevel } : {}),
        ...(body.isApproved !== undefined
          ? { isApproved: Boolean(body.isApproved) }
          : {}),
      });
    }

    if (
      body.globalRole === "STUDENT" ||
      body.globalRole === "YEAR_ADMIN"
    ) {
      await prisma.user.update({
        where: { id: userId },
        data: { globalRole: body.globalRole },
      });
      if (body.globalRole === "YEAR_ADMIN") {
        await setUserAccountMeta(userId, { isApproved: true });
      }
    }

    return NextResponse.json({ updated: true });
  } catch (error) {
    console.error("[Admin Users PATCH] Error:", error);
    return NextResponse.json(
      { error: "Impossible de mettre à jour le compte utilisateur." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const admin = await getCurrentUser();
  if (!admin) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  if (admin.globalRole !== "YEAR_ADMIN") {
    return NextResponse.json({ error: "Accès réservé YEAR_ADMIN" }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(req.url);
    let userId = searchParams.get("userId")?.trim() || "";
    if (!userId) {
      const body = (await req.json().catch(() => ({}))) as { userId?: string };
      userId = body.userId?.trim() || "";
    }

    if (!userId) {
      return NextResponse.json({ error: "userId requis" }, { status: 400 });
    }

    if (userId === admin.id) {
      return NextResponse.json(
        { error: "Impossible de supprimer votre propre compte." },
        { status: 400 }
      );
    }

    await prisma.user.delete({ where: { id: userId } });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("[Admin Users DELETE] Error:", error);
    return NextResponse.json(
      { error: "Impossible de supprimer le compte utilisateur." },
      { status: 500 }
    );
  }
}
