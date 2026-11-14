/**
 * Printing: the printout is the QR only, at a FIXED physical size
 * (docs: print size is fixed, it does not scale with the paper).
 * The QR image is placed in a print-only <img> sized in millimetres;
 * the print stylesheet hides everything else.
 */
export const PRINT_WIDTH_MM = 48;

export function printQrImage(imageUrl: string): void {
  const img = document.getElementById('print-qr') as HTMLImageElement | null;
  if (!img) return;
  img.style.width = `${PRINT_WIDTH_MM}mm`;
  img.src = imageUrl;
  // Give the image a tick to load before the print dialog snapshots.
  if (img.complete) {
    window.print();
  } else {
    img.onload = () => window.print();
  }
}
