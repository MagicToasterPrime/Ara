import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import {
  ensureUserAccountSchema,
  isValidClassLevel,
  normalizeClassLevel,
} from "@/lib/user-schema";

export async function GET() {
  try {
    await ensureUserAccountSchema();
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
    await ensureUserAccountSchema();

    const body = (await req.json()) as {
      name?: string;
      email?: string;
      password?: string;
      classLevel?: string;
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

    if (!isValidClassLevel(body.classLevel)) {
      return NextResponse.json(
        {
          error:
            "Veuillez sélectionner votre classe (PACENV, VET2, VET3, VET4, VET5 ou VET6).",
        },
        { status: 400 }
      );
    }

    const classLevel = normalizeClassLevel(body.classLevel);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: "Un compte existe déjà avec cette adresse email." },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { user, isApproved } = await prisma.$transaction(async (tx) => {
      const existingCount = await tx.user.count();
      const isFirstUser = existingCount === 0;
      const globalRole = isFirstUser ? "YEAR_ADMIN" : "STUDENT";
      const approved = isFirstUser;

      const created = await tx.user.create({
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

      await tx.$executeRaw`
        UPDATE "User"
        SET "classLevel" = ${classLevel}, "isApproved" = ${approved}
        WHERE "id" = ${created.id}
      `;

      return { user: created, isApproved: approved };
    });

    return NextResponse.json(
      {
        user: {
          ...user,
          classLevel,
          isApproved,
        },
        requiresApproval: !isApproved,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[Register POST] Error:", error);
    return NextResponse.json(
      { error: "Impossible de créer le compte utilisateur." },
      { status: 500 }
    );
  }
}
