import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getBackupStatus, runManualBackup } from "@/lib/backup";

export const dynamic = "force-dynamic";

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

  return NextResponse.json(await getBackupStatus());
}

export async function POST() {
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
    const result = await runManualBackup();
    return NextResponse.json(result);
  } catch (error) {
    console.error("[System Backup POST] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Impossible de créer la sauvegarde.",
      },
      { status: 500 }
    );
  }
}
