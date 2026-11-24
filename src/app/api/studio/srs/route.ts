import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  getArtifactFlashcardReviews,
  getUserGlobalFlashcardSrsSummary,
  localSrsDateKey,
  recordFlashcardReview,
  type FlashcardSrsRating,
} from "@/lib/flashcard-srs";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const artifactId = searchParams.get("artifactId")?.trim();

  if (artifactId) {
    const [reviews, summary] = await Promise.all([
      getArtifactFlashcardReviews(user.id, artifactId),
      getUserGlobalFlashcardSrsSummary(user.id),
    ]);
    return NextResponse.json({
      reviews,
      summary,
      todayKey: localSrsDateKey(),
    });
  }

  const summary = await getUserGlobalFlashcardSrsSummary(user.id);
  return NextResponse.json({
    summary,
    todayKey: localSrsDateKey(),
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      artifactId?: string;
      cardKey?: string;
      front?: string;
      ueId?: string;
      ueCode?: string;
      documentId?: string;
      rating?: FlashcardSrsRating;
    };

    const artifactId = body.artifactId?.trim() || "";
    const front = body.front?.trim() || "";
    const rating = body.rating;

    if (
      !artifactId ||
      (!front && !body.cardKey?.trim()) ||
      (rating !== "AGAIN" &&
        rating !== "HARD" &&
        rating !== "GOOD" &&
        rating !== "EASY")
    ) {
      return NextResponse.json(
        { error: "Paramètres SRS invalides (artifactId, front, rating requis)." },
        { status: 400 }
      );
    }

    const review = await recordFlashcardReview({
      userId: user.id,
      artifactId,
      cardKey: body.cardKey,
      front,
      ueId: body.ueId,
      ueCode: body.ueCode,
      documentId: body.documentId,
      rating,
    });

    return NextResponse.json({
      review,
      todayKey: localSrsDateKey(),
    });
  } catch (error) {
    console.error("[Studio SRS POST] Error:", error);
    return NextResponse.json(
      { error: "Impossible d'enregistrer l'évaluation SRS." },
      { status: 500 }
    );
  }
}
