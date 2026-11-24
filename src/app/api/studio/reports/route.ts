import { NextResponse } from "next/server";
import { canManageUE, getCurrentUser } from "@/lib/auth";
import {
  createContentIssueReport,
  getContentIssueReportById,
  listContentReports,
  updateContentIssueReportStatus,
  type ReportStatus,
} from "@/lib/content-reports";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const rawStatus = searchParams.get("status")?.toUpperCase();
  const status: ReportStatus | "ALL" =
    rawStatus === "OPEN" ||
    rawStatus === "RESOLVED" ||
    rawStatus === "DISMISSED"
      ? rawStatus
      : "ALL";

  if (user.globalRole === "YEAR_ADMIN") {
    const reports = await listContentReports({ status, limit: 60 });
    return NextResponse.json({ reports });
  }

  const managedUeIds = user.ueRoles.map((r) => r.ueId).filter(Boolean);
  if (managedUeIds.length === 0) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const reports = await listContentReports({
    status,
    ueIds: managedUeIds,
    limit: 60,
  });
  return NextResponse.json({ reports });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      ueId?: string | null;
      ueCode?: string;
      documentId?: string | null;
      artifactId?: string | null;
      targetKind?: string;
      itemLabel?: string;
      description?: string;
    };

    const description = body.description?.trim() || "";
    if (description.length < 4) {
      return NextResponse.json(
        { error: "Veuillez décrire l'erreur relevée (4 caractères min.)." },
        { status: 400 }
      );
    }

    let resolvedUeId = body.ueId?.trim() || null;
    if (!resolvedUeId && body.artifactId?.trim()) {
      const art = await prisma.studyArtifact
        .findUnique({
          where: { id: body.artifactId.trim() },
          select: { ueId: true },
        })
        .catch(() => null);
      if (art?.ueId) resolvedUeId = art.ueId;
    }

    const report = await createContentIssueReport({
      reporterId: user.id,
      reporterName: user.name,
      ueId: resolvedUeId,
      ueCode: body.ueCode,
      documentId: body.documentId,
      artifactId: body.artifactId,
      targetKind: body.targetKind || "SUMMARY",
      itemLabel: body.itemLabel || "Contenu IA",
      description,
    });

    return NextResponse.json({ report }, { status: 201 });
  } catch (error) {
    console.error("[Studio Reports POST] Error:", error);
    return NextResponse.json(
      { error: "Impossible d'enregistrer le signalement." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      id?: string;
      status?: "RESOLVED" | "DISMISSED";
      resolutionNote?: string;
    };

    const reportId = body.id?.trim() || "";
    const status = body.status;
    if (!reportId || (status !== "RESOLVED" && status !== "DISMISSED")) {
      return NextResponse.json(
        { error: "Identifiant et statut valide (RESOLVED/DISMISSED) requis." },
        { status: 400 }
      );
    }

    const existing = await getContentIssueReportById(reportId);
    if (!existing) {
      return NextResponse.json(
        { error: "Signalement introuvable." },
        { status: 404 }
      );
    }

    const allowed =
      user.globalRole === "YEAR_ADMIN" ||
      (existing.ueId
        ? await canManageUE(user.id, user.globalRole, existing.ueId)
        : false);

    if (!allowed) {
      return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
    }

    const report = await updateContentIssueReportStatus({
      id: reportId,
      status,
      resolvedBy: user.name,
      resolutionNote: body.resolutionNote,
    });

    return NextResponse.json({ report });
  } catch (error) {
    console.error("[Studio Reports PATCH] Error:", error);
    return NextResponse.json(
      { error: "Impossible de mettre à jour le signalement." },
      { status: 500 }
    );
  }
}
