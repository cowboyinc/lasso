import React from "react";
import { Box, Text } from "ink";
import { Separator } from "./Separator.js";
import { getLogoText } from "../constants.js";

export function Header() {
  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text bold color="yellow">
          {getLogoText()}
        </Text>
      </Box>
    </Box>
  );
}
