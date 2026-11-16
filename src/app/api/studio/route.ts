import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import {
  ensureStudioSchema,
  gatherStudioSourceChunks,
  generateStudioArtifact,
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

  const artifacts = await prisma.studyArtifact.findMany({
    where: {
      ...(ueId ? { ueId } : {}),
      ...(documentId ? { documentId } : {}),
      OR: [{ userId: user.id }, { isPublic: true }],
    },
    orderBy: { createdAt: "desc" },
    take: 40,
    include: {
      user: { select: { id: true, name: true } },
      ue: { select: { id: true, code: true, title: true } },
    },
  });

  return NextResponse.json({ artifacts });
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

    const chunks = await gatherStudioSourceChunks({
      ueId: body.ueId,
      documentIds: body.documentIds,
      pageNumber: body.pageNumber,
      prompt: body.prompt,
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

    const generated = await generateStudioArtifact({
      kind,
      chunks,
      title: body.title,
      prompt: body.prompt,
      pageImagesBase64: body.pageImagesBase64,
    });

    const primaryDocId =
      body.documentIds?.length === 1
        ? body.documentIds[0]
        : chunks[0]?.documentId || null;

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
        isPublic: Boolean(body.isPublic),
      },
      include: {
        user: { select: { id: true, name: true } },
        ue: { select: { id: true, code: true, title: true } },
      },
    });

    return NextResponse.json({ artifact }, { status: 201 });
  } catch (error) {
    console.error("[Studio POST] Error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la génération Studio." },
      { status: 500 }
    );
  }
}
