import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export function ThinkingSpinner() {
  return (
    <Box paddingX={1}>
      <Text color="yellow">
        <Spinner type="dots" />
      </Text>
      <Text color="yellow"> Executing...</Text>
    </Box>
  );
}
