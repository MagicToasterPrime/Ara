import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { checkOllamaHealth, indexDocumentPages } from "@/lib/ollama";
import { extractPdfPages } from "@/lib/pdf";
import { resolveDocumentFilePath } from "@/lib/storage";

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

  const health = await checkOllamaHealth();
  if (!health.online) {
    return NextResponse.json(
      {
        error: "OLLAMA_OFFLINE",
        message: `Serveur Ollama hors-ligne (${health.host.replace(/^https?:\/\//, "")})`,
      },
      { status: 503 }
    );
  }

  const documents = await prisma.document.findMany({
    select: {
      id: true,
      localPath: true,
    },
  });

  let indexedCount = 0;
  let failedCount = 0;

  for (const doc of documents) {
    try {
      const resolvedPath = resolveDocumentFilePath(doc.localPath);
      const buffer = await fsp.readFile(resolvedPath);
      const extracted = await extractPdfPages(buffer);

      await prisma.document.update({
        where: { id: doc.id },
        data: { pageCount: extracted.pageCount },
      });

      const result = await indexDocumentPages(doc.id, extracted.pages);
      if (result.indexed) {
        indexedCount += 1;
      } else {
        failedCount += 1;
      }
    } catch (err) {
      console.error(`[Reindex] Failed for doc ${doc.id}:`, err);
      failedCount += 1;
    }
  }

  return NextResponse.json({
    totalCount: documents.length,
    indexedCount,
    failedCount,
    ollamaOnline: true,
  });
}
