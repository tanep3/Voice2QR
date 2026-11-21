/**
 * User settings — the ONLY thing the app persists (localStorage).
 * Recordings and payloads are never stored (docs/requirements.md:
 * recording data is not retained).
 */
export interface Settings {
  lang: 'ja' | 'en';
  /** Codec2 bit rate for recording. Default 1200. */
  bps: number;
  /** QR error-correction level for recording. Default 'M'. */
  ecLevel: 'L' | 'M' | 'Q' | 'H';
  /** Normalize a quiet recording up to a fixed peak before encoding. Default ON. */
  autoGain: boolean;
  /**
   * Printable dot width of the target thermal printer, for saved /
   * shared / printed QR images: 384 (200 dpi class, e.g. T02) or
   * 576 (300 dpi class, e.g. M02S). Default 576.
   */
  printWidth: 384 | 576;
}

const KEY = 'voice2qr-settings';

export function loadSettings(): Settings {
  const defaults: Settings = {
    lang: navigator.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en',
    bps: 1200,
    ecLevel: 'M',
    autoGain: true,
    printWidth: 576,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      lang: parsed.lang === 'en' ? 'en' : parsed.lang === 'ja' ? 'ja' : defaults.lang,
      bps: typeof parsed.bps === 'number' ? parsed.bps : defaults.bps,
      ecLevel:
        parsed.ecLevel === 'L' || parsed.ecLevel === 'Q' || parsed.ecLevel === 'H'
          ? parsed.ecLevel
          : 'M',
      // Absent in settings saved before this option existed: ON.
      autoGain: parsed.autoGain !== false,
      printWidth: parsed.printWidth === 384 ? 384 : 576,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode etc.: settings simply don't persist.
  }
}
