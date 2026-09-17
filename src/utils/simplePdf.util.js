// Small text-only PDF writer for generated tabular reports. Rows are stored in
// Firestore; no server-local generated file is needed for later downloads.
function pdfFromLines(lines) {
  const clean = (value) => String(value ?? "")
    .normalize("NFKD").replace(/[^\x20-\x7e]/g, "?")
    .replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const wrappedLines = lines.flatMap((line) => {
    const value = String(line ?? "");
    if (!value) return [""];
    const parts = [];
    for (let index = 0; index < value.length; index += 105) {
      parts.push(value.slice(index, index + 105));
    }
    return parts;
  });
  const pages = [];
  for (let index = 0; index < wrappedLines.length; index += 48) {
    const pageLines = wrappedLines.slice(index, index + 48);
    pages.push(`BT /F1 10 Tf 42 798 Td 14 TL\n${pageLines
      .map((line, lineIndex) => `${lineIndex ? "T* " : ""}(${clean(line)}) Tj`)
      .join("\n")}\nET`);
  }
  if (!pages.length) pages.push("BT /F1 10 Tf 42 798 Td (Empty report) Tj ET");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let index = 0; index < pages.length; index += 1) {
    const contentId = 5 + index * 2;
    const stream = pages[index];
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

module.exports = { pdfFromLines };
