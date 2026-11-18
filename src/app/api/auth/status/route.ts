import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { ensureUserAccountSchema, getUserAccountMeta } from "@/lib/user-schema";

export async function POST(req: Request) {
  try {
    await ensureUserAccountSchema();
    const body = (await req.json()) as {
      email?: string;
      password?: string;
    };

    const email = body.email?.trim().toLowerCase() || "";
    const password = body.password || "";

    if (!email || !password) {
      return NextResponse.json({ status: "INVALID" }, { status: 200 });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        passwordHash: true,
        globalRole: true,
      },
    });

    if (!user) {
      return NextResponse.json({ status: "INVALID" }, { status: 200 });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return NextResponse.json({ status: "INVALID" }, { status: 200 });
    }

    const meta = await getUserAccountMeta(user.id);
    if (!meta.isApproved && user.globalRole !== "YEAR_ADMIN") {
      return NextResponse.json(
        {
          status: "PENDING_APPROVAL",
          classLevel: meta.classLevel,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { status: "OK", classLevel: meta.classLevel },
      { status: 200 }
    );
  } catch (error) {
    console.error("[Auth Status POST] Error:", error);
    return NextResponse.json({ status: "ERROR" }, { status: 200 });
  }
}
