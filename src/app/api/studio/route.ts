import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { setDocumentProcessingStatus } from "@/lib/document-status";
import {
  ensureStudioSchema,
  findValidPublicArtifactId,
  gatherStudioSourceChunks,
  generateStudioArtifact,
  hasExistingPublicArtifact,
  hasUsableChunksText,
  isStalePublicArtifact,
  type PageImageInput,
  type StudioArtifactKind,
} from "@/lib/studio";
import { getSystemSettings } from "@/lib/system-settings";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureStudioSchema();

  const { searchParams } = new URL(req.url);
  const ueId = searchParams.get("ueId");
  const documentId = searchParams.get("documentId");

  const [rawArtifacts, publicRows, settings] = await Promise.all([
    prisma.studyArtifact.findMany({
      where: {
        ...(ueId ? { ueId } : {}),
        ...(documentId ? { documentId } : {}),
        OR: [{ userId: user.id }, { isPublic: true }],
      },
      orderBy: { createdAt: "desc" },
      take: 60,
      include: {
        user: { select: { id: true, name: true } },
        ue: { select: { id: true, code: true, title: true } },
      },
    }),
    prisma.studyArtifact.findMany({
      where: {
        ...(ueId ? { ueId } : {}),
        ...(documentId ? { documentId } : {}),
        documentId: { not: null },
        isPublic: true,
      },
      select: {
        documentId: true,
        kind: true,
        contentJson: true,
      },
    }),
    getSystemSettings(),
  ]);

  const artifacts = rawArtifacts.filter(
    (a) => !(a.isPublic && isStalePublicArtifact(a.kind, a.contentJson))
  );

  const publicCoverage = publicRows
    .filter(
      (r): r is { documentId: string; kind: string; contentJson: string } =>
        Boolean(r.documentId) && !isStalePublicArtifact(r.kind, r.contentJson)
    )
    .map((r) => ({ documentId: r.documentId, kind: r.kind }));

  return NextResponse.json({
    artifacts,
    publicCoverage,
    userAiAndSpixEnabled: settings.userAiAndSpixEnabled,
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const settings = await getSystemSettings();
  if (!settings.userAiAndSpixEnabled) {
    return NextResponse.json(
      {
        error:
          "La génération de contenu IA par les utilisateurs est temporairement désactivée par l'administration. Les contenus déjà générés restent consultables.",
        code: "USER_AI_DISABLED",
      },
      { status: 403 }
    );
  }

  await ensureStudioSchema();

  try {
    const body = (await req.json()) as {
      kind?: StudioArtifactKind;
      ueId?: string;
      documentIds?: string[];
      pageNumber?: number;
      title?: string;
      prompt?: string;
      isPublic?: boolean;
      replaceArtifactId?: string;
      pageImagesBase64?: PageImageInput[];
    };

    const replaceArtifactId = body.replaceArtifactId?.trim() || "";
    const existingToReplace = replaceArtifactId
      ? await prisma.studyArtifact.findUnique({
          where: { id: replaceArtifactId },
        })
      : null;

    if (replaceArtifactId) {
      if (!existingToReplace) {
        return NextResponse.json(
          { error: "Production à regénérer introuvable." },
          { status: 404 }
        );
      }
      if (
        existingToReplace.userId !== user.id &&
        user.globalRole !== "YEAR_ADMIN"
      ) {
        return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
      }
    }

    const validKinds: StudioArtifactKind[] = [
      "SVG_DIAGRAM",
      "FLASHCARDS",
      "QUIZ",
      "SUMMARY",
    ];
    const requestedKind = existingToReplace
      ? (existingToReplace.kind as StudioArtifactKind)
      : body.kind;
    const kind = validKinds.includes(requestedKind as StudioArtifactKind)
      ? (requestedKind as StudioArtifactKind)
      : "SUMMARY";

    const effectiveDocIds =
      Array.isArray(body.documentIds) && body.documentIds.length > 0
        ? body.documentIds
        : existingToReplace?.documentId
        ? [existingToReplace.documentId]
        : undefined;

    const effectiveUeId = body.ueId || existingToReplace?.ueId || undefined;
    const effectivePrompt =
      body.prompt !== undefined
        ? body.prompt
        : existingToReplace?.prompt || undefined;

    let primaryDocId: string | null =
      effectiveDocIds && effectiveDocIds.length > 0
        ? effectiveDocIds[0]
        : null;

    let alreadyHasPublic = false;
    if (effectiveDocIds && effectiveDocIds.length > 0 && !existingToReplace) {
      let uncoveredDocId: string | null = null;
      for (const docId of effectiveDocIds) {
        const hasPub = await hasExistingPublicArtifact(docId, kind);
        if (!hasPub) {
          uncoveredDocId = docId;
          break;
        }
      }
      if (uncoveredDocId) {
        primaryDocId = uncoveredDocId;
        alreadyHasPublic = false;
      } else {
        primaryDocId = effectiveDocIds[0];
        alreadyHasPublic = true;
      }
    }

    const chunks = await gatherStudioSourceChunks({
      ueId: effectiveUeId,
      documentIds: effectiveDocIds,
      pageNumber: body.pageNumber,
      prompt: effectivePrompt,
      fullDocument: true,
    });

    if (chunks.length === 0 || !hasUsableChunksText(chunks)) {
      if (effectiveDocIds && effectiveDocIds.length === 1) {
        console.error(
          `[Studio POST] Document ${effectiveDocIds[0]} sans texte exploitable : marquage en ERROR.`
        );
        await setDocumentProcessingStatus(
          effectiveDocIds[0],
          "ERROR",
          "PDF scanné ou sans texte exploitable (OCR requis)"
        ).catch(() => null);
      }
      return NextResponse.json(
        {
          error:
            "Aucun texte PDF exploitable pour cette sélection (PDF vide ou scanné sans couche texte).",
        },
        { status: 400 }
      );
    }

    if (!primaryDocId && chunks[0]?.documentId) {
      primaryDocId = chunks[0].documentId;
      if (!existingToReplace) {
        alreadyHasPublic = await hasExistingPublicArtifact(primaryDocId, kind);
      }
    }

    const autoPublishedFirst = existingToReplace
      ? false
      : Boolean(primaryDocId && !alreadyHasPublic);
    const resolvedIsPublic = existingToReplace
      ? Boolean(existingToReplace.isPublic || body.isPublic)
      : autoPublishedFirst
      ? true
      : Boolean(body.isPublic);

    const generated = await generateStudioArtifact({
      kind,
      chunks,
      title: body.title,
      prompt: effectivePrompt,
      isPublic: resolvedIsPublic,
      pageImagesBase64: body.pageImagesBase64,
    });

    const resolvedUeId = effectiveUeId || chunks[0]?.ueId || null;

    let staleUpdateId: string | null = null;
    if (!existingToReplace && resolvedIsPublic && primaryDocId) {
      const { staleId } = await findValidPublicArtifactId(primaryDocId, kind);
      if (staleId) {
        staleUpdateId = staleId;
      }
    }

    const updateTargetId = existingToReplace?.id || staleUpdateId;

    const artifact = updateTargetId
      ? await prisma.studyArtifact.update({
          where: { id: updateTargetId },
          data: {
            title: generated.title,
            prompt: effectivePrompt?.trim() || null,
            contentJson: JSON.stringify(generated.content),
            isPublic: resolvedIsPublic,
            createdAt: new Date(),
          },
          include: {
            user: { select: { id: true, name: true } },
            ue: { select: { id: true, code: true, title: true } },
          },
        })
      : await prisma.studyArtifact.create({
          data: {
            userId: user.id,
            ueId: resolvedUeId,
            documentId: primaryDocId,
            kind,
            title: generated.title,
            prompt: effectivePrompt?.trim() || null,
            contentJson: JSON.stringify(generated.content),
            isPublic: resolvedIsPublic,
          },
          include: {
            user: { select: { id: true, name: true } },
            ue: { select: { id: true, code: true, title: true } },
          },
        });

    return NextResponse.json(
      {
        artifact,
        autoPublishedFirst,
        usedAi: generated.usedAi,
        replaced: Boolean(existingToReplace),
      },
      { status: existingToReplace ? 200 : 201 }
    );
  } catch (error) {
    console.error("[Studio POST] Error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la génération Studio." },
      { status: 500 }
    );
  }
}
