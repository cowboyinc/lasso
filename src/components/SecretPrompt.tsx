import React, { useState } from "react";
import { Box, Text } from "ink";
import { Separator } from "./Separator.js";
import { LineEditor } from "./LineEditor.js";
import { createEditorState } from "../editor-state.js";
import { stripTerminalControl } from "../terminal-sanitize.js";

interface SecretPromptProps {
  /** Secret name (already regex-validated upstream). */
  name: string;
  /** Optional backend-supplied reason — untrusted, rendered stripped. */
  reason?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** Masked capture for a secret value (COW-2469). The value never echoes to
 *  the terminal, never enters the message log, and never leaves the machine —
 *  it goes straight to the local secret store. Empty submit = cancel, so a
 *  stray Enter can't store an empty secret by accident. */
export function SecretPrompt({ name, reason, onSubmit, onCancel }: SecretPromptProps) {
  const [buffer, setBuffer] = useState(() => createEditorState(""));

  const handleSubmit = (input: string) => {
    if (input.length === 0) {
      onCancel();
      return;
    }
    onSubmit(input);
  };

  return (
    <Box flexDirection="column">
      <Separator />
      <Box paddingX={1} flexDirection="column">
        <Text color="yellow" bold>
          Secret required: {stripTerminalControl(name)}
        </Text>
        {reason ? <Text dimColor>{stripTerminalControl(reason)}</Text> : null}
        <Text dimColor>
          The value is stored locally (keychain / .cowboy) and never leaves this
          machine. Enter on an empty line cancels.
        </Text>
        <Box>
          <Text color="green">{"value> "}</Text>
          <LineEditor
            value={buffer.value}
            cursorOffset={buffer.cursorOffset}
            onChange={setBuffer}
            onSubmit={handleSubmit}
            onCancel={onCancel}
            onInterrupt={onCancel}
            mask="•"
          />
        </Box>
      </Box>
      <Separator />
    </Box>
  );
}
