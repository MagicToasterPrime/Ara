import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  let general = await prisma.channel.findFirst({
    where: { type: "GENERAL" },
  });

  if (!general) {
    general = await prisma.channel.create({
      data: {
        name: "#général",
        type: "GENERAL",
      },
    });
  }

  const channels = await prisma.channel.findMany({
    orderBy: [{ type: "asc" }, { name: "asc" }],
    include: {
      ue: {
        select: { id: true, code: true, title: true, accentColor: true },
      },
      _count: {
        select: { messages: true },
      },
    },
  });

  return NextResponse.json({ channels });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as { name?: string };
    let name = body.name?.trim() || "";
    if (!name) {
      return NextResponse.json(
        { error: "Le nom du canal est requis." },
        { status: 400 }
      );
    }

    if (!name.startsWith("#")) {
      name = `#${name}`;
    }
    name = name.toLowerCase().replace(/\s+/g, "-");

    const existing = await prisma.channel.findUnique({ where: { name } });
    if (existing) {
      return NextResponse.json(
        { error: "Un canal avec ce nom existe déjà." },
        { status: 409 }
      );
    }

    const channel = await prisma.channel.create({
      data: {
        name,
        type: "GROUP",
      },
      include: {
        ue: {
          select: { id: true, code: true, title: true, accentColor: true },
        },
        _count: {
          select: { messages: true },
        },
      },
    });

    return NextResponse.json({ channel }, { status: 201 });
  } catch (error) {
    console.error("[Channels POST] Error:", error);
    return NextResponse.json(
      { error: "Impossible de créer le canal." },
      { status: 500 }
    );
  }
}
