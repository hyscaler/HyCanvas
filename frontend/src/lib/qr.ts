// QR matrix generation for the editor. We compute the scannable module matrix
// with the `qrcode` library here (client side) and store it on the QR node, so
// the framework-agnostic engine can render it (and exports reproduce it) without
// depending on a QR encoder.

import QRCode from "qrcode";

export type QrEcLevel = "L" | "M" | "Q" | "H";

/** Encode `value` into a row-major boolean matrix (true = dark module). */
export function qrModules(value: string, ecLevel: QrEcLevel = "M"): boolean[][] {
  const qr = QRCode.create(value || " ", { errorCorrectionLevel: ecLevel });
  const size = qr.modules.size;
  const data = qr.modules.data; // Uint8Array, length size*size, 1 = dark
  const out: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) row.push(!!data[r * size + c]);
    out.push(row);
  }
  return out;
}
