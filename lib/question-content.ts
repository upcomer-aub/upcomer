// Conservative content checks shared by extraction, regrouping and source eligibility.
// Never require a question mark: calculations, proofs and declarative problem setups are valid questions.
const LABEL = /^(?:(?:question|q)\s*\d+\s*[.):]?|\(\d+\)|\d+[.):])(?:\s+|(?<=[.):])(?=\p{L})|$)/iu;
const plain = (line: string) => line.trim().replace(LABEL, "").trim();
export const isInstructionHeading = (line: string) => /^(?:(?:general|exam(?:ination)?|important)\s+)?instructions(?:\s+(?:to|for)\s+(?:students|candidates))?\s*:?$/i.test(line.trim())
  || /^read\s+(?:all\s+|the\s+following\s+)?instructions\s+carefully[.!:]?$/i.test(line.trim());

const RULES = [
  /^no\s+(?:calculators?|books?|notes?|electronic\s+devices?|mobile\s+phones?)[.!]?$/i,
  /^(?:midterm|final)\s+(?:exam(?:ination)?|test)(?:\s+\d{4})?[.!]?$/i,
  /^(?:(?:this\s+(?:is\s+)?(?:an?\s+)?|the\s+)?(?:exam(?:ination)?|test)\s+is\s+(?:an?\s+)?)?(?:this\s+is\s+an?\s+)?(?:open|closed)[ -]book(?:\s+(?:and\s+)?(?:open|closed)[ -]notes)?(?:\s+(?:exam(?:ination)?|test))?[.!]?$/i,
  /^(?:this\s+(?:exam(?:ination)?|test)\s+is\s+)?(?:open|closed)[ -]notes[.!]?$/i,
  /^(?:no\s+)?(?:calculators?|books?|notes?|electronic\s+devices?|mobile\s+phones?)\s+(?:(?:are|is)\s+)?(?:not\s+)?(?:allowed|permitted)(?:\s+(?:in|during)\s+(?:this|the)\s+exam)?[.!]?$/i,
  /^(?:do\s+not|don't)\s+use\s+(?:a\s+|any\s+)?(?:calculator|books?|notes?|mobile\s+phones?)[.!]?$/i,
  /^(?:answer|attempt)\s+(?:all|any\s+\w+|\w+\s+of\s+(?:the\s+)?\w+)\s+(?:the\s+)?questions(?:\s+in\s+(?:the\s+)?(?:answer\s+)?booklet)?[.!]?$/i,
  /^(?:write\s+(?:all\s+)?(?:your\s+)?answers?|answer)\s+in\s+(?:the\s+)?(?:answer\s+)?booklet[.!]?$/i,
  /^(?:show\s+all\s+(?:your\s+)?work|good\s+luck|end\s+of\s+(?:the\s+)?(?:exam(?:ination)?|paper|questions))[.!]?$/i,
  /^(?:(?:exam(?:ination)?\s+)?duration|time\s+allowed|total\s+(?:exam\s+)?time)\s*:\s*\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?)[.!]?$/i,
  /^(?:student\s+(?:name|id|number)|name|id\s+number)\s*:\s*[_ .-]*$/i,
  /^(?:page\s+\d+(?:\s*(?:of|\/)\s*\d+)?|-\s*\d+\s*-)$/i,
];

export function isExamBoilerplate(line: string) {
  const text = plain(line);
  // Most real exercises cannot match any rule; avoid running every expression for every repeated source.
  if (!text.startsWith("-") && !/^(?:this|the|an?|open|closed|no|do|don't|calculators?|books?|notes?|electronic|mobile|answer|attempt|write|show|good|end|exam(?:ination)?|duration|time|total|student|name|id|page|midterm|final|general|important|instructions|read)\b/i.test(text)) return false;
  return isInstructionHeading(text) || RULES.some(rule => rule.test(text));
}

// Strip only complete, recognizable rule lines. If a line also contains an actual task it will not match a rule.
// Keep the original numbering and line breaks of all retained content.
export function cleanExtractedQuestion(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.length <= 1) return lines.length && !isExamBoilerplate(lines[0]) ? lines[0] : "";
  if (isExamBoilerplate(lines.join(" "))) return "";
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (isExamBoilerplate(lines[index])) continue;
    if (index + 1 < lines.length && isExamBoilerplate(`${lines[index]} ${lines[index + 1]}`)) { index++; continue; }
    kept.push(lines[index]);
  }
  return kept.join("\n");
}

export function questionReviewReason(text: string): string | null {
  const cleaned = cleanExtractedQuestion(text);
  if (!plain(cleaned).replace(/[\s\d.):(]/g, "")) return "Only exam instructions, a heading, or an empty question label were found.";
  const content = plain(cleaned);
  if (!/[?=+*/<>^]/.test(content) && !/\b(?:explain|describe|define|calculate|compute|prove|derive|find|determine|solve|compare|discuss|state|write|show|list|identify|consider|given|suppose|let|evaluate|draw|design|implement)\b/i.test(content)) {
    return "Check this entry: no clear question or exercise instruction was detected. It is kept until an admin excludes it.";
  }
  return null;
}

export const isUsableQuestion = (question: { text: string; excludedFromBank?: boolean }) =>
  !question.excludedFromBank && Boolean(plain(cleanExtractedQuestion(question.text)).replace(/[\s\d.):(]/g, ""));
