import React from "react";
import { Box, Text, useInput } from "ink";
import { Separator } from "./Separator.js";
import { stripTerminalControl } from "../terminal-sanitize.js";

interface ApprovalPromptProps {
  /** Short headline for what is being approved (client-derived, not the raw
   *  backend text) — e.g. "Signature required" or "Allow local_read_file?". */
  title: string;
  /** Details to show the user before they decide. Sanitized before render:
   *  it may include backend-provided text, which is untrusted. */
  summary: string;
  /** Verb shown for the approve key (default "allow"), e.g. "sign". */
  approveLabel?: string;
  /** Verb shown for the deny key (default "deny"), e.g. "cancel". */
  denyLabel?: string;
  onApprove: () => void;
  onDeny: () => void;
}

/**
 * Blocking approval gate for a sensitive local action (COW-2463). lasso runs on
 * the user's machine with their wallet, so the backend agent can PREPARE an
 * action (sign a hash, write a file, run a command) but lasso must not perform
 * it without the user seeing what it is and explicitly approving — otherwise any
 * agent turn (or a prompt-injected one) could authorize something unintended.
 *
 * Generalized from the signing-only prompt so every permission class routes
 * through the same affordance. Rendered in place of the input while an approval
 * is pending, so it captures the keypress even though the turn is streaming.
 */
export function ApprovalPrompt({
  title,
  summary,
  approveLabel = "allow",
  denyLabel = "deny",
  onApprove,
  onDeny,
}: ApprovalPromptProps) {
  useInput((input, key) => {
    // Ctrl+C during the prompt denies the action — the normal InputArea
    // interrupt path is unmounted while this affordance is shown, and the app
    // runs with exitOnCtrlC disabled, so handle it here.
    if (key.ctrl && input === "c") {
      onDeny();
      return;
    }
    if (input === "y" || input === "Y") {
      onApprove();
      return;
    }
    if (input === "n" || input === "N" || key.escape) {
      onDeny();
    }
  });

  return (
    <Box flexDirection="column">
      <Separator />
      <Box paddingX={1} flexDirection="column">
        <Text bold color="yellow">
          {stripTerminalControl(title)}
        </Text>
        <Text>{stripTerminalControl(summary)}</Text>
        <Text>
          <Text color="green">y</Text> {approveLabel} · <Text color="red">n</Text> {denyLabel}
        </Text>
      </Box>
    </Box>
  );
}
