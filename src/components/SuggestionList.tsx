import React from "react";
import { stripVTControlCharacters } from "node:util";
import { Box, Text } from "ink";
import type { SuggestionMenu } from "../types.js";

interface SuggestionListProps {
  menu: SuggestionMenu;
}

function sanitizeTerminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f]/g, "");
}

export function SuggestionList({ menu }: SuggestionListProps) {
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={3}>
      {menu.candidates.map((candidate, index) => {
        const isActive = index === menu.activeIndex;
        const label = sanitizeTerminalText(candidate.label);
        const detail = candidate.detail ? sanitizeTerminalText(candidate.detail) : undefined;
        return (
          <Box key={`${candidate.kind}:${candidate.value}`}>
            <Text color={isActive ? "green" : undefined}>
              {isActive ? "\u276F " : "  "}
            </Text>
            <Text inverse={isActive}>{label}</Text>
            {detail ? <Text dimColor>{`  ${detail}`}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
