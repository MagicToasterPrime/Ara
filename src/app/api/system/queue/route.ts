import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkOllamaHealth } from "@/lib/ollama";
import {
  getBackgroundQueueSnapshot,
  requestStopBackgroundQueue,
  runNightlyOffPeakStudyGeneration,
} from "@/lib/studio";

export async function GET() {
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

  const queue = await getBackgroundQueueSnapshot();
  return NextResponse.json({ queue });
}

export async function POST(req: Request) {
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
    const body = (await req.json()) as {
      action?: "START_ALL" | "START_INDEXING" | "START_AI" | "STOP";
      chapterId?: string;
      documentId?: string;
    };
    const action = body.action;
    const chapterId = body.chapterId?.trim() || undefined;
    const documentId = body.documentId?.trim() || undefined;

    if (action === "STOP") {
      requestStopBackgroundQueue();
      const queue = await getBackgroundQueueSnapshot();
      return NextResponse.json({ queue });
    }

    if (
      action === "START_ALL" ||
      action === "START_INDEXING" ||
      action === "START_AI"
    ) {
      const health = await checkOllamaHealth();
      if (!health.online) {
        return NextResponse.json(
          {
            error: "OLLAMA_OFFLINE",
            message: `Serveur Ollama hors-ligne (${health.host.replace(/^https?:\/\//, "")}). Démarrez Ollama avant de lancer la file.`,
          },
          { status: 503 }
        );
      }

      const scope =
        action === "START_INDEXING"
          ? "INDEXING_ONLY"
          : action === "START_AI"
          ? "AI_ONLY"
          : "ALL";

      void runNightlyOffPeakStudyGeneration({
        force: true,
        mode: "ADMIN_MANUAL",
        scope,
        chapterId,
        documentId,
      });

      // Short yield so the worker sets isRunning=true before returning the snapshot
      await new Promise((resolve) => setTimeout(resolve, 60));
      const queue = await getBackgroundQueueSnapshot();
      return NextResponse.json({ queue });
    }

    return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
  } catch (error) {
    console.error("[System Queue POST] Error:", error);
    return NextResponse.json(
      { error: "Erreur lors du pilotage de la file d'attente." },
      { status: 500 }
    );
  }
}
