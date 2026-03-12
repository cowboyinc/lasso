import React from "react";
import { Box, Text } from "ink";
import type { SuggestionMenu } from "../types.js";

interface SuggestionListProps {
  menu: SuggestionMenu;
}

export function SuggestionList({ menu }: SuggestionListProps) {
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={3}>
      {menu.candidates.map((candidate, index) => {
        const isActive = index === menu.activeIndex;
        return (
          <Box key={`${candidate.kind}:${candidate.value}`}>
            <Text color={isActive ? "green" : undefined}>
              {isActive ? "\u276F " : "  "}
            </Text>
            <Text inverse={isActive}>{candidate.label}</Text>
            {candidate.detail ? <Text dimColor>{`  ${candidate.detail}`}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
