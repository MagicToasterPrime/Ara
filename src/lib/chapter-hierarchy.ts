import { prisma } from "@/lib/prisma";

export interface ChapterHierarchyMeta {
  theme: string;
  parentId: string | null;
}

interface RawChapterHierarchyRow {
  id: string;
  theme: string | null;
  parentId: string | null;
}

let chapterHierarchySchemaEnsured = false;

/**
 * Ensures runtime columns "theme" and "parentId" exist on "Chapter".
 * Strictly 1 SQL command per $executeRawUnsafe call (PostgreSQL 42601 rule).
 */
export async function ensureChapterHierarchySchema(): Promise<void> {
  if (chapterHierarchySchemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Chapter" ADD COLUMN IF NOT EXISTS "theme" TEXT NOT NULL DEFAULT '';
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Chapter" ADD COLUMN IF NOT EXISTS "parentId" TEXT;
    `);
    chapterHierarchySchemaEnsured = true;
  } catch (err) {
    console.warn("[ChapterHierarchy] Schema check warning:", err);
  }
}

export async function getUeChapterHierarchyMap(
  ueId: string
): Promise<Map<string, ChapterHierarchyMeta>> {
  await ensureChapterHierarchySchema();
  const rows = await prisma.$queryRaw<RawChapterHierarchyRow[]>`
    SELECT "id", "theme", "parentId"
    FROM "Chapter"
    WHERE "ueId" = ${ueId}
  `;
  const map = new Map<string, ChapterHierarchyMeta>();
  for (const row of rows) {
    map.set(row.id, {
      theme: row.theme?.trim() || "",
      parentId: row.parentId ? row.parentId.trim() : null,
    });
  }
  return map;
}

export async function setChapterHierarchyMeta(
  chapterId: string,
  patch: {
    theme?: string;
    parentId?: string | null;
  }
): Promise<void> {
  await ensureChapterHierarchySchema();

  if (patch.theme !== undefined) {
    const cleanTheme = patch.theme.trim();
    await prisma.$executeRaw`
      UPDATE "Chapter" SET "theme" = ${cleanTheme} WHERE "id" = ${chapterId}
    `;
  }

  if (patch.parentId !== undefined) {
    const cleanParent =
      patch.parentId && patch.parentId.trim() && patch.parentId.trim() !== chapterId
        ? patch.parentId.trim()
        : null;
    await prisma.$executeRaw`
      UPDATE "Chapter" SET "parentId" = ${cleanParent} WHERE "id" = ${chapterId}
    `;
  }
}

export async function detachChildChapters(
  parentChapterId: string,
  ueId: string
): Promise<void> {
  await ensureChapterHierarchySchema();
  await prisma.$executeRaw`
    UPDATE "Chapter"
    SET "parentId" = NULL
    WHERE "parentId" = ${parentChapterId} AND "ueId" = ${ueId}
  `;
}

export function parseThemeAndTitle(
  rawTitle: string,
  rawTheme?: string
): { theme: string; title: string } {
  const trimmedTitle = rawTitle.trim();
  const explicitTheme = rawTheme?.trim() || "";

  if (explicitTheme.length > 0) {
    return { theme: explicitTheme, title: trimmedTitle };
  }

  const sepIdx = trimmedTitle.indexOf(" / ");
  if (sepIdx > 0) {
    const parsedTheme = trimmedTitle.slice(0, sepIdx).trim();
    const parsedTitle = trimmedTitle.slice(sepIdx + 3).trim();
    if (parsedTheme.length > 0 && parsedTitle.length > 0) {
      return { theme: parsedTheme, title: parsedTitle };
    }
  }

  return { theme: "", title: trimmedTitle };
}
