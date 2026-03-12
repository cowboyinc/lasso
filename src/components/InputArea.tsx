import React from "react";
import { Box, Text } from "ink";
import { Separator } from "./Separator.js";
import { LineEditor } from "./LineEditor.js";
import type { EditorBuffer } from "../types.js";

interface InputAreaProps {
  input: EditorBuffer;
  onChange: (buffer: EditorBuffer) => void;
  onSubmit: (value: string) => void;
  onInterrupt?: () => void;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  onActivity?: () => void;
  isDisabled?: boolean;
}

export function InputArea({
  input,
  onChange,
  onSubmit,
  onInterrupt,
  onHistoryUp,
  onHistoryDown,
  onActivity,
  isDisabled,
}: InputAreaProps) {
  return (
    <Box flexDirection="column">
      <Separator />
      <Box paddingX={1}>
        {isDisabled ? (
          <Text dimColor>Executing...</Text>
        ) : (
          <Box>
            <Text color="green">{"\u276F "}</Text>
            <LineEditor
              value={input.value}
              cursorOffset={input.cursorOffset}
              onChange={onChange}
              onSubmit={onSubmit}
              onInterrupt={onInterrupt}
              onHistoryUp={onHistoryUp}
              onHistoryDown={onHistoryDown}
              onActivity={onActivity}
              placeholder="Type a command..."
            />
          </Box>
        )}
      </Box>
      <Separator />
      <Box paddingX={1}>
        <Text dimColor>{">> Type exit to quit"}</Text>
      </Box>
    </Box>
  );
}
