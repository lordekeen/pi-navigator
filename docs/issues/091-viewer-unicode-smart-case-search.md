# Issue #091: Smart-Case Search Fails to Detect Non-ASCII Unicode Uppercase Characters

- **Status**: Resolved
- **Type**: Bug
- **Severity**: Medium
- **Component**: [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L168), [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L550), [`test/viewer.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/viewer.test.ts#L163-L166)

---

## Description

In [`viewer.ts` L168](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L168) and [L550](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L550), smart-case search detection uses an ASCII-only regular expression:

```typescript
const smartCase = /[A-Z]/.test(query);
```

Because `/[A-Z]/` only matches Latin ASCII characters `A` through `Z`, any query containing non-ASCII uppercase characters (e.g. Turkish `İ` U+0130, accented letters like `É`, `Ü`, `Ñ`, Greek `Ω`, or Cyrillic `Ж`) evaluates to `smartCase = false`.

When `smartCase` is `false`, the search query is lowercased and executed case-insensitively, violating the core contract of smart-case search (which states that any uppercase letter in the query triggers case-sensitive matching).

Furthermore, in [`test/viewer.test.ts` L163-166](file:///home/jhonny/Sources/pi-navigator/test/viewer.test.ts#L163-L166):
```typescript
  it("uses needle.length when lowercased query has different length (Issue #035)", () => {
    // Turkish dotted capital I (\u0130, length 1) lowercases to i + combining dot (\u0069\u0307, length 2)
    expect(markMatches("a\u0069\u0307b", "\u0130", match, current, -1)).toBe("a<m>\u0069\u0307</m>b");
  });
```
This test passes only because `/[A-Z]/` fails to recognize `\u0130` as uppercase, falling back to case-insensitive matching. If smart-case correctly identified `\u0130` as uppercase, the query would remain uppercase and fail to match the lowercase `\u0069\u0307` in the haystack.

## Root Cause Analysis

ASCII-only character class `/[A-Z]/` without Unicode property support (`/\p{Lu}/u` or `/\p{Uppercase_Letter}/u`).

## Potential Solution

Replace `/[A-Z]/` with a Unicode-aware check in both [`markMatches`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L168) and [`searchLines`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L550):

```typescript
const smartCase = /\p{Lu}/u.test(query);
```
Or check if lowercasing changes the string: `query.toLowerCase() !== query`.

Update [`test/viewer.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/viewer.test.ts) to test case-sensitivity on Unicode uppercase characters and ensure needle length testing uses an appropriate fixture.

## Acceptance Criteria

- [x] Queries containing non-ASCII uppercase characters trigger case-sensitive search.
- [x] Queries containing only lowercase characters remain case-insensitive.
- [x] Unit tests verify Unicode smart-case behavior across accented and non-Latin alphabets.
- [x] `npm run typecheck` and `npm test` pass.

## Resolution

Updated `markMatches` and `searchLines` in `viewer.ts` to use `/\p{Lu}/u.test(query)` for Unicode-aware uppercase detection. Smart-case search now activates case-sensitive matching for non-ASCII Unicode uppercase characters (such as Cyrillic, Greek, accented Latin). Verified with automated tests in `test/viewer.test.ts`.
