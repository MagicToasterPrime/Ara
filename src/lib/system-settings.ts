import { prisma } from "@/lib/prisma";

export interface SystemSettings {
  continuousGeneration24h: boolean;
  dailyQuizEnabled: boolean;
}

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  continuousGeneration24h: false,
  dailyQuizEnabled: true,
};

const SETTING_KEYS = {
  continuousGeneration24h: "continuousGeneration24h",
  dailyQuizEnabled: "dailyQuizEnabled",
} as const;

const globalForSettings = globalThis as typeof globalThis & {
  __araSystemSettingsSchemaEnsured?: boolean;
  __araSystemSettingsCache?: SystemSettings;
};

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const norm = raw.trim().toLowerCase();
  if (norm === "true" || norm === "1" || norm === "yes" || norm === "on") {
    return true;
  }
  if (norm === "false" || norm === "0" || norm === "no" || norm === "off") {
    return false;
  }
  return fallback;
}

export async function ensureSystemSettingsSchema(): Promise<void> {
  if (globalForSettings.__araSystemSettingsSchemaEnsured) return;
  try {
    const check = await prisma.$queryRaw<Array<{ reg: string | null }>>`
      SELECT to_regclass('"SystemSetting"')::text AS reg
    `;
    if (check[0]?.reg) {
      globalForSettings.__araSystemSettingsSchemaEnsured = true;
      return;
    }

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "SystemSetting" (
        "key" TEXT NOT NULL,
        "value" TEXT NOT NULL,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
      );
    `);
    globalForSettings.__araSystemSettingsSchemaEnsured = true;
  } catch (err) {
    console.warn("[SystemSettings] Schema check warning:", err);
  }
}

export function getCachedSystemSettings(): SystemSettings {
  return globalForSettings.__araSystemSettingsCache || DEFAULT_SYSTEM_SETTINGS;
}

export function isContinuous24hModeCached(): boolean {
  return getCachedSystemSettings().continuousGeneration24h;
}

export async function getSystemSettings(): Promise<SystemSettings> {
  await ensureSystemSettingsSchema();
  try {
    const rows = await prisma.$queryRaw<Array<{ key: string; value: string }>>`
      SELECT "key", "value" FROM "SystemSetting"
      WHERE "key" IN (${SETTING_KEYS.continuousGeneration24h}, ${SETTING_KEYS.dailyQuizEnabled})
    `;
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.key, row.value);
    }
    const settings: SystemSettings = {
      continuousGeneration24h: parseBool(
        map.get(SETTING_KEYS.continuousGeneration24h),
        DEFAULT_SYSTEM_SETTINGS.continuousGeneration24h
      ),
      dailyQuizEnabled: parseBool(
        map.get(SETTING_KEYS.dailyQuizEnabled),
        DEFAULT_SYSTEM_SETTINGS.dailyQuizEnabled
      ),
    };
    globalForSettings.__araSystemSettingsCache = settings;
    return settings;
  } catch (err) {
    console.warn("[SystemSettings] Read warning:", err);
    return getCachedSystemSettings();
  }
}

export async function updateSystemSettings(
  patch: Partial<SystemSettings>
): Promise<SystemSettings> {
  await ensureSystemSettingsSchema();

  const entries: Array<[string, string]> = [];
  if (typeof patch.continuousGeneration24h === "boolean") {
    entries.push([
      SETTING_KEYS.continuousGeneration24h,
      patch.continuousGeneration24h ? "true" : "false",
    ]);
  }
  if (typeof patch.dailyQuizEnabled === "boolean") {
    entries.push([
      SETTING_KEYS.dailyQuizEnabled,
      patch.dailyQuizEnabled ? "true" : "false",
    ]);
  }

  for (const [key, value] of entries) {
    await prisma.$executeRaw`
      INSERT INTO "SystemSetting" ("key", "value", "updatedAt")
      VALUES (${key}, ${value}, NOW())
      ON CONFLICT ("key") DO UPDATE SET
        "value" = EXCLUDED."value",
        "updatedAt" = NOW()
    `;
  }

  return getSystemSettings();
}
