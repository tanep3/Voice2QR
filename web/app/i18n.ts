/** UI strings, Japanese / English (docs: UI language switchable,
 *  defaulting to the device language). */
export type Lang = 'ja' | 'en';

const dict = {
  ja: {
    tagline: '声を QR コードに入れる',
    tabCreate: 'つくる',
    tabRead: 'よむ',
    record: '● 録音する',
    stop: '■ 停止',
    recording: '録音中…',
    remaining: '残り約 {s} 秒',
    importLabel: 'または音声ファイルから',
    importButton: 'ファイルを選ぶ',
    savePng: 'PNG を保存',
    share: '共有',
    shareUnsupported: 'このブラウザでは共有できないので、PNG保存を使ってください',
    close: '閉じる',
    print: '印刷',
    play: '再生',
    stopPlay: '停止',
    resultInfo: '{sec} 秒の声 / {bytes} バイト',
    readImageLabel: 'QR 画像を選ぶ',
    cameraStart: 'カメラで読む',
    cameraStop: 'カメラ停止',
    scanning: 'QR を探しています…',
    readError: '読み取れませんでした',
    voiceFound: '声が入っています： {sec} 秒（{bps} bps）',
    noVoice: 'この QR に声は入っていません',
    settings: '設定',
    language: '言語',
    bps: 'ビットレート（上級者向け）',
    ecLevel: '誤り訂正（上級者向け）',
    capacityFull: '容量いっぱいまで録音しました',
    trimmed: '長い音声だったので、先頭 {sec} 秒だけを使いました',
    micError: 'マイクを使えませんでした',
    fileError: 'そのファイルは読み込めませんでした',
    processing: '処理中…',
    footer: '処理はすべてこの端末の中で行います。録音データは保存されません。',
    loading: '読み込み中…',
  },
  en: {
    tagline: 'Put a real voice in a QR code',
    tabCreate: 'Create',
    tabRead: 'Read',
    record: '● Record',
    stop: '■ Stop',
    recording: 'Recording…',
    remaining: 'About {s} s left',
    importLabel: 'or from an audio file',
    importButton: 'Choose a file',
    savePng: 'Save PNG',
    share: 'Share',
    shareUnsupported: 'This browser cannot share; please use Save PNG instead',
    close: 'Close',
    print: 'Print',
    play: 'Play',
    stopPlay: 'Stop',
    resultInfo: '{sec} s of voice / {bytes} bytes',
    readImageLabel: 'Choose a QR image',
    cameraStart: 'Read with camera',
    cameraStop: 'Stop camera',
    scanning: 'Looking for a QR code…',
    readError: 'Could not read it',
    voiceFound: 'Contains voice: {sec} s ({bps} bps)',
    noVoice: 'This QR contains no voice',
    settings: 'Settings',
    language: 'Language',
    bps: 'Bit rate (advanced)',
    ecLevel: 'Error correction (advanced)',
    capacityFull: 'Recorded up to the capacity limit',
    trimmed: 'The audio was long, so only the first {sec} s were used',
    micError: 'Could not use the microphone',
    fileError: 'Could not read that file',
    processing: 'Processing…',
    footer: 'Everything runs on this device. Recordings are not stored.',
    loading: 'Loading…',
  },
} as const;

export type I18nKey = keyof (typeof dict)['ja'];

let current: Lang = 'ja';

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

export function t(key: I18nKey, params?: Record<string, string | number>): string {
  let s: string = dict[current][key];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(`{${k}}`, String(v));
    }
  }
  return s;
}

/** Apply the dictionary to every element carrying data-i18n. */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as I18nKey;
    el.textContent = t(key);
  });
}
