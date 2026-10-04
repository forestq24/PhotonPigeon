/**
 * The two GamePigeon percent-encoding layers.
 *
 * Layer 1 — the `data=` URL parameter (OUTER): escape the structural set
 * `% & = ? #`; everything else stays literal. Any valid percent-encoding
 * decodes back to the exact ciphertext, which is all the recipient needs.
 *
 * Layer 2 — the `replay=` value inside the plaintext query (INNER):
 * `&`→`%26`, `#`→`%23`, `|`→`%7C`; `:` and `,` stay literal.
 */

// ---- Layer 1: data= parameter --------------------------------------------
export function dataEncode(ciphertext: string): string {
  let out = ciphertext.split("%").join("%25"); // must be first
  out = out.split("&").join("%26");
  out = out.split("=").join("%3D");
  out = out.split("?").join("%3F");
  out = out.split("#").join("%23");
  return out;
}

/** Lenient percent-decode (mirrors Python urllib.unquote). */
export function dataDecode(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_m, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
}

// ---- Layer 2: replay= value ----------------------------------------------
export function replayEncode(readable: string): string {
  return readable.split("&").join("%26").split("#").join("%23").split("|").join("%7C");
}

export function replayDecode(stored: string): string {
  return stored.split("%26").join("&").split("%23").join("#").split("%7C").join("|");
}
