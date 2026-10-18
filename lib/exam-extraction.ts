import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type ExtractionReason = "no_text" | "no_questions" | "unreadable_pdf" | "unsupported_type";

export class ExtractionError extends Error {
  constructor(public reason: ExtractionReason) { super(reason); }
}

// A question starts with a printed number, Q-number, or "Question number".
const QUESTION_START = /^(?:Q(?:uestion)?\s*\d{1,3}\s*[.):]?|\(\d{1,3}\)|\d{1,3}[.)])(?:\s+\S|$)/i;

export function questionsFromLines(lines: string[]) {
  const questions: string[] = [];
  let current: string[] = [];
  for (const line of lines.map(line => line.trim()).filter(Boolean)) {
    if (QUESTION_START.test(line)) {
      if (current.length) questions.push(current.join("\n"));
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) questions.push(current.join("\n"));
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
    if (!lines.some(line => line.length > 0)) throw new ExtractionError("no_text");
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
