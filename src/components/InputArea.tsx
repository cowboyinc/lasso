import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { Separator } from "./Separator.js";

interface InputAreaProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isDisabled?: boolean;
}

export function InputArea({
  value,
  onChange,
  onSubmit,
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
            <Text color="green">{"cowboy> "}</Text>
            <TextInput
              value={value}
              onChange={onChange}
              onSubmit={onSubmit}
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
