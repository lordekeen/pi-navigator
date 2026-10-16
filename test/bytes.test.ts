/**
 * bytes.ts suites: `truncateUtf8ToBytes` lives with the viewer caps (see
 * viewer.test.ts); this suite covers the strict decoder added for Issue #220 —
 * the UTF-8 validity gate git's `-z` path listings pass through.
 */

import { describe, expect, it } from "vitest";

import { decodeStrictUtf8 } from "../bytes";

describe("decodeStrictUtf8 (Issue #220)", () => {
  /** What a latin1-decoded raw read yields for the given UTF-8 text. */
  const latin1 = (text: string): string => Buffer.from(text, "utf8").toString("latin1");

  it("round-trips valid UTF-8 bytes to their text", () => {
    expect(decodeStrictUtf8(latin1("ümlaut.txt"))).toBe("ümlaut.txt");
    expect(decodeStrictUtf8(latin1("plain/path.txt"))).toBe("plain/path.txt");
    expect(decodeStrictUtf8("")).toBe("");
    // A newline in a path is text, not a delimiter here (records are NUL-split).
    expect(decodeStrictUtf8(latin1("line\nbreak.txt"))).toBe("line\nbreak.txt");
  });

  it("rejects a lone 0xFF byte as text", () => {
    // Not a valid UTF-8 byte sequence: 0xFF is never a lead or continuation.
    const raw = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74]).toString("latin1");
    expect(decodeStrictUtf8(raw)).toBeNull();
  });
});
