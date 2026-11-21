/**
 * Printing: the printout is the QR only, at a FIXED physical size
 * (docs: print size is fixed, it does not scale with the paper).
 * The QR image is placed in a print-only <img> sized in millimetres;
 * the print stylesheet hides everything else.
 */
export const PRINT_WIDTH_MM = 48;

/**
 * Physical print width for a printer-optimized QR image: the image is
 * exactly the printer's printable dot width, so its size in mm is the
 * dot count divided by the printer class's dpi (384 px = 200 dpi
 * class, 576 px = 300 dpi class). Both land at ≈ 48 mm.
 */
export function printWidthMm(printWidthPx: number): number {
  const dpi = printWidthPx <= 384 ? 203 : 300;
  return (printWidthPx / dpi) * 25.4;
}

export function printQrImage(imageUrl: string, widthMm: number = PRINT_WIDTH_MM): void {
  const img = document.getElementById('print-qr') as HTMLImageElement | null;
  if (!img) return;
  img.style.width = `${widthMm}mm`;
  img.src = imageUrl;
  // Give the image a tick to load before the print dialog snapshots.
  if (img.complete) {
    window.print();
  } else {
    img.onload = () => window.print();
  }
}
