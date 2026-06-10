import React from "react";
import { Box, Text } from "ink";
import type { ConsoleMessage } from "../types.js";
import { parseMarkdown } from "../markdown.js";
import type { InlineSpan, MdBlock } from "../markdown.js";

// Styling rule for this file: named ANSI styles only — never hex
// backgrounds. They don't adapt to the user's terminal theme (a hardcoded
// #1a1a1a background made command echoes unreadable on light themes).

interface MessageProps {
  message: ConsoleMessage;
}

function renderSpans(spans: InlineSpan[]): React.ReactNode {
  return spans.map((span, i) => {
    switch (span.style) {
      case "bold":
        return (
          <Text key={i} bold>
            {span.text}
          </Text>
        );
      case "italic":
        return (
          <Text key={i} italic>
            {span.text}
          </Text>
        );
      case "code":
        return (
          <Text key={i} color="cyan">
            {span.text}
          </Text>
        );
      default:
        return <Text key={i}>{span.text}</Text>;
    }
  });
}

function renderBlock(block: MdBlock, key: number): React.ReactNode {
  switch (block.kind) {
    case "heading":
      return (
        <Text key={key} bold color="cyan">
          {renderSpans(block.spans)}
        </Text>
      );
    case "bullet":
      return (
        <Text key={key}>
          {" ".repeat(block.indent)}• {renderSpans(block.spans)}
        </Text>
      );
    case "ordered":
      return (
        <Text key={key}>
          {" ".repeat(block.indent)}
          {block.number}. {renderSpans(block.spans)}
        </Text>
      );
    case "quote":
      return (
        <Text key={key} dimColor italic>
          {renderSpans(block.spans)}
        </Text>
      );
    case "hr":
      return (
        <Text key={key} dimColor>
          {"─".repeat(20)}
        </Text>
      );
    case "code":
      return (
        <Box key={key} flexDirection="column" paddingX={1}>
          {block.lines.map((cl, ci) => (
            <Text key={ci} color="green">
              {cl}
            </Text>
          ))}
        </Box>
      );
    case "blank":
      return <Text key={key}> </Text>;
    case "paragraph":
      return <Text key={key}>{renderSpans(block.spans)}</Text>;
  }
}

function renderMarkdown(content: string): React.ReactNode {
  return <>{parseMarkdown(content).map((block, i) => renderBlock(block, i))}</>;
}

export function Message({ message }: MessageProps) {
  switch (message.role) {
    case "command":
      return (
        <Box paddingX={1}>
          <Text dimColor>
            {"❯ "}
            {message.content}
          </Text>
        </Box>
      );

    case "output":
      return (
        <Box paddingX={1} flexDirection="column">
          {renderMarkdown(message.content)}
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
