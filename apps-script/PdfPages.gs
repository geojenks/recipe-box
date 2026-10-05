/**
 * Copies one page of a PDF into a new single-page PDF, so Drive can render it
 * as a picture (Drive only renders page 1 of a file).
 *
 * Uses pdf-lib (https://pdf-lib.js.org), fetched when first needed. Kept free of
 * Apps Script services so it can be tested in Node.
 */

var PDF_LIB_URL = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';

// Apps Script has no setTimeout; pdf-lib only uses it to yield between chunks of work.
if (typeof globalThis.setTimeout !== 'function') {
  globalThis.setTimeout = function (fn) { fn(); return 0; };
}

/**
 * @param {number[]|Uint8Array} bytes the PDF (Apps Script's signed bytes are fine)
 * @param {number} pageNumber 1-based
 * @param {function(): string} loadLibrary returns pdf-lib's source code
 * @return {Promise<Uint8Array|null>} the single-page PDF, or null if there is no such page
 */
async function extractPdfPage_(bytes, pageNumber, loadLibrary) {
  if (!globalThis.PDFLib) (0, eval)(loadLibrary());
  var src = await PDFLib.PDFDocument.load(Uint8Array.from(bytes), { ignoreEncryption: true, updateMetadata: false });
  if (pageNumber < 1 || pageNumber > src.getPageCount()) return null;
  var out = await PDFLib.PDFDocument.create();
  var pages = await out.copyPages(src, [pageNumber - 1]);
  out.addPage(pages[0]);
  return out.save();
}
