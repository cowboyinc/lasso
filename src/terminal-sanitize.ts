/**
 * Strip terminal control sequences from untrusted text before rendering in
 * the TUI. Model/agent output could otherwise emit ANSI/OSC escapes that
 * move the cursor, rewrite the window title, or write to the clipboard
 * (OSC 52) — classic terminal-injection tricks. Newlines and tabs are
 * preserved; everything else in C0 (including \r) is dropped.
 */
export function stripTerminalControl(text: string): string {
  return (
    text
      // OSC: ESC ] ... terminated by BEL or ST (ESC \)
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
      // Unterminated OSC swallows to end of text (streaming partials)
      .replace(/\x1b\][\s\S]*$/g, "")
      // CSI: ESC [ params, intermediates, final byte
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // Remaining lone ESC + single-char sequences
      .replace(/\x1b[@-_]?/g, "")
      // C0 controls except \t (x09) and \n (x0a); plus DEL
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
  );
}
