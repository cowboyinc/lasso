import React from "react";
import { Box, Text } from "ink";
import { Separator } from "./Separator.js";
import { LineEditor } from "./LineEditor.js";
import { SuggestionList } from "./SuggestionList.js";
import type { EditorBuffer, SuggestionMenu } from "../types.js";

interface InputAreaProps {
  input: EditorBuffer;
  onChange: (buffer: EditorBuffer) => void;
  onSubmit: (value: string) => void;
  onAutocomplete?: () => void;
  onSuggestionNext?: () => void;
  onSuggestionPrevious?: () => void;
  onSuggestionAccept?: () => void;
  onSuggestionDismiss?: () => void;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  onActivity?: () => void;
  isDisabled?: boolean;
  suggestions?: SuggestionMenu | null;
}

export function InputArea({
  input,
  onChange,
  onSubmit,
  onAutocomplete,
  onSuggestionNext,
  onSuggestionPrevious,
  onSuggestionAccept,
  onSuggestionDismiss,
  onHistoryUp,
  onHistoryDown,
  onActivity,
  isDisabled,
  suggestions,
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
              onAutocomplete={onAutocomplete}
              onSuggestionNext={onSuggestionNext}
              onSuggestionPrevious={onSuggestionPrevious}
              onSuggestionAccept={onSuggestionAccept}
              onSuggestionDismiss={onSuggestionDismiss}
              onHistoryUp={onHistoryUp}
              onHistoryDown={onHistoryDown}
              onActivity={onActivity}
              placeholder="Type a command..."
              hasOpenSuggestions={Boolean(suggestions?.isOpen)}
            />
          </Box>
        )}
      </Box>
      {suggestions?.isOpen && <SuggestionList menu={suggestions} />}
      <Separator />
      <Box paddingX={1}>
        <Text dimColor>{">> Type exit to quit"}</Text>
      </Box>
    </Box>
  );
}
