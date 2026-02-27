import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { Separator } from "./Separator.js";

interface InitFormProps {
  onComplete: (privateKey: string) => void;
  onCancel: () => void;
}

export function InitForm({ onComplete, onCancel }: InitFormProps) {
  const [value, setValue] = useState("");

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
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            mask="*"
          />
        </Box>
      </Box>
      <Separator />
    </Box>
  );
}
