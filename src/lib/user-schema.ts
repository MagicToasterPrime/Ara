import { prisma } from "@/lib/prisma";
import {
  normalizeClassLevel,
  type ClassLevel,
} from "@/lib/class-levels";

export {
  CLASS_LEVELS,
  CLASS_LEVEL_LABELS,
  isValidClassLevel,
  normalizeClassLevel,
  type ClassLevel,
} from "@/lib/class-levels";

export interface UserAccountMeta {
  classLevel: ClassLevel;
  isApproved: boolean;
}

let userSchemaEnsured = false;

/**
 * Ensures runtime columns classLevel & isApproved exist on "User" even if
 * migrations have not been manually re-run on an existing dev database.
 * Strictly 1 SQL statement per $executeRawUnsafe call (PostgreSQL 42601 rule).
 */
export async function ensureUserAccountSchema(): Promise<void> {
  if (userSchemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "classLevel" TEXT NOT NULL DEFAULT 'VET2';
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isApproved" BOOLEAN NOT NULL DEFAULT true;
    `);
    userSchemaEnsured = true;
  } catch (err) {
    console.warn("[UserSchema] Schema check warning:", err);
  }
}

interface RawUserMetaRow {
  id: string;
  classLevel: string | null;
  isApproved: boolean | null;
}

export async function getUserAccountMeta(
  userId: string
): Promise<UserAccountMeta> {
  await ensureUserAccountSchema();
  const rows = await prisma.$queryRaw<RawUserMetaRow[]>`
    SELECT "id", "classLevel", "isApproved"
    FROM "User"
    WHERE "id" = ${userId}
    LIMIT 1
  `;
  const row = rows[0];
  return {
    classLevel: normalizeClassLevel(row?.classLevel),
    isApproved: row?.isApproved ?? true,
  };
}

export async function getAllUsersAccountMeta(): Promise<
  Map<string, UserAccountMeta>
> {
  await ensureUserAccountSchema();
  const rows = await prisma.$queryRaw<RawUserMetaRow[]>`
    SELECT "id", "classLevel", "isApproved"
    FROM "User"
  `;
  const map = new Map<string, UserAccountMeta>();
  for (const row of rows) {
    map.set(row.id, {
      classLevel: normalizeClassLevel(row.classLevel),
      isApproved: row.isApproved ?? true,
    });
  }
  return map;
}

export async function setUserAccountMeta(
  userId: string,
  patch: { classLevel?: ClassLevel; isApproved?: boolean }
): Promise<void> {
  await ensureUserAccountSchema();
  if (patch.classLevel !== undefined) {
    await prisma.$executeRaw`
      UPDATE "User"
      SET "classLevel" = ${patch.classLevel}
      WHERE "id" = ${userId}
    `;
  }
  if (patch.isApproved !== undefined) {
    await prisma.$executeRaw`
      UPDATE "User"
      SET "isApproved" = ${patch.isApproved}
      WHERE "id" = ${userId}
    `;
  }
}
