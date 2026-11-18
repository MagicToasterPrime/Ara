import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { normalizeClassLevel } from "@/lib/class-levels";
import { getAllUeMetaMap, setUeMeta } from "@/lib/ue-meta";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const [ues, metaMap] = await Promise.all([
    prisma.uE.findMany({
      orderBy: [{ order: "asc" }, { code: "asc" }],
      include: {
        roles: {
          include: {
            user: {
              select: { id: true, name: true, email: true },
            },
          },
        },
        chapters: {
          orderBy: { order: "asc" },
          include: {
            documents: {
              select: {
                id: true,
                category: true,
                isPinned: true,
                isIndexed: true,
                createdAt: true,
              },
            },
          },
        },
        channels: {
          select: { id: true, name: true, type: true },
        },
        whiteboards: {
          where: {
            OR: [
              { isIntegrated: true },
              { isPublic: true },
              { creatorId: user.id },
            ],
          },
          select: {
            id: true,
            title: true,
            isIntegrated: true,
            isPublic: true,
            updatedAt: true,
          },
        },
      },
    }),
    getAllUeMetaMap(),
  ]);

  const payload = ues.map((ue) => {
    const allDocs = ue.chapters.flatMap((c) => c.documents);
    const officialCount = allDocs.filter(
      (d) => d.category === "OFFICIAL_COURSE"
    ).length;
    const noteCount = allDocs.filter(
      (d) => d.category === "STUDENT_NOTE"
    ).length;
    const pinnedNoteCount = allDocs.filter(
      (d) => d.category === "STUDENT_NOTE" && d.isPinned
    ).length;
    const meta = metaMap.get(ue.id);

    return {
      id: ue.id,
      code: ue.code,
      title: ue.title,
      description: ue.description,
      semester: ue.semester,
      classLevel: meta?.classLevel ?? "VET2",
      examType: meta?.examType ?? "PARTIEL",
      examDate: meta?.examDate ?? null,
      coeff: meta?.coeff ?? 4,
      accentColor: ue.accentColor,
      order: ue.order,
      updatedAt: ue.updatedAt,
      roles: ue.roles,
      chapterCount: ue.chapters.length,
      officialCount,
      noteCount,
      pinnedNoteCount,
      channels: ue.channels,
      whiteboards: ue.whiteboards,
    };
  });

  return NextResponse.json({ ues: payload });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  if (user.globalRole !== "YEAR_ADMIN") {
    return NextResponse.json(
      { error: "Réservé au Responsable d'Année (YEAR_ADMIN)" },
      { status: 403 }
    );
  }

  try {
    const body = (await req.json()) as {
      code?: string;
      title?: string;
      description?: string;
      semester?: string;
      classLevel?: string;
      examType?: string;
      examDate?: string | null;
      coeff?: number;
      accentColor?: string;
      order?: number;
    };

    const code = body.code?.trim().toUpperCase() || "";
    const title = body.title?.trim() || "";
    const description = body.description?.trim() || "";
    const semester = body.semester?.trim().toUpperCase() || "S1";
    const classLevel = normalizeClassLevel(body.classLevel);
    const examType = (body.examType?.trim() || "PARTIEL").toUpperCase();
    const examDate = body.examDate?.trim() || null;
    const coeff = Number.isFinite(body.coeff) ? Number(body.coeff) : 4;
    const accentColor = body.accentColor?.trim() || "#D99B26";
    const order = Number.isFinite(body.order) ? Number(body.order) : 0;

    if (!code || !title) {
      return NextResponse.json(
        { error: "Le code et le titre de l'UE sont requis." },
        { status: 400 }
      );
    }

    const existing = await prisma.uE.findUnique({ where: { code } });
    if (existing) {
      return NextResponse.json(
        { error: `Une UE avec le code ${code} existe déjà.` },
        { status: 409 }
      );
    }

    const slug = code.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const channelName = `#ue-${slug}`;

    const ue = await prisma.$transaction(async (tx) => {
      const created = await tx.uE.create({
        data: {
          code,
          title,
          description,
          semester,
          accentColor,
          order,
        },
      });

      await tx.chapter.create({
        data: {
          ueId: created.id,
          title: "Chapitre 1 — Introduction",
          order: 1,
        },
      });

      const existingChannel = await tx.channel.findUnique({
        where: { name: channelName },
      });

      await tx.channel.create({
        data: {
          name: existingChannel ? `${channelName}-${created.id.slice(-4)}` : channelName,
          type: "UE_CHANNEL",
          ueId: created.id,
        },
      });

      return created;
    });

    await setUeMeta(ue.id, {
      classLevel,
      examType,
      examDate,
      coeff,
    });

    return NextResponse.json(
      {
        ue: {
          ...ue,
          classLevel,
          examType,
          examDate,
          coeff,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[UEs POST] Error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la création de l'UE." },
      { status: 500 }
    );
  }
}
