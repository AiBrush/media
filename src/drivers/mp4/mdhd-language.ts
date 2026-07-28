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
