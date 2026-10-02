/**
 * Help modal layout (Issue #064 view-model extraction).
 *
 * Pure functions of plain inputs: how many help rows fit, the scroll limit,
 * and the modal composition. NavigatorOverlay keeps the helpScroll state,
 * clamps it, and passes the clamped offset in — the modal is written into
 * the caller's line buffer exactly as before.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

import type { NavigatorTheme } from "./theme";
import { hardTruncate } from "./viewer";
import { padTo } from "./frame";

/** Help rows that fit. Shared by the input clamp and the renderer. */
export function helpVisibleRows(body: number, helpRowsLength: number): number {
  return Math.min(helpRowsLength, Math.max(1, body - 4));
}

/** Single source of truth for the help scroll limit. */
export function helpMaxScroll(helpRowsLength: number, visibleRows: number): number {
  return Math.max(0, helpRowsLength - visibleRows);
}

export interface HelpView {
  theme: NavigatorTheme;
  /** The modal's key/description rows (HELP_ROWS projection). */
  helpRows: readonly [string, string][];
  /** Already-clamped scroll offset (the caller owns the stored helpScroll). */
  helpScroll: number;
}

/**
 * Compose the in-overlay `?` modal into `lines` (3-row chrome + body).
 *
 * Deliberately has no in-box footer stating its own keys: while the modal is
 * open the overlay's footer row switches to `MODE_HINTS.help` ("j k scroll
 * PgUp/PgDn page  Home/End top/bottom  q Esc ? close help"), so the modal's
 * keys are stated one row below the box instead of inside it — a documented
 * exception to the "state your own keys in-frame" rule (Issue #135 L2). The
 * body stops before the last line so that footer is never occluded.
 */
export function composeHelp(lines: string[], innerW: number, body: number, view: HelpView): void {
  const T = view.theme;
  // Key cell width derived from the table (longest key string + one separator
  // cell) so a longer label cannot silently overflow the description column
  // (Issue #132).
  const keyW = Math.max(1, ...view.helpRows.map(([keys]) => visibleWidth(keys))) + 1;
  // Grow the box to the width the rows actually need, capped by the terminal.
  // A fixed 66-cell cap cut the longest row's meaning even on a wide terminal
  // (#132); where the terminal is still narrower the cut stays clean (#010).
  const descNeeded = Math.max(0, ...view.helpRows.map(([, description]) => visibleWidth(description)));
  const boxW = Math.min(innerW - 2, Math.max(66, 4 + keyW + descNeeded));
  const visibleRows = helpVisibleRows(body, view.helpRows.length);
  const boxH = visibleRows + 3;
  const startRow = Math.max(0, Math.floor((body - boxH) / 2));
  const colPad = Math.max(0, Math.floor((innerW - boxW) / 2));
  const scroll = view.helpScroll;

  const modal: string[] = [];
  const inner = (text: string) => {
    const padded = padTo(text, boxW - 2);
    return T.frame("\u2502") + padded + T.frame("\u2502");
  };
  modal.push(T.frame("\u250c" + "\u2500".repeat(boxW - 2) + "\u2510"));
  modal.push(inner(" " + T.accent(T.bold("pi-navigator \u2014 keys"))));
  for (let i = 0; i < visibleRows; i++) {
    const row = view.helpRows[scroll + i];
    if (!row) {
      modal.push(inner(""));
      continue;
    }
    const [keys, description] = row;
    const keyCell = T.accent(keys.padEnd(keyW));
    // Row layout is " " + keyCell(keyW) + " " + descCell inside the boxW-2
    // inner area, so the description gets boxW - 4 - keyW columns.
    // hardTruncate gives the clean cut (Issue #010); strip whatever reset it
    // injected and append our own ellipsis so the indicator stays inside the
    // muted style.
    const descWidth = boxW - 4 - keyW;
    let descCell = description;
    if (visibleWidth(description) > descWidth) {
      const cut = hardTruncate(description, Math.max(1, descWidth - 1)).replace(/\x1b\[[0-9;]*m/g, "");
      descCell = cut + "\u2026";
    }
    modal.push(inner(" " + keyCell + " " + T.muted(descCell)));
  }
  modal.push(T.frame("\u2514" + "\u2500".repeat(boxW - 2) + "\u2518"));

  for (let i = 0; i < modal.length; i++) {
    const target = 3 + startRow + i; // lines[0..2] are top, title, separator
    if (target >= lines.length - 1) break;
    const modalRow = modal[i];
    if (modalRow === undefined) continue;
    const rowInner = " ".repeat(colPad) + modalRow + " ".repeat(Math.max(0, innerW - colPad - visibleWidth(modalRow)));
    lines[target] = T.frame("\u2502") + padTo(rowInner, innerW) + T.frame("\u2502");
  }
}