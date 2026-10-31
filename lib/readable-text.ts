// trim() keeps invisible characters such as zero-width spaces, so text made only of them would show up empty.
// These are removed before checking that something readable is left: whitespace, format characters
// (zero-width spaces and joiners, byte order marks), and the blank fillers that count as letters or symbols.
const BLANK_FILLERS = String.fromCodePoint(0x115f, 0x1160, 0x3164, 0xffa0, 0x2800);
const INVISIBLE = new RegExp(String.raw`[\p{White_Space}\p{Cf}${BLANK_FILLERS}]`, "gu");

export const hasReadableText = (text: string) => text.replace(INVISIBLE, "").length > 0;
