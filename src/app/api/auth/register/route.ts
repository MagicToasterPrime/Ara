import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const userCount = await prisma.user.count();
    return NextResponse.json({
      hasUsers: userCount > 0,
      userCount,
    });
  } catch (error) {
    console.error("[Register GET] Error:", error);
    return NextResponse.json(
      { hasUsers: false, userCount: 0 },
      { status: 200 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      name?: string;
      email?: string;
      password?: string;
    };

    const name = body.name?.trim() || "";
    const email = body.email?.trim().toLowerCase() || "";
    const password = body.password || "";

    if (!name || !email || password.length < 6) {
      return NextResponse.json(
        {
          error:
            "Nom, email valide et mot de passe (6 caractères minimum) requis.",
        },
        { status: 400 }
      );
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: "Un compte existe déjà avec cette adresse email." },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const createdUser = await prisma.$transaction(async (tx) => {
      const existingCount = await tx.user.count();
      const globalRole = existingCount === 0 ? "YEAR_ADMIN" : "STUDENT";

      const user = await tx.user.create({
        data: {
          name,
          email,
          passwordHash,
          globalRole,
        },
        select: {
          id: true,
          name: true,
          email: true,
          globalRole: true,
          createdAt: true,
        },
      });

      return user;
    });

    return NextResponse.json({ user: createdUser }, { status: 201 });
  } catch (error) {
    console.error("[Register POST] Error:", error);
    return NextResponse.json(
      { error: "Impossible de créer le compte utilisateur." },
      { status: 500 }
    );
  }
}
