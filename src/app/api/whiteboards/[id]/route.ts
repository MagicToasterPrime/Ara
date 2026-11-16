import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManageUE, getCurrentUser } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const whiteboard = await prisma.whiteboard.findUnique({
    where: { id: params.id },
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

  if (!whiteboard) {
    return NextResponse.json(
      { error: "Tableau blanc introuvable." },
      { status: 404 }
    );
  }

  const isCreator = whiteboard.creatorId === user.id;
  const isYearAdmin = user.globalRole === "YEAR_ADMIN";
  const canIntegrate = whiteboard.ueId
    ? await canManageUE(user.id, user.globalRole, whiteboard.ueId)
    : false;

  if (
    !whiteboard.isPublic &&
    !whiteboard.isIntegrated &&
    !isCreator &&
    !isYearAdmin
  ) {
    return NextResponse.json(
      { error: "Ce tableau blanc est privé." },
      { status: 403 }
    );
  }

  return NextResponse.json({
    whiteboard,
    canEditMeta: isCreator || isYearAdmin,
    canIntegrate,
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      title?: string;
      ueId?: string | null;
      isPublic?: boolean;
      isIntegrated?: boolean;
      snapshotData?: string;
    };

    const existing = await prisma.whiteboard.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        creatorId: true,
        ueId: true,
        isPublic: true,
        isIntegrated: true,
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Tableau blanc introuvable." },
        { status: 404 }
      );
    }

    const isCreator = existing.creatorId === user.id;
    const isYearAdmin = user.globalRole === "YEAR_ADMIN";
    const targetUeId =
      body.ueId !== undefined ? body.ueId?.trim() || null : existing.ueId;
    const isUeManager = targetUeId
      ? await canManageUE(user.id, user.globalRole, targetUeId)
      : false;

    const hasReadAccess =
      existing.isPublic || existing.isIntegrated || isCreator || isYearAdmin;
    if (!hasReadAccess) {
      return NextResponse.json(
        { error: "Accès refusé à ce tableau privé." },
        { status: 403 }
      );
    }

    // Metadata updates (title / ueId / isPublic) restricted to creator or YEAR_ADMIN
    if (
      (body.title !== undefined ||
        body.ueId !== undefined ||
        body.isPublic !== undefined) &&
      !isCreator &&
      !isYearAdmin
    ) {
      return NextResponse.json(
        {
          error:
            "Seul le créateur du tableau peut modifier sa visibilité ou ses métadonnées.",
        },
        { status: 403 }
      );
    }

    // Integration toggle restricted to UE_MANAGER of the whiteboard's UE or YEAR_ADMIN
    if (body.isIntegrated !== undefined && !isUeManager) {
      return NextResponse.json(
        {
          error:
            "Seul le responsable de l'UE peut intégrer ou retirer ce tableau de l'UE.",
        },
        { status: 403 }
      );
    }

    let nextIsPublic = existing.isPublic;
    let nextIsIntegrated = existing.isIntegrated;

    if (body.isPublic !== undefined) {
      nextIsPublic = Boolean(body.isPublic);
      if (!nextIsPublic) {
        nextIsIntegrated = false;
      }
    }

    if (body.isIntegrated !== undefined) {
      if (Boolean(body.isIntegrated) && !targetUeId) {
        return NextResponse.json(
          { error: "Ce tableau n'est rattaché à aucune UE." },
          { status: 400 }
        );
      }
      nextIsIntegrated = Boolean(body.isIntegrated);
      if (nextIsIntegrated) {
        nextIsPublic = true;
      }
    }

    if (body.ueId !== undefined && body.ueId !== existing.ueId && !body.isIntegrated) {
      nextIsIntegrated = false;
    }

    const updated = await prisma.whiteboard.update({
      where: { id: params.id },
      data: {
        ...(body.title?.trim() ? { title: body.title.trim() } : {}),
        ...(body.ueId !== undefined ? { ueId: targetUeId } : {}),
        ...(body.isPublic !== undefined || body.isIntegrated !== undefined
          ? { isPublic: nextIsPublic, isIntegrated: nextIsIntegrated }
          : {}),
        ...(typeof body.snapshotData === "string"
          ? { snapshotData: body.snapshotData }
          : {}),
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

    return NextResponse.json({ whiteboard: updated });
  } catch (error) {
    console.error("[Whiteboard PATCH] Error:", error);
    return NextResponse.json(
      { error: "Impossible de sauvegarder le tableau blanc." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const existing = await prisma.whiteboard.findUnique({
    where: { id: params.id },
    select: { id: true, creatorId: true },
  });

  if (!existing) {
    return NextResponse.json(
      { error: "Tableau blanc introuvable." },
      { status: 404 }
    );
  }

  if (existing.creatorId !== user.id && user.globalRole !== "YEAR_ADMIN") {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  await prisma.whiteboard.delete({ where: { id: params.id } });
  return NextResponse.json({ deleted: true });
}
