export const CLASS_LEVELS = [
  "PACENV",
  "VET2",
  "VET3",
  "VET4",
  "VET5",
  "VET6",
] as const;

export type ClassLevel = (typeof CLASS_LEVELS)[number];

export const CLASS_LEVEL_LABELS: Record<ClassLevel, string> = {
  PACENV: "PACENV · Année préparatoire",
  VET2: "VET2 · 2e année",
  VET3: "VET3 · 3e année",
  VET4: "VET4 · 4e année",
  VET5: "VET5 · 5e année",
  VET6: "VET6 · 6e année",
};

export const EXAM_TYPES = [
  "PARTIEL",
  "ORAL",
  "TP PRATIQUE",
  "CONTRÔLE",
] as const;

export function isValidClassLevel(val: unknown): val is ClassLevel {
  return (
    typeof val === "string" &&
    (CLASS_LEVELS as readonly string[]).includes(val.trim().toUpperCase())
  );
}

export function normalizeClassLevel(val: unknown): ClassLevel {
  if (typeof val === "string") {
    const upper = val.trim().toUpperCase();
    if ((CLASS_LEVELS as readonly string[]).includes(upper)) {
      return upper as ClassLevel;
    }
  }
  return "VET2";
}

export interface ExamBadgeInfo {
  typeLabel: string;
  dateLabel: string;
  daysRemaining: number | null;
  countdownLabel: string | null;
}

export function formatExamBadge(
  examType?: string | null,
  examDate?: string | null
): ExamBadgeInfo {
  const typeLabel = (examType?.trim() || "PARTIEL").toUpperCase();
  if (!examDate || !/^\d{4}-\d{2}-\d{2}$/.test(examDate.trim())) {
    return {
      typeLabel,
      dateLabel: "À DÉFINIR",
      daysRemaining: null,
      countdownLabel: null,
    };
  }

  const [y, m, d] = examDate.trim().split("-").map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round(
    (target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  );

  const dateLabel = target
    .toLocaleDateString("fr-FR", { day: "2-digit", month: "short" })
    .replace(".", "")
    .toUpperCase();

  let countdownLabel: string | null = null;
  if (diffDays === 0) {
    countdownLabel = "AUJOURD'HUI";
  } else if (diffDays > 0) {
    countdownLabel = `J-${diffDays}`;
  } else {
    countdownLabel = "PASSÉ";
  }

  return {
    typeLabel,
    dateLabel,
    daysRemaining: diffDays,
    countdownLabel,
  };
}
