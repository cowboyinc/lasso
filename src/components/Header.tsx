import React from "react";
import { Box, Text } from "ink";
import { Separator } from "./Separator.js";
import { LOGO_TEXT } from "../constants.js";

export function Header() {
  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text bold color="yellow">
          {LOGO_TEXT}
        </Text>
      </Box>
    </Box>
  );
}
