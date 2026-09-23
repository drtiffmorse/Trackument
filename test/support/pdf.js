'use strict';
// Builds a small, real, text-based PDF (one line of text per entry, 45 lines
// per page) so the citation tests run the same PDF reader the server uses in
// production, with no extra dependency.

function escapePdfText(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function makePdf(lines) {
  const perPage = 45;
  const pages = [];
  for (let i = 0; i < Math.max(1, lines.length); i += perPage) pages.push(lines.slice(i, i + perPage));

  const objects = [];
  const reserve = () => objects.push(null);
  const catalogId = reserve();
  const pagesId = reserve();
  const fontId = objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageIds = [];
  for (const pageLines of pages) {
    const ops = ['BT', '/F1 11 Tf', '14 TL', '72 740 Td'];
    for (const line of pageLines) ops.push('(' + escapePdfText(line) + ') Tj', 'T*');
    ops.push('ET');
    const stream = ops.join('\n');
    const contentId = objects.push('<< /Length ' + Buffer.byteLength(stream, 'latin1') + ' >>\nstream\n' + stream + '\nendstream');
    pageIds.push(objects.push('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ' + fontId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>'));
  }
  objects[catalogId - 1] = '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>';
  objects[pagesId - 1] = '<< /Type /Pages /Kids [' + pageIds.map(id => id + ' 0 R').join(' ') + '] /Count ' + pageIds.length + ' >>';

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets) out += String(offset).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

// The browser sends uploads as a data: URL, so tests do the same.
function pdfDataUrl(lines) {
  return 'data:application/pdf;base64,' + makePdf(lines).toString('base64');
}

module.exports = { makePdf, pdfDataUrl };
