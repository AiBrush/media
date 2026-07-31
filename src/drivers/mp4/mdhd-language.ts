/**
 * Decode the packed ISO-639-2/T language field from an ISO BMFF `mdhd` box.
 *
 * The field is one zero pad bit followed by three five-bit lowercase letters. Zero and the reserved
 * letter values 27–31 are not language codes; treating them as absent also preserves compatibility
 * with legacy QuickTime files that did not use the packed ISO language representation.
 */
export function decodeMdhdLanguage(packed: number): string | undefined {
  if (!Number.isInteger(packed) || packed < 0 || packed > 0x7fff) return undefined;
  const first = (packed >> 10) & 0x1f;
  const second = (packed >> 5) & 0x1f;
  const third = packed & 0x1f;
  if (first < 1 || first > 26 || second < 1 || second > 26 || third < 1 || third > 26) {
    return undefined;
  }
  return String.fromCharCode(first + 0x60, second + 0x60, third + 0x60);
}

/**
 * Macintosh Script Manager language codes accepted by legacy QuickTime `mdhd` fields, projected to
 * this library's ISO-639-2/T TrackInfo vocabulary. The numeric assignments are the public QuickTime
 * File Format "Language code values"; aliases that ISO-639-2 does not distinguish share one code.
 */
const QUICKTIME_LEGACY_LANGUAGES: Readonly<Record<number, string>> = {
  0: 'eng',
  1: 'fra',
  2: 'deu',
  3: 'ita',
  4: 'nld',
  5: 'swe',
  6: 'spa',
  7: 'dan',
  8: 'por',
  9: 'nor',
  10: 'heb',
  11: 'jpn',
  12: 'ara',
  13: 'fin',
  14: 'ell',
  15: 'isl',
  16: 'mlt',
  17: 'tur',
  18: 'hrv',
  19: 'zho',
  20: 'urd',
  21: 'hin',
  22: 'tha',
  23: 'kor',
  24: 'lit',
  25: 'pol',
  26: 'hun',
  27: 'est',
  28: 'lav',
  29: 'smi',
  30: 'fao',
  31: 'fas',
  32: 'rus',
  33: 'zho',
  34: 'nld',
  35: 'gle',
  36: 'sqi',
  37: 'ron',
  38: 'ces',
  39: 'slk',
  40: 'slv',
  41: 'yid',
  42: 'srp',
  43: 'mkd',
  44: 'bul',
  45: 'ukr',
  46: 'bel',
  47: 'uzb',
  48: 'kaz',
  49: 'aze',
  50: 'aze',
  51: 'hye',
  52: 'kat',
  53: 'ron',
  54: 'kir',
  55: 'tgk',
  56: 'tuk',
  57: 'mon',
  58: 'mon',
  59: 'pus',
  60: 'kur',
  61: 'kas',
  62: 'snd',
  63: 'bod',
  64: 'nep',
  65: 'san',
  66: 'mar',
  67: 'ben',
  68: 'asm',
  69: 'guj',
  70: 'pan',
  71: 'ori',
  72: 'mal',
  73: 'kan',
  74: 'tam',
  75: 'tel',
  76: 'sin',
  77: 'mya',
  78: 'khm',
  79: 'lao',
  80: 'vie',
  81: 'ind',
  82: 'tgl',
  83: 'msa',
  84: 'msa',
  85: 'amh',
  86: 'tir',
  87: 'orm',
  88: 'som',
  89: 'swa',
  90: 'kin',
  91: 'run',
  92: 'nya',
  93: 'mlg',
  94: 'epo',
  128: 'cym',
  129: 'eus',
  130: 'cat',
  131: 'lat',
  132: 'que',
  133: 'grn',
  134: 'aym',
  135: 'tat',
  136: 'uig',
  137: 'dzo',
  138: 'jav',
};

/** Decode either a packed ISO value or the legacy Macintosh value allowed by QuickTime files. */
export function decodeQuickTimeMdhdLanguage(code: number): string | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 0xffff || code === 0x7fff) return undefined;
  if (code < 0x400) return QUICKTIME_LEGACY_LANGUAGES[code];
  return decodeMdhdLanguage(code);
}
