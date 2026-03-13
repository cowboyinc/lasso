export interface EditorState {
  value: string;
  cursorOffset: number;
}

export type EditorAction =
  | { type: "insert"; text: string }
  | { type: "moveLeft" }
  | { type: "moveRight" }
  | { type: "moveStart" }
  | { type: "moveEnd" }
  | { type: "moveWordBackward" }
  | { type: "moveWordForward" }
  | { type: "backspace" }
  | { type: "deleteForward" }
  | { type: "deleteToStart" }
  | { type: "deleteToEnd" }
  | { type: "deleteWordBackward" };

interface InterruptState {
  value: string;
  pendingExit: boolean;
}

const WORD_CHAR = /[A-Za-z0-9_]/;

export function createEditorState(value = "", cursorOffset = value.length): EditorState {
  return {
    value,
    cursorOffset: clampCursor(cursorOffset, value),
  };
}

export function applyEditorAction(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "insert":
      return insertText(state, action.text);
    case "moveLeft":
      return { ...state, cursorOffset: Math.max(0, state.cursorOffset - 1) };
    case "moveRight":
      return { ...state, cursorOffset: Math.min(state.value.length, state.cursorOffset + 1) };
    case "moveStart":
      return { ...state, cursorOffset: 0 };
    case "moveEnd":
      return { ...state, cursorOffset: state.value.length };
    case "moveWordBackward":
      return { ...state, cursorOffset: findWordStart(state.value, state.cursorOffset) };
    case "moveWordForward":
      return { ...state, cursorOffset: findWordEnd(state.value, state.cursorOffset) };
    case "backspace":
      if (state.cursorOffset === 0) return state;
      return {
        value: state.value.slice(0, state.cursorOffset - 1) + state.value.slice(state.cursorOffset),
        cursorOffset: state.cursorOffset - 1,
      };
    case "deleteForward":
      if (state.cursorOffset >= state.value.length) return state;
      return {
        ...state,
        value: state.value.slice(0, state.cursorOffset) + state.value.slice(state.cursorOffset + 1),
      };
    case "deleteToStart":
      if (state.cursorOffset === 0) return state;
      return {
        value: state.value.slice(state.cursorOffset),
        cursorOffset: 0,
      };
    case "deleteToEnd":
      if (state.cursorOffset >= state.value.length) return state;
      return {
        value: state.value.slice(0, state.cursorOffset),
        cursorOffset: state.cursorOffset,
      };
    case "deleteWordBackward": {
      const nextOffset = findDeleteWordStart(state.value, state.cursorOffset);
      if (nextOffset === state.cursorOffset) return state;
      return {
        value: state.value.slice(0, nextOffset) + state.value.slice(state.cursorOffset),
        cursorOffset: nextOffset,
      };
    }
  }
}

export function getCursorColumn(state: EditorState, promptWidth: number): number {
  return promptWidth + state.cursorOffset;
}

export function shouldExitOnInterrupt({ value, pendingExit }: InterruptState): boolean {
  return value.length === 0 && pendingExit;
}

export function resolveKeypressAction(
  input: string,
  key: {
    leftArrow: boolean;
    rightArrow: boolean;
    home: boolean;
    end: boolean;
    backspace: boolean;
    delete: boolean;
    ctrl: boolean;
    meta: boolean;
    super: boolean;
  },
  sequence?: string
): EditorAction | null {
  if (key.home || (key.ctrl && input === "a") || (key.super && key.leftArrow)) {
    return { type: "moveStart" };
  }

  if (key.end || (key.ctrl && input === "e") || (key.super && key.rightArrow)) {
    return { type: "moveEnd" };
  }

  if ((key.meta && key.leftArrow) || (key.meta && input === "b")) {
    return { type: "moveWordBackward" };
  }

  if ((key.meta && key.rightArrow) || (key.meta && input === "f")) {
    return { type: "moveWordForward" };
  }

  if (key.leftArrow || (key.ctrl && input === "b")) {
    return { type: "moveLeft" };
  }

  if (key.rightArrow || (key.ctrl && input === "f")) {
    return { type: "moveRight" };
  }

  if (key.backspace || isBackwardDeleteKey(key, sequence) || (key.ctrl && input === "h")) {
    return { type: "backspace" };
  }

  if (isForwardDeleteKey(key, input, sequence)) {
    return { type: "deleteForward" };
  }

  if (key.ctrl && input === "u") {
    return { type: "deleteToStart" };
  }

  if (key.ctrl && input === "k") {
    return { type: "deleteToEnd" };
  }

  if ((key.meta && key.backspace) || (key.ctrl && input === "w")) {
    return { type: "deleteWordBackward" };
  }

  return null;
}

function isBackwardDeleteKey(
  key: {
    delete: boolean;
    meta: boolean;
  },
  sequence?: string
): boolean {
  if (!key.delete) return false;
  return sequence === "\x7f" || sequence === "\x1b\x7f" || (!sequence && !key.meta);
}

function isForwardDeleteKey(
  key: {
    delete: boolean;
    ctrl: boolean;
  },
  input: string,
  sequence?: string
): boolean {
  if (key.ctrl && input === "d") return true;
  if (!key.delete) return false;
  return sequence === "\x1b[3~" || sequence === "\x1b\x1b[3~";
}

function insertText(state: EditorState, text: string): EditorState {
  if (text.length === 0) return state;
  return {
    value: state.value.slice(0, state.cursorOffset) + text + state.value.slice(state.cursorOffset),
    cursorOffset: state.cursorOffset + text.length,
  };
}

function clampCursor(cursorOffset: number, value: string): number {
  return Math.max(0, Math.min(cursorOffset, value.length));
}

function isWordChar(char: string | undefined): boolean {
  return Boolean(char && WORD_CHAR.test(char));
}

function findWordStart(value: string, cursorOffset: number): number {
  let index = cursorOffset;

  while (index > 0 && /\s/.test(value[index - 1] ?? "")) {
    index--;
  }

  while (index > 0 && isWordChar(value[index - 1])) {
    index--;
  }

  if (index === cursorOffset) {
    while (index > 0 && !/\s/.test(value[index - 1] ?? "")) {
      index--;
    }
  }

  return index;
}

function findWordEnd(value: string, cursorOffset: number): number {
  let index = cursorOffset;

  if (/\s/.test(value[index] ?? "")) {
    while (index < value.length && /\s/.test(value[index] ?? "")) {
      index++;
    }
    while (index < value.length && isWordChar(value[index])) {
      index++;
    }
  }
  else if (isWordChar(value[index])) {
    while (index < value.length && isWordChar(value[index])) {
      index++;
    }
  } else {
    while (index < value.length && !/\s/.test(value[index] ?? "")) {
      index++;
    }
  }

  return index;
}

function findDeleteWordStart(value: string, cursorOffset: number): number {
  let index = cursorOffset;

  while (index > 0 && /\s/.test(value[index - 1] ?? "")) {
    index--;
  }

  while (index > 0 && !/\s/.test(value[index - 1] ?? "")) {
    index--;
  }

  while (index > 0 && /\s/.test(value[index - 1] ?? "")) {
    index--;
  }

  return index;
}
