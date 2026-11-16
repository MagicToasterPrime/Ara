export type CustomQuestionType =
  | "IMAGE_OCCLUSION"
  | "QCU"
  | "QCM"
  | "FILL_BLANK";

export interface OcclusionMask {
  id: string;
  index: number;
  xPercent: number;
  yPercent: number;
  wPercent: number;
  hPercent: number;
  label: string;
}

export interface CustomQuizQuestion {
  id: string;
  type: CustomQuestionType;
  prompt: string;
  explanation?: string;
  // IMAGE_OCCLUSION
  imageDataUrl?: string;
  sourceDocId?: string;
  sourcePageNumber?: number;
  masks?: OcclusionMask[];
  showWordBank?: boolean;
  // QCU / QCM
  options?: string[];
  correctIndices?: number[];
  // FILL_BLANK
  sentenceWithBlank?: string;
  correctAnswer?: string;
}

export function normalizeQuizText(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ");
}
