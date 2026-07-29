import React from "react";
import { Box, Text, useInput } from "ink";
import { Separator } from "./Separator.js";
import { stripTerminalControl } from "../terminal-sanitize.js";

interface SignatureApprovalProps {
  /** Human summary of the transaction being signed (from the backend preview). */
  summary: string;
  onApprove: () => void;
  onDeny: () => void;
}

/**
 * Blocking approval gate for a wallet signature (COW-2455 / COW-2463). The
 * backend agent can prepare a transaction, but lasso must NOT sign it on the
 * user's machine without the user seeing what it is and explicitly approving —
 * otherwise any agent turn (or a prompt-injected one) could authorize an
 * unintended on-chain tx. Rendered in place of the input while a signature is
 * pending, so it captures the keypress even though the turn is streaming.
 */
export function SignatureApproval({ summary, onApprove, onDeny }: SignatureApprovalProps) {
  useInput((input, key) => {
    // Ctrl+C during the prompt cancels the signature — the normal InputArea
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
          Signature required
        </Text>
        <Text>{stripTerminalControl(summary)}</Text>
        <Text>
          <Text color="green">y</Text> sign · <Text color="red">n</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}
