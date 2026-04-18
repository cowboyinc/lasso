import React from "react";
import { Box, Text } from "ink";
import { Separator } from "./Separator.js";
import { LineEditor } from "./LineEditor.js";
import type { EditorBuffer } from "../types.js";
import { getSlashCommandSuggestions } from "../commands/index.js";

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
  const slashSuggestions = getSlashCommandSuggestions(input.value, 10);
  const showSlashSuggestions = !isDisabled && input.value.trimStart().startsWith("/");

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
              placeholder="/help for commands, or describe what you want to build..."
            />
          </Box>
        )}
      </Box>
      <Separator />
      {showSlashSuggestions ? (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>
            {slashSuggestions.length > 0
              ? `>> Commands (${slashSuggestions.length}) · edit descriptions in src/commands/index.ts`
              : ">> No matching slash commands"}
          </Text>
          {slashSuggestions.map((suggestion) => (
            <Box key={suggestion.command}>
              <Text color="cyan">{suggestion.command}</Text>
              <Text dimColor>{"  "}{suggestion.description}</Text>
            </Box>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>{">> Slash commands start with / · Plain text submits an AI job · /exit quits"}</Text>
          <Text dimColor>{"   Try: /runner list  /actor deploy actors/hello/main.py  build me an escrow actor with retries"}</Text>
        </Box>
      )}
    </Box>
  );
}
