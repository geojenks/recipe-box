/**
 * Finds the dish photo inside a PDF.
 *
 * Recipe PDFs (web page printouts, cookbook exports) usually embed photos as
 * plain JPEG streams (/DCTDecode), so the original JPEG bytes can be copied out
 * without any image library. The biggest reasonably-shaped one is almost always
 * the photo of the finished dish; logos and icons are small or banner-shaped.
 *
 * Pure string logic so tools/test-photos.mjs can run it in Node.
 */

var MIN_PHOTO_WIDTH = 300;
var MIN_PHOTO_HEIGHT = 200;

/**
 * @param {string} pdf the PDF's bytes as a Latin-1 string (one char per byte)
 * @return {Array<{start: number, end: number, width: number, height: number}>}
 *   byte ranges of embedded JPEGs, largest first
 */
function findPdfJpegs_(pdf) {
  var found = [];
  var pos = 0;
  while ((pos = pdf.indexOf('/DCTDecode', pos)) !== -1) {
    var at = pos;
    pos += 10;
    var dictStart = pdf.lastIndexOf(' obj', at);
    var streamKw = pdf.indexOf('stream', at);
    if (dictStart === -1 || streamKw === -1 || streamKw - dictStart > 4000) continue;
    var dict = pdf.substring(dictStart, streamKw);
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    if (/FlateDecode|LZWDecode|ASCII/.test(dict)) continue; // JPEG wrapped in another encoding
    if (/\/DeviceCMYK|\/Decode\s*\[/.test(dict)) continue;   // CMYK/inverted JPEGs show wrong colours in browsers

    var w = /\/Width\s+(\d+)/.exec(dict);
    var h = /\/Height\s+(\d+)/.exec(dict);
    if (!w || !h) continue;

    var start = streamKw + 6;
    if (pdf.charAt(start) === '\r') start++;
    if (pdf.charAt(start) === '\n') start++;
    if (pdf.charCodeAt(start) !== 0xFF || pdf.charCodeAt(start + 1) !== 0xD8) continue;

    // Use /Length when it's a direct number, otherwise look for the JPEG end marker.
    var len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    var end = len ? start + Number(len[1]) : pdf.lastIndexOf('\xFF\xD9', pdf.indexOf('endstream', start)) + 2;
    if (end <= start + 2) continue;

    found.push({ start: start, end: end, width: Number(w[1]), height: Number(h[1]) });
  }
  return found.sort(function (a, b) { return b.width * b.height - a.width * a.height; });
}

/** Picks the embedded image most likely to be the dish photo, or null. */
function pickDishPhoto_(jpegs) {
  for (var i = 0; i < jpegs.length; i++) {
    var j = jpegs[i];
    var ratio = j.width / j.height;
    if (j.width >= MIN_PHOTO_WIDTH && j.height >= MIN_PHOTO_HEIGHT && ratio >= 0.5 && ratio <= 2.5) return j;
  }
  return null;
}
