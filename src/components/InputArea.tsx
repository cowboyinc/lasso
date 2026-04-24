import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Separator } from "./Separator.js";
import { LineEditor } from "./LineEditor.js";
import type { EditorBuffer } from "../types.js";
import { getSlashCommandSuggestions } from "../commands/index.js";
import { createEditorState } from "../editor-state.js";

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
  const hasTrailingWhitespace = /\s$/.test(input.value);
  const showSlashSuggestions =
    !isDisabled &&
    input.value.trimStart().startsWith("/") &&
    !hasTrailingWhitespace;
  const isSuggestionNavigationActive = showSlashSuggestions && slashSuggestions.length > 0;
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [input.value]);

  useEffect(() => {
    if (slashSuggestions.length === 0) {
      setSelectedSuggestionIndex(0);
      return;
    }
    setSelectedSuggestionIndex((prev) => Math.min(prev, slashSuggestions.length - 1));
  }, [slashSuggestions.length]);

  const applySuggestion = () => {
    const suggestion = slashSuggestions[selectedSuggestionIndex];
    if (!suggestion) return;
    onChange(createEditorState(`${suggestion.command} `));
  };

  const moveSuggestionUp = () => {
    if (slashSuggestions.length === 0) return;
    setSelectedSuggestionIndex((prev) =>
      prev === 0 ? slashSuggestions.length - 1 : prev - 1
    );
  };

  const moveSuggestionDown = () => {
    if (slashSuggestions.length === 0) return;
    setSelectedSuggestionIndex((prev) =>
      prev === slashSuggestions.length - 1 ? 0 : prev + 1
    );
  };

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
              onSuggestionUp={moveSuggestionUp}
              onSuggestionDown={moveSuggestionDown}
              onSuggestionAccept={applySuggestion}
              onActivity={onActivity}
              placeholder="/help for commands, or describe what you want to build..."
              isSuggestionNavigationActive={isSuggestionNavigationActive}
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
          {slashSuggestions.map((suggestion, index) => (
            <Box key={suggestion.command}>
              <Text color={index === selectedSuggestionIndex ? "yellow" : "cyan"}>
                {index === selectedSuggestionIndex ? "› " : "  "}
                {suggestion.command}
              </Text>
              <Text color={index === selectedSuggestionIndex ? "yellow" : undefined} dimColor={index !== selectedSuggestionIndex}>
                {"  "}{suggestion.description}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
