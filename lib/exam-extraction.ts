import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type ExtractionReason = "no_text" | "no_questions" | "unreadable_pdf" | "unsupported_type";

export class ExtractionError extends Error {
  constructor(public reason: ExtractionReason) { super(reason); }
}

// A question starts with a printed number, Q-number, or "Question number".
const QUESTION_START = /^(?:Q(?:uestion)?\s*\d{1,3}\s*[.):]?|\(\d{1,3}\)|\d{1,3}[.)])(?:\s+\S|$)/i;

// Page furniture that is not part of any question: printed page numbers ("Page 1 of 2", "- 3 -") and the one-line
// watermark phone scanner apps stamp on a scanned page ("Scanned with CamScanner").
const PAGE_NUMBER = /^(?:page\s+\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?|-\s*\d{1,4}\s*-)$/i;
const SCANNER_WATERMARK = /\b(?:scanned\s+(?:with|by|using)|camscanner|adobe\s+scan|genius\s+scan|microsoft\s+lens|office\s+lens|tapscanner)\b/i;
export const isPageFurniture = (line: string) =>
  PAGE_NUMBER.test(line) || (line.length <= 60 && !QUESTION_START.test(line) && SCANNER_WATERMARK.test(line));

// "Part B", "Section II: Problems", or a bare "Questions" end the question above them and are not part of any question.
const SECTION_HEADING = /^(?:(?:part|section)\s+(?:[a-z]|[ivx]{1,4}|\d{1,2})\s*(?:[:.(-].*)?|questions|problems|exercises)\s*:?$/i;
const INSTRUCTIONS_HEADING = /^(?:general\s+)?instructions\s*:?$/i;
const questionNumber = (line: string) => Number(/^(?:Q(?:uestion)?\s*)?\(?(\d{1,3})/i.exec(line)?.[1]);

export function questionsFromLines(lines: string[]) {
  const questions: string[] = [];
  // Numbered items under an "Instructions" heading are rules, not questions, once a section heading or numbering that
  // restarts at 1 shows the questions have begun. If neither comes, they were the questions after all.
  let held: string[] | null = null;
  let current: string[] = [];
  const close = () => {
    if (current.length) (held ?? questions).push(current.join("\n"));
    current = [];
  };
  for (const line of lines.map(line => line.trim()).filter(Boolean)) {
    if (isPageFurniture(line)) continue;
    if (INSTRUCTIONS_HEADING.test(line)) {
      close();
      held ??= [];
    } else if (SECTION_HEADING.test(line)) {
      close();
      held = null;
    } else if (QUESTION_START.test(line)) {
      close();
      if (held?.length && questionNumber(line) === 1) held = null;
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  close();
  if (held) questions.push(...held);
  return questions;
}

export async function extractExamQuestions(bytes: Uint8Array) {
  let task: ReturnType<typeof getDocument> | undefined;
  try {
    task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const document = await task.promise;
    const lines: string[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const { items } = await page.getTextContent();
      let line = "";
      let y: number | undefined;
      for (const item of items) {
        if (!("str" in item)) continue;
        const itemY = item.transform[5];
        if (line && y !== undefined && Math.abs(itemY - y) > 2) {
          lines.push(line.trim());
          line = "";
        }
        if (item.str) line += `${line && !/\s$/.test(line) && !/^\s/.test(item.str) ? " " : ""}${item.str}`;
        y = itemY;
        if (item.hasEOL && line) {
          lines.push(line.trim());
          line = "";
        }
      }
      if (line) lines.push(line.trim());
      page.cleanup();
    }
    if (!lines.some(line => line.length > 0 && !isPageFurniture(line))) throw new ExtractionError("no_text");
    const questions = questionsFromLines(lines);
    if (!questions.length) throw new ExtractionError("no_questions");
    return questions;
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError("unreadable_pdf");
  } finally {
    await task?.destroy();
  }
}
