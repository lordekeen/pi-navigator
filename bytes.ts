/**
 * UTF-8 byte-boundary helpers (Issue #172): one cap shared by the viewer's
 * capped file reads and the git commit reads, so a byte budget never splits
 * a code point.
 */

/** A byte that is a UTF-8 continuation (0b10xxxxxx). */
function isContinuation(byte: number): boolean {
  return byte >= 0x80 && byte < 0xc0;
}

/**
 * Truncate a UTF-8 byte buffer to at most `maxBytes` at a code-point
 * boundary, returning a subarray view.
 *
 * Two cuts need different alignment. A cut inside the buffer that lands on a
 * continuation byte steps back until the retained prefix ends at a sequence
 * boundary (the byte at the cut is a lead byte or ASCII). A cut at the
 * buffer's end has no such byte, so the final sequence is inspected instead
 * and dropped when incomplete (the capped-read case: `decodeUtf8Head`).
 * Deterministic and total: a buffer-end cut drops an incomplete final
 * sequence (its lead byte and any continuations present); stray malformed
 * bytes are otherwise left as read.
 */
export function truncateUtf8ToBytes(buffer: Buffer, maxBytes: number): Buffer {
  const end = Math.min(Math.max(0, maxBytes), buffer.length);
  if (end < buffer.length) {
    let cut = end;
    while (cut > 0 && isContinuation(buffer[cut] ?? 0)) cut -= 1;
    return buffer.subarray(0, cut);
  }
  if (end === 0) return buffer.subarray(0, 0);
  const last = buffer[end - 1] ?? 0;
  if (last < 0x80) return buffer.subarray(0, end);
  // Walk back over up to three continuation bytes to the sequence's lead.
  let lead = end - 1;
  let continuations = 0;
  while (lead >= 0 && isContinuation(buffer[lead] ?? 0) && continuations < 3) {
    lead -= 1;
    continuations += 1;
  }
  const leadByte = lead >= 0 ? buffer[lead] ?? 0 : 0;
  const needed = leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : leadByte >= 0xc0 ? 2 : 0;
  return buffer.subarray(0, needed > 0 && end - lead < needed ? lead : end);
}
