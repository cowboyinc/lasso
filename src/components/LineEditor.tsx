import React, { useEffect } from "react";
import { Text, useStdin } from "ink";
import type { EditorBuffer, LineEditorProps } from "../types.js";
import { applyEditorAction, createEditorState, resolveKeypressAction } from "../editor-state.js";

export function LineEditor({
  value,
  cursorOffset,
  onChange,
  onSubmit,
  onCancel,
  onAutocomplete,
  onSuggestionNext,
  onSuggestionPrevious,
  onSuggestionAccept,
  onSuggestionDismiss,
  onHistoryUp,
  onHistoryDown,
  onActivity,
  placeholder,
  mask,
  isDisabled,
  hasOpenSuggestions,
}: LineEditorProps) {
  const { setRawMode, internal_eventEmitter } = useStdin();

  useEffect(() => {
    if (cursorOffset > value.length) {
      onChange(createEditorState(value));
    }
  }, [cursorOffset, onChange, value]);

  useEffect(() => {
    setRawMode(true);
    return () => {
      setRawMode(false);
    };
  }, [setRawMode]);

  useEffect(() => {
    const handleData = (data: string) => {
      if (isDisabled) return;

      const { input, key, sequence } = parseInput(data);

      if (hasOpenSuggestions && (key.return || input === "\r" || input === "\n")) {
        onSuggestionAccept?.();
        return;
      }

      if (key.return || input === "\r" || input === "\n") {
        onSubmit(value);
        return;
      }

      if (key.escape) {
        if (hasOpenSuggestions) {
          onSuggestionDismiss?.();
          return;
        }
        onCancel?.();
        return;
      }

      if (key.tab) {
        if (hasOpenSuggestions) {
          if (key.shift) {
            onSuggestionPrevious?.();
          } else {
            onSuggestionNext?.();
          }
        } else {
          onAutocomplete?.();
        }
        onActivity?.();
        return;
      }

      if (hasOpenSuggestions && key.upArrow) {
        onActivity?.();
        onSuggestionPrevious?.();
        return;
      }

      if (hasOpenSuggestions && key.downArrow) {
        onActivity?.();
        onSuggestionNext?.();
        return;
      }

      if (key.upArrow && onHistoryUp) {
        onActivity?.();
        onHistoryUp();
        return;
      }

      if (key.downArrow && onHistoryDown) {
        onActivity?.();
        onHistoryDown();
        return;
      }

      const action = resolveKeypressAction(input, key, sequence);
      if (action) {
        const nextState = applyEditorAction({ value, cursorOffset }, action);
        if (
          nextState.value !== value ||
          nextState.cursorOffset !== cursorOffset
        ) {
          onChange(nextState);
        }
        onActivity?.();
        return;
      }

      if (!key.ctrl && !key.meta && !key.tab && input) {
        onChange(applyEditorAction({ value, cursorOffset }, { type: "insert", text: input }));
        onActivity?.();
      }
    };

    internal_eventEmitter.on("input", handleData);
    return () => {
      internal_eventEmitter.removeListener("input", handleData);
    };
  }, [
    cursorOffset,
    internal_eventEmitter,
    isDisabled,
    hasOpenSuggestions,
    onActivity,
    onAutocomplete,
    onCancel,
    onChange,
    onHistoryDown,
    onHistoryUp,
    onSuggestionAccept,
    onSuggestionDismiss,
    onSuggestionNext,
    onSuggestionPrevious,
    onSubmit,
    value,
  ]);

  return renderEditor({ value, cursorOffset, placeholder, mask });
}

export function parseInput(data: string) {
  const keypress = parseRawKeypress(data);
  const key = {
    upArrow: keypress.name === "up",
    downArrow: keypress.name === "down",
    leftArrow: keypress.name === "left",
    rightArrow: keypress.name === "right",
    home: keypress.name === "home",
    end: keypress.name === "end",
    return: keypress.name === "return" || keypress.name === "enter",
    escape: keypress.name === "escape",
    ctrl: keypress.ctrl,
    tab: keypress.name === "tab",
    shift: keypress.shift,
    backspace: keypress.name === "backspace",
    delete: keypress.name === "delete",
    meta: keypress.meta || keypress.name === "escape" || keypress.option,
    super: keypress.super ?? false,
  };

  let input: string;

  if (keypress.ctrl) {
    input = keypress.name;
  } else {
    input = keypress.sequence;
  }

  if (NON_ALPHANUMERIC_KEYS.includes(keypress.name)) {
    input = "";
  }

  if (input.startsWith("\u001B")) {
    input = input.slice(1);
  }

  return {
    input,
    key,
    sequence: keypress.sequence,
  };
}

function parseRawKeypress(sequence: string) {
  const parsedControl = parseControlSequence(sequence);
  if (parsedControl) {
    return parsedControl;
  }

  const metaSequence = isMetaModifiedSequence(sequence);
  const baseSequence = metaSequence ? sequence.slice(1) : sequence;

  if (baseSequence === "\r") {
    return createParsedKey("return", sequence, { option: metaSequence });
  }

  if (baseSequence === "\n") {
    return createParsedKey("enter", sequence, { option: metaSequence });
  }

  if (baseSequence === "\t") {
    return createParsedKey("tab", sequence, { option: metaSequence });
  }

  if (baseSequence === "\b") {
    return createParsedKey("backspace", sequence, { meta: metaSequence });
  }

  if (baseSequence === "\x7f") {
    return createParsedKey("delete", sequence, { meta: metaSequence });
  }

  if (sequence === "\u001B") {
    return createParsedKey("escape", sequence);
  }

  if (baseSequence.length === 1 && baseSequence <= "\x1a") {
    return createParsedKey(
      String.fromCharCode(baseSequence.charCodeAt(0) + "a".charCodeAt(0) - 1),
      sequence,
      { ctrl: true, meta: metaSequence }
    );
  }

  return createParsedKey(baseSequence, sequence, { meta: metaSequence });
}

function isMetaModifiedSequence(sequence: string): boolean {
  if (!sequence.startsWith("\u001B") || sequence.length <= 1) {
    return false;
  }

  const nextChar = sequence[1];
  if (nextChar === "[" || nextChar === "O") {
    return false;
  }

  return true;
}

function parseControlSequence(sequence: string) {
  if (!sequence.startsWith("\u001B") || sequence.length <= 1) {
    return null;
  }

  const body = sequence.slice(1);
  if (body === "[Z") {
    return createParsedKey("tab", sequence, { shift: true });
  }

  const namedSequence = NAMED_SEQUENCES[body];
  if (namedSequence) {
    return createParsedKey(namedSequence, sequence);
  }

  const modifiedMatch = /^\[(\d+);(\d+)([A-Za-z])$/.exec(body);
  if (!modifiedMatch) {
    return null;
  }

  const [, , modifier, final] = modifiedMatch;
  const name = MODIFIED_FINAL_KEY_NAMES[final];
  if (!name) {
    return null;
  }

  const modifierValue = Number(modifier);
  return createParsedKey(name, sequence, {
    shift: modifierValue === 2,
    meta: modifierValue === 3,
    ctrl: modifierValue === 5,
    super: modifierValue === 9,
  });
}

function createParsedKey(
  name: string,
  sequence: string,
  overrides: Partial<{
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
    option: boolean;
    super: boolean;
  }> = {}
) {
  return {
    name,
    ctrl: overrides.ctrl ?? false,
    meta: overrides.meta ?? false,
    shift: overrides.shift ?? false,
    option: overrides.option ?? false,
    sequence,
    raw: sequence,
    super: overrides.super ?? false,
    isKittyProtocol: false,
  };
}

const NON_ALPHANUMERIC_KEYS = [
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "return",
  "enter",
  "escape",
  "tab",
  "backspace",
  "delete",
];

const NAMED_SEQUENCES: Record<string, string> = {
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[F": "end",
  "[H": "home",
  "OA": "up",
  "OB": "down",
  "OC": "right",
  "OD": "left",
  "OF": "end",
  "OH": "home",
  "[1~": "home",
  "[3~": "delete",
  "[4~": "end",
  "[7~": "home",
  "[8~": "end",
};

const MODIFIED_FINAL_KEY_NAMES: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  F: "end",
  H: "home",
};
function renderEditor({
  value,
  cursorOffset,
  placeholder,
  mask,
}: Pick<EditorBuffer, "value" | "cursorOffset"> & { placeholder?: string; mask?: string }) {
  const renderedValue = mask ? mask.repeat(value.length) : value;
  const beforeCursor = renderedValue.slice(0, cursorOffset);
  const hasCursorChar = cursorOffset < renderedValue.length;
  const cursorChar = hasCursorChar ? renderedValue[cursorOffset] : " ";
  const afterCursor = hasCursorChar ? renderedValue.slice(cursorOffset + 1) : "";

  if (renderedValue.length === 0) {
    return (
      <Text>
        <Text inverse> </Text>
        {placeholder ? <Text dimColor>{placeholder}</Text> : null}
      </Text>
    );
  }

  return (
    <Text>
      {beforeCursor}
      <Text inverse>{cursorChar}</Text>
      {afterCursor}
    </Text>
  );
}
