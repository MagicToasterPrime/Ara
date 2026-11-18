import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import {
  ensureStudioSchema,
  gatherStudioSourceChunks,
  generateStudioArtifact,
  hasExistingPublicArtifact,
  type PageImageInput,
  type StudioArtifactKind,
} from "@/lib/studio";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureStudioSchema();

  const { searchParams } = new URL(req.url);
  const ueId = searchParams.get("ueId");
  const documentId = searchParams.get("documentId");

  const [artifacts, publicRows] = await Promise.all([
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
      },
    }),
  ]);

  const publicCoverage = publicRows
    .filter((r): r is { documentId: string; kind: string } =>
      Boolean(r.documentId)
    )
    .map((r) => ({ documentId: r.documentId, kind: r.kind }));

  return NextResponse.json({ artifacts, publicCoverage });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
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
      pageImagesBase64?: PageImageInput[];
    };

    const validKinds: StudioArtifactKind[] = [
      "SVG_DIAGRAM",
      "FLASHCARDS",
      "QUIZ",
      "SUMMARY",
    ];
    const kind = validKinds.includes(body.kind as StudioArtifactKind)
      ? (body.kind as StudioArtifactKind)
      : "SUMMARY";

    let primaryDocId: string | null =
      Array.isArray(body.documentIds) && body.documentIds.length > 0
        ? body.documentIds[0]
        : null;

    let alreadyHasPublic = false;
    if (Array.isArray(body.documentIds) && body.documentIds.length > 0) {
      let uncoveredDocId: string | null = null;
      for (const docId of body.documentIds) {
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
        primaryDocId = body.documentIds[0];
        alreadyHasPublic = true;
      }
    }

    const preAutoPublishedFirst = Boolean(primaryDocId && !alreadyHasPublic);
    const preResolvedIsPublic = preAutoPublishedFirst
      ? true
      : Boolean(body.isPublic);

    const chunks = await gatherStudioSourceChunks({
      ueId: body.ueId,
      documentIds: body.documentIds,
      pageNumber: body.pageNumber,
      prompt: body.prompt,
      fullDocument: preResolvedIsPublic,
    });

    if (chunks.length === 0) {
      return NextResponse.json(
        {
          error:
            "Aucun extrait PDF disponible pour cette sélection. Déposez au moins un document PDF dans une UE.",
        },
        { status: 400 }
      );
    }

    if (!primaryDocId && chunks[0]?.documentId) {
      primaryDocId = chunks[0].documentId;
      alreadyHasPublic = await hasExistingPublicArtifact(primaryDocId, kind);
    }

    const autoPublishedFirst = Boolean(primaryDocId && !alreadyHasPublic);
    const resolvedIsPublic = autoPublishedFirst
      ? true
      : Boolean(body.isPublic);

    const generated = await generateStudioArtifact({
      kind,
      chunks,
      title: body.title,
      prompt: body.prompt,
      isPublic: resolvedIsPublic,
      pageImagesBase64: body.pageImagesBase64,
    });

    const resolvedUeId = body.ueId || chunks[0]?.ueId || null;

    const artifact = await prisma.studyArtifact.create({
      data: {
        userId: user.id,
        ueId: resolvedUeId,
        documentId: primaryDocId,
        kind,
        title: generated.title,
        prompt: body.prompt?.trim() || null,
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
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[Studio POST] Error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la génération Studio." },
      { status: 500 }
    );
  }
}
