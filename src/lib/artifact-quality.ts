export type AiDensityStatus = "DENSE" | "MOYEN" | "MAIGRE" | "MANQUANT";

export interface DocumentAiQualityRow {
  documentId: string;
  title: string;
  fileName: string;
  pageCount: number;
  ueId: string;
  ueCode: string;
  ueTitle: string;
  chapterTitle: string;
  isIndexed: boolean;
  processingStatus: string;
  summaryArtifactId: string | null;
  summaryPipeline: string | null;
  summaryChapters: number;
  summaryWords: number;
  summaryBullets: number;
  summaryConcepts: number;
  flashcardsCount: number;
  quizQuestionsCount: number;
  densityStatus: AiDensityStatus;
}

interface SummaryShape {
  pipeline?: string;
  sections?: Array<{
    content?: string;
    keyPoints?: string[];
    subsections?: Array<{
      intro?: string;
      callouts?: Array<{ title?: string; text?: string; items?: string[] }>;
      bullets?: Array<{ lead?: string; text?: string; subItems?: string[] }>;
      table?: { headers?: string[]; rows?: string[][] } | null;
    }>;
  }>;
  keyConcepts?: unknown[];
  examPitfalls?: string[];
}

function countWordsSimple(text: string | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function computeDocumentAiQuality(input: {
  documentId: string;
  title: string;
  fileName: string;
  pageCount: number;
  ueId: string;
  ueCode: string;
  ueTitle: string;
  chapterTitle: string;
  isIndexed: boolean;
  processingStatus: string;
  summaryArtifact?: { id: string; contentJson: string } | null;
  flashcardsArtifact?: { id: string; contentJson: string } | null;
  quizArtifact?: { id: string; contentJson: string } | null;
}): DocumentAiQualityRow {
  let summaryPipeline: string | null = null;
  let summaryChapters = 0;
  let summaryWords = 0;
  let summaryBullets = 0;
  let summaryConcepts = 0;
  let flashcardsCount = 0;
  let quizQuestionsCount = 0;

  if (input.summaryArtifact?.contentJson) {
    try {
      const parsed = JSON.parse(input.summaryArtifact.contentJson) as SummaryShape;
      summaryPipeline = parsed.pipeline || null;
      const secs = Array.isArray(parsed.sections) ? parsed.sections : [];
      summaryChapters = secs.length;
      summaryConcepts = Array.isArray(parsed.keyConcepts)
        ? parsed.keyConcepts.length
        : 0;

      for (const sec of secs) {
        summaryWords += countWordsSimple(sec.content);
        if (Array.isArray(sec.keyPoints)) {
          for (const kp of sec.keyPoints) {
            summaryWords += countWordsSimple(kp);
          }
        }
        const subs = Array.isArray(sec.subsections) ? sec.subsections : [];
        for (const sub of subs) {
          summaryWords += countWordsSimple(sub.intro);
          for (const co of sub.callouts || []) {
            summaryWords +=
              countWordsSimple(co.title) + countWordsSimple(co.text);
            for (const it of co.items || []) {
              summaryWords += countWordsSimple(it);
            }
          }
          for (const b of sub.bullets || []) {
            summaryBullets += 1;
            summaryWords +=
              countWordsSimple(b.lead) + countWordsSimple(b.text);
            for (const si of b.subItems || []) {
              summaryBullets += 1;
              summaryWords += countWordsSimple(si);
            }
          }
          if (sub.table) {
            for (const row of sub.table.rows || []) {
              for (const cell of row) {
                summaryWords += countWordsSimple(cell);
              }
            }
          }
        }
      }
      for (const p of parsed.examPitfalls || []) {
        summaryWords += countWordsSimple(p);
      }
    } catch {
      // Malformed JSON treated as 0 stats
    }
  }

  if (input.flashcardsArtifact?.contentJson) {
    try {
      const parsed = JSON.parse(input.flashcardsArtifact.contentJson) as {
        cards?: unknown[];
      };
      flashcardsCount = Array.isArray(parsed.cards) ? parsed.cards.length : 0;
    } catch {
      flashcardsCount = 0;
    }
  }

  if (input.quizArtifact?.contentJson) {
    try {
      const parsed = JSON.parse(input.quizArtifact.contentJson) as {
        questions?: unknown[];
      };
      quizQuestionsCount = Array.isArray(parsed.questions)
        ? parsed.questions.length
        : 0;
    } catch {
      quizQuestionsCount = 0;
    }
  }

  const pageCount = Math.max(1, input.pageCount || 1);
  const expectedMinChapters =
    pageCount >= 35 ? 5 : pageCount >= 18 ? 3 : pageCount >= 8 ? 2 : 1;
  const expectedDenseWords = Math.max(220, Math.min(2800, pageCount * 35));
  const thinWordsThreshold = Math.max(150, Math.min(900, pageCount * 12));

  let densityStatus: AiDensityStatus = "MOYEN";
  if (
    !input.summaryArtifact &&
    flashcardsCount === 0 &&
    quizQuestionsCount === 0
  ) {
    densityStatus = "MANQUANT";
  } else if (
    !input.summaryArtifact ||
    summaryPipeline !== "FULL_V6" ||
    summaryChapters < expectedMinChapters ||
    summaryWords < thinWordsThreshold ||
    summaryBullets < 6
  ) {
    densityStatus = "MAIGRE";
  } else if (
    summaryWords >= expectedDenseWords &&
    flashcardsCount > 0 &&
    quizQuestionsCount > 0
  ) {
    densityStatus = "DENSE";
  } else {
    densityStatus = "MOYEN";
  }

  return {
    documentId: input.documentId,
    title: input.title,
    fileName: input.fileName,
    pageCount,
    ueId: input.ueId,
    ueCode: input.ueCode,
    ueTitle: input.ueTitle,
    chapterTitle: input.chapterTitle,
    isIndexed: input.isIndexed,
    processingStatus: input.processingStatus,
    summaryArtifactId: input.summaryArtifact?.id ?? null,
    summaryPipeline,
    summaryChapters,
    summaryWords,
    summaryBullets,
    summaryConcepts,
    flashcardsCount,
    quizQuestionsCount,
    densityStatus,
  };
}
