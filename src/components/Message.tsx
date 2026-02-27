import React from "react";
import { Box, Text } from "ink";
import type { ConsoleMessage } from "../types.js";

interface MessageProps {
  message: ConsoleMessage;
}

export function Message({ message }: MessageProps) {
  switch (message.role) {
    case "command":
      return (
        <Box paddingX={1}>
          <Text color="gray">{"cowboy> "}{message.content}</Text>
        </Box>
      );

    case "output":
      return (
        <Box paddingX={1}>
          <Text>{message.content}</Text>
        </Box>
      );

    case "error":
      return (
        <Box paddingX={1}>
          <Text color="red">{message.content}</Text>
        </Box>
      );

    case "system":
      return (
        <Box paddingX={1}>
          <Text color="yellow">{message.content}</Text>
        </Box>
      );
  }
}
