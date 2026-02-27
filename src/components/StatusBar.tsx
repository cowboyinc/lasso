import React from "react";
import { Box, Text } from "ink";
import { VERSION } from "../constants.js";

interface StatusBarProps {
  validatorUrl: string;
  hasKey: boolean;
}

export function StatusBar({ validatorUrl, hasKey }: StatusBarProps) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>
        Network: <Text color="cyan">{validatorUrl}</Text>
        {"  "}|{"  "}
        Key: <Text color={hasKey ? "green" : "red"}>{hasKey ? "set" : "not set"}</Text>
      </Text>
      <Text dimColor>v{VERSION}</Text>
    </Box>
  );
}
