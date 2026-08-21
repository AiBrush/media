/**
 * The inlined fallback copy of the vendored LAME core. Returns the same bytes as the sibling
 * `mp3_enc_wasm_bg.wasm`, decoded at most once per realm; see the implementation for when the tail
 * reaches for it instead of the URL.
 */
export default function mp3EncWasmFallbackBytes(): Uint8Array;
