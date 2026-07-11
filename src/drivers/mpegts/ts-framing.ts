/** MPEG-TS packet-grid detection shared by cheap routing and the full PSI/PES parser. */

/** A transport packet is 188 bytes; M2TS/MTS prepend four bytes, and RS-protected TS appends 16. */
export type PacketSize = 188 | 192 | 204;

const PACKET_SIZES: readonly PacketSize[] = [188, 192, 204];
const SYNC_BYTE = 0x47;
const SYNC_RUN = 8;

export interface TsFraming {
  readonly packetSize: PacketSize;
  readonly start: number;
  readonly tsOffset: number;
}

/**
 * Detect a transport packet grid from a bounded head or complete segment. At least two consecutive sync
 * bytes are required for a short input; longer inputs require up to eight. `start` includes any leading
 * junk while `tsOffset` locates the 188-byte TS body inside each physical packet.
 */
export function detectFraming(bytes: Uint8Array): TsFraming | undefined {
  for (const packetSize of PACKET_SIZES) {
    const tsOffset = packetSize === 192 ? 4 : 0;
    const scanLimit = Math.min(bytes.byteLength, packetSize * 4);
    for (let base = 0; base + tsOffset < scanLimit; base += 1) {
      const first = base + tsOffset;
      if (bytes[first] !== SYNC_BYTE) continue;
      let matches = true;
      for (let index = 0; index < SYNC_RUN; index += 1) {
        const offset = first + index * packetSize;
        if (offset >= bytes.byteLength) {
          matches = index >= 2;
          break;
        }
        if (bytes[offset] !== SYNC_BYTE) {
          matches = false;
          break;
        }
      }
      if (matches) return { packetSize, start: base, tsOffset };
    }
  }
  return undefined;
}
