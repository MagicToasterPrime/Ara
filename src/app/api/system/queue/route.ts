import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkOllamaHealth } from "@/lib/ollama";
import {
  getSharedDailyQuizMetaForToday,
  runScheduled6AmDailyQuizGeneration,
} from "@/lib/revisions";
import {
  getBackgroundQueueSnapshot,
  requestStopBackgroundQueue,
  requestStopContinuous24hIfOutsideOffPeak,
  runNightlyOffPeakStudyGeneration,
} from "@/lib/studio";
import {
  getSystemSettings,
  updateSystemSettings,
} from "@/lib/system-settings";

async function buildAdminQueueResponse(notice?: string) {
  const [queue, dailyQuiz] = await Promise.all([
    getBackgroundQueueSnapshot(),
    getSharedDailyQuizMetaForToday(),
  ]);
  return {
    queue,
    settings: queue.settings,
    dailyQuiz,
    ...(notice ? { notice } : {}),
  };
}

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

  return NextResponse.json(await buildAdminQueueResponse());
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
      action?:
        | "START_ALL"
        | "START_INDEXING"
        | "START_AI"
        | "STOP"
        | "TOGGLE_24H"
        | "TOGGLE_DAILY_QUIZ"
        | "REGENERATE_DAILY_QUIZ";
      enabled?: boolean;
      chapterId?: string;
      documentId?: string;
    };
    const action = body.action;
    const chapterId = body.chapterId?.trim() || undefined;
    const documentId = body.documentId?.trim() || undefined;

    if (action === "TOGGLE_24H") {
      const enabled = Boolean(body.enabled);
      await updateSystemSettings({ continuousGeneration24h: enabled });

      let notice: string | undefined;
      if (enabled) {
        const health = await checkOllamaHealth();
        if (health.online) {
          void runNightlyOffPeakStudyGeneration({
            mode: "CONTINUOUS_24H",
          });
          await new Promise((resolve) => setTimeout(resolve, 80));
          notice =
            "Mode génération continue 24h/24 activé. La file d'indexation et de contenus IA tourne en continu.";
        } else {
          notice = `Mode 24h/24 enregistré, mais Ollama est hors-ligne (${health.host.replace(/^https?:\/\//, "")}). La génération démarrera dès qu'Ollama sera disponible.`;
        }
      } else {
        requestStopContinuous24hIfOutsideOffPeak();
        notice =
          "Mode 24h/24 désactivé. Retour automatique à la fenêtre heures creuses (00h00–07h00).";
      }

      return NextResponse.json(await buildAdminQueueResponse(notice));
    }

    if (action === "TOGGLE_DAILY_QUIZ") {
      const enabled = Boolean(body.enabled);
      await updateSystemSettings({ dailyQuizEnabled: enabled });

      const notice = enabled
        ? "Quiz journalier activé pour toute la promotion (génération automatique à 06h00 et au premier accès)."
        : "Quiz journalier désactivé : la génération automatique de 06h00 est mise en pause et la bannière est masquée sur l'accueil.";

      return NextResponse.json(await buildAdminQueueResponse(notice));
    }

    if (action === "REGENERATE_DAILY_QUIZ") {
      const settings = await getSystemSettings();
      if (!settings.dailyQuizEnabled) {
        return NextResponse.json(
          {
            error: "DAILY_QUIZ_DISABLED",
            message:
              "Activez d'abord le Quiz journalier avant de lancer sa génération.",
          },
          { status: 400 }
        );
      }

      const health = await checkOllamaHealth();
      if (!health.online) {
        return NextResponse.json(
          {
            error: "OLLAMA_OFFLINE",
            message: `Serveur Ollama hors-ligne (${health.host.replace(/^https?:\/\//, "")}).`,
          },
          { status: 503 }
        );
      }

      void runScheduled6AmDailyQuizGeneration({ force: true }).catch((err) => {
        console.error("[Admin DailyQuiz Regen] Error:", err);
      });

      return NextResponse.json(
        await buildAdminQueueResponse(
          "Génération d'un nouveau quiz journalier lancée en arrière-plan (20 questions · 5 chapitres aléatoires)."
        )
      );
    }

    if (action === "STOP") {
      requestStopBackgroundQueue();
      return NextResponse.json(await buildAdminQueueResponse());
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
      return NextResponse.json(await buildAdminQueueResponse());
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
