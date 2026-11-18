import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import type { GlobalRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { type ClassLevel, getUserAccountMeta } from "@/lib/user-schema";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: {
    strategy: "jwt",
  },
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Mot de passe", type: "password" },
      },
      async authorize(credentials) {
        const email =
          typeof credentials?.email === "string"
            ? credentials.email.trim().toLowerCase()
            : "";
        const password =
          typeof credentials?.password === "string" ? credentials.password : "";

        if (!email || !password) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email },
        });

        if (!user) {
          return null;
        }

        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) {
          return null;
        }

        const meta = await getUserAccountMeta(user.id);
        if (!meta.isApproved && user.globalRole !== "YEAR_ADMIN") {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          globalRole: user.globalRole,
          classLevel: meta.classLevel,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.email = user.email;
        token.name = user.name;
        token.globalRole = user.globalRole;
        token.classLevel = user.classLevel;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
        session.user.email = (token.email as string) || "";
        session.user.name = (token.name as string) || "";
        session.user.globalRole =
          (token.globalRole as GlobalRole) || "STUDENT";
        session.user.classLevel = (token.classLevel as ClassLevel) || "VET2";
      }
      return session;
    },
  },
});

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  classLevel: ClassLevel;
  isApproved: boolean;
  ueRoles: Array<{ ueId: string; role: "UE_MANAGER" }>;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  if (!session?.user?.id) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      globalRole: true,
      ueRoles: {
        select: {
          ueId: true,
          role: true,
        },
      },
    },
  });

  if (!user) {
    return null;
  }

  const meta = await getUserAccountMeta(user.id);
  if (!meta.isApproved && user.globalRole !== "YEAR_ADMIN") {
    return null;
  }

  return {
    ...user,
    classLevel: meta.classLevel,
    isApproved: user.globalRole === "YEAR_ADMIN" ? true : meta.isApproved,
  };
}

export async function canManageUE(
  userId: string,
  globalRole: GlobalRole,
  ueId: string
): Promise<boolean> {
  if (globalRole === "YEAR_ADMIN") {
    return true;
  }

  const ueRole = await prisma.uERole.findUnique({
    where: {
      userId_ueId: {
        userId,
        ueId,
      },
    },
  });

  return Boolean(ueRole);
}
