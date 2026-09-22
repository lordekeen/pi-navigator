# Issue #070: Kitty Protocol Bypass of Tmux Guard Causes Terminal Freeze/Crash

- **Status**: Resolved
- **Type**: Bug
- **Severity**: High
- **Component**: [`images.ts`](file:///home/jhonny/Sources/pi-navigator/images.ts#L770-L791), [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts#L289-L300)

---

## Description

pi-tui's capability detection ([`terminal-image.js` L44-46](file:///home/jhonny/Sources/pi-navigator/node_modules/@earendil-works/pi-tui/dist/terminal-image.js#L44-L46)) disables image protocols under tmux by returning `images: null`:

```javascript
// Image protocols are unreliable under tmux, so leave `images: null`.
if (process.env.TMUX || term.startsWith("tmux")) {
    return { images: null, ... };
}
```

However, [`resolveNativeProtocol`](file:///home/jhonny/Sources/pi-navigator/images.ts#L770-L791) in `pi-navigator` uses a 3-step ladder:
1. `capabilities().images` — reads the pi-tui cache (returns `null` under tmux).
2. `settings.json` → `terminal.images` — if configured as `"kitty"`, returns `"kitty"` **without checking for tmux**.
3. `PI_IMAGE_PROTOCOL` env var — if set to `kitty`, returns `"kitty"` **without checking for tmux**.

When running inside tmux with either `terminal.images: "kitty"` in settings or `PI_IMAGE_PROTOCOL=kitty` in the environment, `resolveNativeProtocol` returns `"kitty"`. This causes [`resolveImageSupport`](file:///home/jhonny/Sources/pi-navigator/images.ts#L1012-L1053) to set `tier = "native"`, leading to raw kitty APC escape sequences (`\x1b_G...`) being emitted directly into the tmux PTY. tmux does not handle these sequences without specialized passthrough configuration, causing pane hangs, input freezes, or garbled screen state.

## Reproduction Steps

1. Launch pi inside a tmux session (`TMUX` env var is set).
2. Configure `~/.pi/agent/settings.json` with `"terminal": { "images": "kitty" }` or export `PI_IMAGE_PROTOCOL=kitty`.
3. Open `/navigator` and select any PNG image file.
4. Observe the terminal: the pane either freezes/hangs or emits unparsed escape sequences into the terminal buffer.

## Root Cause Analysis

[`resolveNativeProtocol`](file:///home/jhonny/Sources/pi-navigator/images.ts#L770-L791) inspects host settings and `PI_IMAGE_PROTOCOL` directly after step 1 without enforcing a tmux check:

```typescript
export function resolveNativeProtocol(deps?: {
  capabilities?: () => { images: NativeProtocol | null };
  readText?: ReadText;
  env?: Record<string, string | undefined>;
  userSettings?: string;
}): NativeProtocol | null {
  const caps = deps?.capabilities?.().images;
  if (caps !== null && caps !== undefined) return caps;
  if (deps?.userSettings !== undefined) {
    const fromSettings = readHostImageSettings(
      { userSettings: deps.userSettings },
      { readText: deps?.readText },
    ).images;
    if (fromSettings !== null) return fromSettings;
  }
  const envProtocol = (deps?.env ?? process.env)["PI_IMAGE_PROTOCOL"];
  if (typeof envProtocol === "string") {
    const trimmed = envProtocol.trim();
    if (trimmed === "kitty" || trimmed === "iterm2") return trimmed;
  }
  return null;
}
```

Because step 2 and step 3 do not check `process.env.TMUX` or `process.env.TERM`, the tmux guard from pi-tui is bypassed.

## Potential Solution

Add a tmux/screen guard in [`resolveNativeProtocol`](file:///home/jhonny/Sources/pi-navigator/images.ts#L770-L791) before evaluating host settings or `PI_IMAGE_PROTOCOL`:

```typescript
const env = deps?.env ?? process.env;
const term = (env["TERM"] ?? "").toLowerCase();
const isMultiplexer = Boolean(env["TMUX"] || term.startsWith("tmux") || term.startsWith("screen"));
if (isMultiplexer) {
  return null;
}
```

Additionally, ensure [`runNativeRender`](file:///home/jhonny/Sources/pi-navigator/images.ts#L840) defensively refuses to emit protocol sequences if tmux is detected.

## Acceptance Criteria

- [x] [`resolveNativeProtocol`](file:///home/jhonny/Sources/pi-navigator/images.ts#L770-L791) returns `null` when `TMUX` is set or `TERM` starts with `tmux`/`screen`, regardless of user settings or `PI_IMAGE_PROTOCOL`.
- [x] When running in tmux, image support gracefully degrades to chafa (if available) or metadata card.
- [x] Unit tests in [`test/images.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/images.test.ts) cover tmux environment detection and degradation.
- [x] `npm run typecheck` and `npm test` pass.

## Resolution

Added a terminal multiplexer guard to `resolveNativeProtocol` in `images.ts` checking for `TMUX` environment variable or `TERM` starting with `tmux` or `screen`. If a multiplexer is detected, `resolveNativeProtocol` returns `null` before consulting user settings or `PI_IMAGE_PROTOCOL`, gracefully falling back to chafa or the metadata card. Additionally added a defensive check in `runNativeRender`. Verified with automated test cases in `test/images.test.ts`.
