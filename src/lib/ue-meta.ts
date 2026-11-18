import { prisma } from "@/lib/prisma";
import { normalizeClassLevel, type ClassLevel } from "@/lib/class-levels";

export interface UeMeta {
  classLevel: ClassLevel;
  examType: string;
  examDate: string | null;
  coeff: number;
}

let ueMetaSchemaEnsured = false;

/**
 * Ensures runtime columns classLevel, examType, examDate, coeff exist on "UE".
 * Strictly 1 SQL command per $executeRawUnsafe call (PostgreSQL 42601 rule).
 */
export async function ensureUeMetaSchema(): Promise<void> {
  if (ueMetaSchemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "UE" ADD COLUMN IF NOT EXISTS "classLevel" TEXT NOT NULL DEFAULT 'VET2';
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "UE" ADD COLUMN IF NOT EXISTS "examType" TEXT NOT NULL DEFAULT 'PARTIEL';
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "UE" ADD COLUMN IF NOT EXISTS "examDate" TEXT;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "UE" ADD COLUMN IF NOT EXISTS "coeff" INTEGER NOT NULL DEFAULT 4;
    `);
    ueMetaSchemaEnsured = true;
  } catch (err) {
    console.warn("[UEMeta] Schema check warning:", err);
  }
}

interface RawUeMetaRow {
  id: string;
  classLevel: string | null;
  examType: string | null;
  examDate: string | null;
  coeff: number | null;
}

function mapRow(row?: RawUeMetaRow): UeMeta {
  return {
    classLevel: normalizeClassLevel(row?.classLevel),
    examType: (row?.examType?.trim() || "PARTIEL").toUpperCase(),
    examDate: row?.examDate ? row.examDate.trim() : null,
    coeff:
      typeof row?.coeff === "number" && Number.isFinite(row.coeff)
        ? row.coeff
        : 4,
  };
}

export async function getAllUeMetaMap(): Promise<Map<string, UeMeta>> {
  await ensureUeMetaSchema();
  const rows = await prisma.$queryRaw<RawUeMetaRow[]>`
    SELECT "id", "classLevel", "examType", "examDate", "coeff"
    FROM "UE"
  `;
  const map = new Map<string, UeMeta>();
  for (const row of rows) {
    map.set(row.id, mapRow(row));
  }
  return map;
}

export async function getUeMeta(ueId: string): Promise<UeMeta> {
  await ensureUeMetaSchema();
  const rows = await prisma.$queryRaw<RawUeMetaRow[]>`
    SELECT "id", "classLevel", "examType", "examDate", "coeff"
    FROM "UE"
    WHERE "id" = ${ueId}
    LIMIT 1
  `;
  return mapRow(rows[0]);
}

export async function setUeMeta(
  ueId: string,
  patch: {
    classLevel?: ClassLevel;
    examType?: string;
    examDate?: string | null;
    coeff?: number;
  }
): Promise<void> {
  await ensureUeMetaSchema();

  if (patch.classLevel !== undefined) {
    const lvl = normalizeClassLevel(patch.classLevel);
    await prisma.$executeRaw`
      UPDATE "UE" SET "classLevel" = ${lvl} WHERE "id" = ${ueId}
    `;
  }
  if (patch.examType !== undefined) {
    const et = (patch.examType.trim() || "PARTIEL").toUpperCase();
    await prisma.$executeRaw`
      UPDATE "UE" SET "examType" = ${et} WHERE "id" = ${ueId}
    `;
  }
  if (patch.examDate !== undefined) {
    const ed = patch.examDate && /^\d{4}-\d{2}-\d{2}$/.test(patch.examDate.trim())
      ? patch.examDate.trim()
      : null;
    await prisma.$executeRaw`
      UPDATE "UE" SET "examDate" = ${ed} WHERE "id" = ${ueId}
    `;
  }
  if (patch.coeff !== undefined && Number.isFinite(patch.coeff)) {
    const c = Math.max(1, Math.min(30, Math.round(patch.coeff)));
    await prisma.$executeRaw`
      UPDATE "UE" SET "coeff" = ${c} WHERE "id" = ${ueId}
    `;
  }
}
