import React, { useState } from "react";
import { Box, Text } from "ink";
import { Separator } from "./Separator.js";
import { LineEditor } from "./LineEditor.js";
import { createEditorState } from "../editor-state.js";

interface InitFormProps {
  onComplete: (privateKey: string) => void;
  onCancel: () => void;
}

export function InitForm({ onComplete, onCancel }: InitFormProps) {
  const [buffer, setBuffer] = useState(() => createEditorState(""));

  const handleSubmit = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onComplete(trimmed);
  };

  return (
    <Box flexDirection="column">
      <Separator />
      <Box paddingX={1} flexDirection="column">
        <Text color="yellow">Enter your private key (press Enter empty to cancel):</Text>
        <Box>
          <Text color="green">{"key> "}</Text>
          <LineEditor
            value={buffer.value}
            cursorOffset={buffer.cursorOffset}
            onChange={setBuffer}
            onSubmit={handleSubmit}
            onCancel={onCancel}
            mask="*"
          />
        </Box>
      </Box>
      <Separator />
    </Box>
  );
}
