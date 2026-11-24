import type {
  RevisionAnswerValue,
  RevisionQuestion,
} from "@/lib/revisions";

export function normalizeTextForMatch(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ");
}

export function isRevisionQuestionCorrect(
  q: RevisionQuestion,
  ans: RevisionAnswerValue | undefined
): boolean {
  if (q.type === "QCU" || q.type === "QCM") {
    const selected = Array.isArray(ans)
      ? [...ans].sort((a, b) => a - b)
      : [];
    const expected = [...(q.correctIndices || [])].sort((a, b) => a - b);
    return (
      expected.length > 0 &&
      selected.length === expected.length &&
      selected.every((v, idx) => v === expected[idx])
    );
  }
  if (q.type === "QROC") {
    const given = typeof ans === "string" ? normalizeTextForMatch(ans) : "";
    if (given.length < 2) return false;
    const expected = q.correctAnswer
      ? normalizeTextForMatch(q.correctAnswer)
      : "";
    const matchesMain = Boolean(
      expected &&
        (given === expected ||
          (expected.length >= 3 && given.includes(expected)) ||
          (given.length >= 4 && expected.includes(given)))
    );
    const keywords = (q.acceptedKeywords || [])
      .map((k) => normalizeTextForMatch(k))
      .filter((k) => k.length >= 3);
    const matchesKeyword = keywords.some(
      (kw) =>
        given === kw ||
        given.includes(kw) ||
        (given.length >= 4 && kw.includes(given))
    );
    return matchesMain || matchesKeyword;
  }
  if (q.type === "FLASHCARD") {
    return ans === "KNOWN";
  }
  if (q.type === "FILL_BLANK") {
    const given = typeof ans === "string" ? normalizeTextForMatch(ans) : "";
    const expected = q.correctAnswer
      ? normalizeTextForMatch(q.correctAnswer)
      : "";
    return Boolean(expected && given === expected);
  }
  if (q.type === "IMAGE_POINT") {
    if (ans && typeof ans === "object" && !Array.isArray(ans)) {
      if (ans.matchedTarget) return true;
      if (ans.selectedZoneId && q.correctZoneId) {
        return ans.selectedZoneId === q.correctZoneId;
      }
    }
  }
  return false;
}
