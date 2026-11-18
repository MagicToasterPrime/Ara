import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  getUserPdfAnnotations,
  upsertUserPdfAnnotation,
  type PdfHighlightRect,
} from "@/lib/pdf-annotations";

export async function GET(
  _req: Request,
  { params }: { params: { documentId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const annotations = await getUserPdfAnnotations(user.id, params.documentId);
    return NextResponse.json({ annotations });
  } catch (error) {
    console.error("[PDF Annotations GET] Error:", error);
    return NextResponse.json(
      { error: "Impossible de charger les annotations." },
      { status: 500 }
    );
  }
}

export async function POST(
  req: Request,
  { params }: { params: { documentId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      pageNumber?: number;
      isBookmarked?: boolean;
      noteText?: string;
      highlights?: PdfHighlightRect[];
    };

    const pageNumber = Number(body.pageNumber);
    if (!Number.isFinite(pageNumber) || pageNumber < 1) {
      return NextResponse.json(
        { error: "Numéro de page invalide." },
        { status: 400 }
      );
    }

    await upsertUserPdfAnnotation({
      userId: user.id,
      documentId: params.documentId,
      pageNumber: Math.floor(pageNumber),
      isBookmarked: Boolean(body.isBookmarked),
      noteText: typeof body.noteText === "string" ? body.noteText : "",
      highlights: Array.isArray(body.highlights) ? body.highlights : [],
    });

    const annotations = await getUserPdfAnnotations(user.id, params.documentId);
    return NextResponse.json({ annotations });
  } catch (error) {
    console.error("[PDF Annotations POST] Error:", error);
    return NextResponse.json(
      { error: "Impossible d'enregistrer l'annotation." },
      { status: 500 }
    );
  }
}
