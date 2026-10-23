// Real PDFs with text placed at exact positions, for the US-14 and US-76 cross-tests. Real exam PDFs often draw one
// printed line as several pieces (a number, then the text), add page footers, and run questions across pages; this
// builds those layouts in code so no binary files are committed. Helvetica, ASCII text only.

export type TextItem = { x: number; y: number; text: string };

const escape = (text: string) => text.replace(/[^\x20-\x7E]/g, "?").replace(/[()\\]/g, (match) => `${String.fromCharCode(92)}${match}`);

function assemble(objects: string[]) {
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output, "latin1"));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output, "latin1");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(output, "latin1"));
}

// Each page is a list of text items; each item is drawn where it says.
export function layoutPdf(pages: TextItem[][]) {
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, items] of pages.entries()) {
    const stream = ["BT", "/F1 11 Tf", ...items.flatMap(item => [`1 0 0 1 ${item.x} ${item.y} Tm`, `(${escape(item.text)}) Tj`]), "ET"].join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
  }
  return assemble(objects);
}

// One page per list of lines, top to bottom, each line one item at the left margin.
export const linesPdf = (pages: string[][]) => layoutPdf(pages.map(lines => lines.map((text, row) => ({ x: 72, y: 740 - row * 20, text }))));

// A scanned page with a small text watermark, as phone scanner apps add: an image plus one line of text.
export function watermarkedScanPdf(watermark: string) {
  const size = 16;
  const pixels = Buffer.alloc(size * size, 0x80).toString("latin1");
  const stream = `q ${size * 20} 0 0 ${size * 20} 72 400 cm /Im1 Do Q\nBT /F1 8 Tf 1 0 0 1 72 30 Tm (${escape(watermark)}) Tj ET`;
  return assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>",
    `<< /Type /XObject /Subtype /Image /Width ${size} /Height ${size} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${size * size} >>\nstream\n${pixels}\nendstream`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

// Many pages, each with nothing drawn: cheap to make, and every page still has to be opened and read.
export const blankPagesPdf = (count: number) => layoutPdf(Array.from({ length: count }, () => []));
