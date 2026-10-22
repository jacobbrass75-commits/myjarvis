// message.attributedBody: on recent macOS, Messages often leaves message.text NULL and keeps the words
// only here, as an NSArchiver "typedstream" of an NSAttributedString. The plain string follows the
// first NSString class record: `NSString` 01 94 84 01 `+` <length> <UTF-8 bytes>, where the length is
// one byte, or 0x81 + uint16 LE, or 0x82 + uint32 LE (typedstream integers).

/** The plain text inside an attributedBody blob, or null when there is none / it doesn't parse. */
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | null {
  if (!blob?.length) return null;
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const at = b.indexOf("NSString");
  if (at < 0) return null;
  // A few bytes of class info, then '+' starts the string.
  const plus = b.indexOf(0x2b, at + 8);
  if (plus < 0 || plus - (at + 8) > 16) return null;
  let i = plus + 1;
  if (i >= b.length) return null;
  let len = b[i++];
  if (len === 0x81) {
    if (i + 2 > b.length) return null;
    len = b.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    if (i + 4 > b.length) return null;
    len = b.readUInt32LE(i);
    i += 4;
  } else if (len > 0x7f) return null;
  if (i + len > b.length) return null;
  return b.subarray(i, i + len).toString("utf8");
}

/** Message text for the lens: attachment placeholders (U+FFFC) out, whitespace tidied. */
export const cleanText = (s: string) => s.replace(/￼/g, "").replace(/[ \t]+/g, " ").trim();
