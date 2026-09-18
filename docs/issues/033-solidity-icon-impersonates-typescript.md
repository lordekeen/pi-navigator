# Issue #033 — Solidity Icon Impersonates the TypeScript Glyph

| Field | Value |
| :--- | :--- |
| ID | #033 |
| Title | `sol` extension mapped to the TypeScript Nerd Font codepoint by copy-paste |
| Type | Bug |
| Severity | Low |
| Component | `icons.ts` |
| Status | Resolved |

## Summary

The `EXT_ICONS` map in `icons.ts` contained `sol: "\ue628"` — the
**TypeScript** codepoint (`\ue628`, also used for `ts`). Solidity `.sol` files
therefore rendered with the TypeScript glyph, which is actively misleading
rather than merely unknown. There is no dedicated Solidity glyph in the curated
v1 Nerd Font subset.

## Root cause

Copy-paste when populating the map; the entry was never reviewed against the
Nerd Font glyph set.

## Fix

Removed the `sol` entry so `.sol` files fall back to `GENERIC_ICON`
(`\ue723`), consistent with every other unmapped language in the v1 subset.
Unmapped languages should read as "file", not borrow another language's icon.

## Tests

`test/icons.test.ts` — "does not impersonate another language's glyph for
unmapped languages (Issue #033)" asserts `mapExtensionToIcon("Token.sol")` and
`mapExtensionToIcon("contract.sol")` both return `GENERIC_ICON`. Verified to
fail against the pre-fix map (returned `\ue628`) and pass after the removal.
