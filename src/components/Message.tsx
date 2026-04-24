import React from "react";
import { Box, Text } from "ink";
import type { ConsoleMessage } from "../types.js";

interface MessageProps {
  message: ConsoleMessage;
}

/**
 * Render a line of text with basic inline markdown:
 * **bold**, `inline code`, and plain text.
 */
function renderMarkdownLine(line: string, key: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = line;
  let i = 0;

  while (remaining.length > 0) {
    // Bold: **text**
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)/s);
    if (boldMatch) {
      if (boldMatch[1]) parts.push(<Text key={`${key}-${i++}`}>{boldMatch[1]}</Text>);
      parts.push(<Text key={`${key}-${i++}`} bold>{boldMatch[2]}</Text>);
      remaining = boldMatch[3];
      continue;
    }

    // Inline code: `text`
    const codeMatch = remaining.match(/^(.*?)`(.+?)`(.*)/s);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(<Text key={`${key}-${i++}`}>{codeMatch[1]}</Text>);
      parts.push(<Text key={`${key}-${i++}`} color="cyan">{codeMatch[2]}</Text>);
      remaining = codeMatch[3];
      continue;
    }

    // No more matches — emit rest as plain text
    parts.push(<Text key={`${key}-${i++}`}>{remaining}</Text>);
    break;
  }

  return <Text key={key}>{parts}</Text>;
}

/**
 * Render text with markdown code blocks and inline formatting.
 * Collapses consecutive empty lines into a single blank line.
 */
function renderMarkdown(content: string): React.ReactNode {
  const rawLines = content.split("\n");

  // Collapse consecutive empty lines
  const lines: string[] = [];
  let lastWasEmpty = false;
  for (const line of rawLines) {
    const isEmpty = line.trim() === "";
    if (isEmpty && lastWasEmpty) continue;
    lines.push(line);
    lastWasEmpty = isEmpty;
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  const parts: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  const elements: React.ReactNode[] = [];
  let codeKey = 0;

  function flushText() {
    if (parts.length > 0) {
      const text = parts.join("\n");
      elements.push(renderMarkdownLine(text, `text-${elements.length}`));
      parts.length = 0;
    }
  }

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        flushText();
        elements.push(
          <Box key={`code-${codeKey++}`} flexDirection="column" paddingX={1}>
            {codeLines.map((cl, ci) => (
              <Text key={ci} color="green">{cl}</Text>
            ))}
          </Box>
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        flushText();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
    } else {
      parts.push(line);
    }
  }

  // Flush remaining
  if (inCodeBlock && codeLines.length > 0) {
    flushText();
    elements.push(
      <Box key={`code-${codeKey}`} flexDirection="column" paddingX={1}>
        {codeLines.map((cl, ci) => (
          <Text key={ci} color="green">{cl}</Text>
        ))}
      </Box>
    );
  } else {
    flushText();
  }

  return <>{elements}</>;
}

export function Message({ message }: MessageProps) {
  switch (message.role) {
    case "command":
      return (
        <Box paddingX={1}>
          <Text color="gray" backgroundColor="#1a1a1a">{" \u276F "}{message.content}{" "}</Text>
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
