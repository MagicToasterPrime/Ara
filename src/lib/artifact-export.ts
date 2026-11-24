import type { FlashcardItem, SummaryPayload } from "@/lib/studio";

export function buildFlashcardKey(front: string): string {
  return front.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

function escapeHtmlBasic(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mdInlineToHtml(raw: string): string {
  return escapeHtmlBasic(raw)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function sanitizeTsvField(str: string): string {
  return str.replace(/[\t\r\n]+/g, " ").trim();
}

function sanitizeTagToken(raw: string): string {
  return (
    raw
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "ARA"
  );
}

/**
 * Produces an Anki-ready TSV import file (`#separator:tab`, HTML enabled, Tags column).
 */
export function buildAnkiTsvExport(
  title: string,
  cards: FlashcardItem[],
  ueCode?: string
): string {
  const header = [
    "#separator:tab",
    "#html:true",
    "#tags column:3",
    `#deck:Ara::${sanitizeTsvField(ueCode || "Veterinaire")}::${sanitizeTsvField(title)}`,
  ];

  const rows = cards.map((card) => {
    const frontHtml = sanitizeTsvField(mdInlineToHtml(card.front));
    const sourceLine = card.fileName
      ? `<br><small style="color:#64748b">[${escapeHtmlBasic(
          card.fileName
        )} · P.${card.pageNumber}]</small>`
      : "";
    const backHtml = sanitizeTsvField(
      `${mdInlineToHtml(card.back)}${sourceLine}`
    );
    const tags = [
      ueCode ? sanitizeTagToken(ueCode) : "",
      card.tag ? sanitizeTagToken(card.tag) : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `${frontHtml}\t${backHtml}\t${tags}`;
  });

  return [...header, ...rows].join("\n");
}

function csvCell(val: string): string {
  const escaped = val.replace(/\r?\n/g, " ").replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * UTF-8 semicolon CSV with BOM so French Excel / LibreOffice / Anki open accents cleanly.
 */
export function buildFlashcardsCsvExport(cards: FlashcardItem[]): string {
  const lines = [
    ["Recto", "Verso", "Catégorie", "Source"].map(csvCell).join(";"),
    ...cards.map((c) =>
      [
        c.front,
        c.back,
        c.tag || "NOTION",
        `${c.fileName || "cours.pdf"} (P.${c.pageNumber || 1})`,
      ]
        .map(csvCell)
        .join(";")
    ),
  ];
  return `\uFEFF${lines.join("\n")}`;
}

/**
 * Converts a structured SummaryPayload back into clean Markdown (.md) for offline notes / Obsidian.
 */
export function buildSummaryMarkdownExport(
  title: string,
  summary: SummaryPayload
): string {
  const out: string[] = [];
  out.push(`# ${title}`);
  out.push("");
  if (summary.overview) {
    out.push(`> ${summary.overview}`);
    out.push("");
  }

  const sections = summary.sections || [];
  sections.forEach((sec, sIdx) => {
    out.push(
      `## ${sIdx + 1}. ${sec.title}${sec.pageRange ? ` (${sec.pageRange})` : ""}`
    );
    out.push("");

    if (sec.subsections && sec.subsections.length > 0) {
      for (const sub of sec.subsections) {
        out.push(`### ${sub.icon ? `${sub.icon} ` : ""}${sub.title}`);
        out.push("");
        if (sub.intro) {
          out.push(sub.intro);
          out.push("");
        }
        if (sub.callouts && sub.callouts.length > 0) {
          for (const co of sub.callouts) {
            out.push(
              `> ${co.icon || "💡"} **${co.title}** : ${co.text || ""}`.trim()
            );
            if (co.items && co.items.length > 0) {
              co.items.forEach((it, idx) => {
                out.push(`> ${idx + 1}. ${it}`);
              });
            }
            out.push("");
          }
        }
        if (sub.bullets && sub.bullets.length > 0) {
          for (const b of sub.bullets) {
            out.push(`- ${b.lead ? `**${b.lead}** : ` : ""}${b.text}`);
            if (b.subItems && b.subItems.length > 0) {
              for (const si of b.subItems) {
                out.push(`  - ${si}`);
              }
            }
          }
          out.push("");
        }
        if (
          sub.table &&
          sub.table.headers.length > 0 &&
          sub.table.rows.length > 0
        ) {
          out.push(`| ${sub.table.headers.join(" | ")} |`);
          out.push(
            `| ${sub.table.headers.map(() => "---").join(" | ")} |`
          );
          for (const row of sub.table.rows) {
            out.push(`| ${row.join(" | ")} |`);
          }
          out.push("");
        }
      }
    } else {
      if (sec.content) {
        out.push(sec.content);
        out.push("");
      }
      if (sec.keyPoints && sec.keyPoints.length > 0) {
        for (const kp of sec.keyPoints) {
          out.push(`- ${kp}`);
        }
        out.push("");
      }
    }
  });

  if (summary.keyConcepts && summary.keyConcepts.length > 0) {
    out.push("## Glossaire & Notions clés");
    out.push("");
    for (const kc of summary.keyConcepts) {
      out.push(`- **${kc.term}** : ${kc.definition} _${kc.sourceLabel}_`);
    }
    out.push("");
  }

  if (summary.examPitfalls && summary.examPitfalls.length > 0) {
    out.push("## ⚠️ Points de vigilance & pièges en partiel");
    out.push("");
    for (const p of summary.examPitfalls) {
      out.push(`- ${p}`);
    }
    out.push("");
  }

  return out.join("\n").trim() + "\n";
}
