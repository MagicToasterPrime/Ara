import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { resolveDocumentFilePath } from "@/lib/storage";

export async function GET(
  req: Request,
  { params }: { params: { documentId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const doc = await prisma.document.findUnique({
    where: { id: params.documentId },
  });

  if (!doc) {
    return NextResponse.json(
      { error: "Document introuvable." },
      { status: 404 }
    );
  }

  try {
    const filePath = resolveDocumentFilePath(doc.localPath);
    const stat = await fsp.stat(filePath);
    const totalSize = stat.size;

    const rangeHeader = req.headers.get("range");
    const encodedName = encodeURIComponent(doc.fileName);

    if (rangeHeader) {
      const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      if (match) {
        const start = Number.parseInt(match[1], 10);
        const end = match[2]
          ? Math.min(Number.parseInt(match[2], 10), totalSize - 1)
          : totalSize - 1;

        if (start >= totalSize || start > end) {
          return new NextResponse(null, {
            status: 416,
            headers: {
              "Content-Range": `bytes */${totalSize}`,
            },
          });
        }

        const chunkSize = end - start + 1;
        const handle = await fsp.open(filePath, "r");
        try {
          const buffer = Buffer.alloc(chunkSize);
          await handle.read(buffer, 0, chunkSize, start);
          return new NextResponse(new Uint8Array(buffer), {
            status: 206,
            headers: {
              "Content-Type": doc.mimeType || "application/pdf",
              "Content-Length": String(chunkSize),
              "Content-Range": `bytes ${start}-${end}/${totalSize}`,
              "Accept-Ranges": "bytes",
              "Content-Disposition": `inline; filename*=UTF-8''${encodedName}`,
              "Cache-Control": "private, no-store, no-cache, must-revalidate",
              "X-Robots-Tag":
                "noindex, nofollow, noarchive, nosnippet, noimageindex",
            },
          });
        } finally {
          await handle.close();
        }
      }
    }

    const fileBuffer = await fsp.readFile(filePath);
    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        "Content-Type": doc.mimeType || "application/pdf",
        "Content-Length": String(totalSize),
        "Accept-Ranges": "bytes",
        "Content-Disposition": `inline; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "private, no-store, no-cache, must-revalidate",
        "X-Robots-Tag":
          "noindex, nofollow, noarchive, nosnippet, noimageindex",
      },
    });
  } catch (error) {
    console.error("[Files GET] Error:", error);
    return NextResponse.json(
      { error: "Fichier introuvable sur le disque." },
      { status: 404 }
    );
  }
}
