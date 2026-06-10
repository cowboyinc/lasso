import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Separator } from "./Separator.js";
import { WALKTHROUGH_LESSONS } from "../walkthrough.js";

interface WalkthroughPagerProps {
  initialLesson: number;
  onExit: (completed: boolean) => void;
}

export function WalkthroughPager({ initialLesson, onExit }: WalkthroughPagerProps) {
  const lessonCount = WALKTHROUGH_LESSONS.length;
  const clamp = (n: number) => Math.min(Math.max(n, 0), lessonCount - 1);
  const [index, setIndex] = useState(() => clamp(initialLesson - 1));

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      onExit(false);
      return;
    }
    if (key.return || input === " " || input === "n" || key.rightArrow) {
      if (index === lessonCount - 1) {
        onExit(true);
      } else {
        setIndex((i) => clamp(i + 1));
      }
      return;
    }
    if (input === "p" || key.leftArrow) {
      setIndex((i) => clamp(i - 1));
      return;
    }
    if (/^[1-9]$/.test(input)) {
      setIndex(clamp(Number(input) - 1));
    }
  });

  const lesson = WALKTHROUGH_LESSONS[index];

  return (
    <Box flexDirection="column">
      <Separator />
      <Box paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          {`How Cowboy Works  -  Lesson ${index + 1}/${lessonCount}: ${lesson.title}`}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>{lesson.body}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            {index === lessonCount - 1
              ? "enter finish   p prev   1-9 jump   q quit"
              : "enter next   p prev   1-9 jump   q quit"}
          </Text>
        </Box>
      </Box>
      <Separator />
    </Box>
  );
}
