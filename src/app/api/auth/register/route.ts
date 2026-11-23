import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getSystemSettings, normalizeInviteCode } from "@/lib/system-settings";
import {
  ensureUserAccountSchema,
  isValidClassLevel,
  normalizeClassLevel,
} from "@/lib/user-schema";

export async function GET() {
  try {
    await ensureUserAccountSchema();
    const [userCount, settings] = await Promise.all([
      prisma.user.count(),
      getSystemSettings(),
    ]);
    return NextResponse.json({
      hasUsers: userCount > 0,
      userCount,
      inviteCodeEnabled: Boolean(
        settings.inviteCodeEnabled && settings.inviteCode.trim().length > 0
      ),
    });
  } catch (error) {
    console.error("[Register GET] Error:", error);
    return NextResponse.json(
      { hasUsers: false, userCount: 0, inviteCodeEnabled: false },
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
      inviteCode?: string;
    };

    const name = body.name?.trim() || "";
    const email = body.email?.trim().toLowerCase() || "";
    const password = body.password || "";
    const providedInviteCode = normalizeInviteCode(body.inviteCode);

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

    let hasValidInviteCode = false;
    if (providedInviteCode.length > 0) {
      const settings = await getSystemSettings();
      const expectedCode = normalizeInviteCode(settings.inviteCode);
      if (
        !settings.inviteCodeEnabled ||
        !expectedCode ||
        providedInviteCode !== expectedCode
      ) {
        return NextResponse.json(
          {
            error:
              "Code d'accès invalide ou inactif. Vérifiez le code saisi ou laissez ce champ vide pour demander une validation manuelle par l'administrateur.",
          },
          { status: 400 }
        );
      }
      hasValidInviteCode = true;
    }

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
      const approved = isFirstUser || hasValidInviteCode;

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
