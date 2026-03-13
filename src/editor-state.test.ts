import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEditorAction,
  acceptSuggestion,
  createEditorState,
  getCursorColumn,
  getInterruptAction,
  moveSuggestionSelection,
  openSuggestions,
  resolveKeypressAction,
  shouldExitOnInterrupt,
} from "./editor-state.js";

test("insertions land at the cursor and advance it", () => {
  let state = createEditorState("helo", 3);
  state = applyEditorAction(state, { type: "insert", text: "l" });

  assert.equal(state.value, "hello");
  assert.equal(state.cursorOffset, 4);
});

test("cursor movement respects line boundaries", () => {
  let state = createEditorState("hello", 2);

  state = applyEditorAction(state, { type: "moveLeft" });
  assert.equal(state.cursorOffset, 1);

  state = applyEditorAction(state, { type: "moveStart" });
  assert.equal(state.cursorOffset, 0);

  state = applyEditorAction(state, { type: "moveLeft" });
  assert.equal(state.cursorOffset, 0);

  state = applyEditorAction(state, { type: "moveEnd" });
  assert.equal(state.cursorOffset, 5);

  state = applyEditorAction(state, { type: "moveRight" });
  assert.equal(state.cursorOffset, 5);
});

test("delete and backspace remove the expected characters", () => {
  let state = createEditorState("hello", 3);
  state = applyEditorAction(state, { type: "backspace" });

  assert.equal(state.value, "helo");
  assert.equal(state.cursorOffset, 2);

  state = applyEditorAction(state, { type: "deleteForward" });
  assert.equal(state.value, "heo");
  assert.equal(state.cursorOffset, 2);
});

test("kill shortcuts remove text to start or end of line", () => {
  let state = createEditorState("hello world", 5);
  state = applyEditorAction(state, { type: "deleteToStart" });

  assert.equal(state.value, " world");
  assert.equal(state.cursorOffset, 0);

  state = createEditorState("hello world", 5);
  state = applyEditorAction(state, { type: "deleteToEnd" });

  assert.equal(state.value, "hello");
  assert.equal(state.cursorOffset, 5);
});

test("delete word backward trims whitespace and the prior word", () => {
  let state = createEditorState("hello brave new world", 15);
  state = applyEditorAction(state, { type: "deleteWordBackward" });

  assert.equal(state.value, "hello brave world");
  assert.equal(state.cursorOffset, 11);
});

test("word movement jumps by readline-style word boundaries", () => {
  let state = createEditorState("hello brave new world", 6);

  state = applyEditorAction(state, { type: "moveWordForward" });
  assert.equal(state.cursorOffset, 11);

  state = applyEditorAction(state, { type: "moveWordForward" });
  assert.equal(state.cursorOffset, 15);

  state = applyEditorAction(state, { type: "moveWordBackward" });
  assert.equal(state.cursorOffset, 12);
});

test("cursor column includes prompt width", () => {
  const state = createEditorState("hello", 3);

  assert.equal(getCursorColumn(state, 2), 5);
});

test("interrupt logic clears first and exits on second empty interrupt", () => {
  assert.equal(shouldExitOnInterrupt({ value: "hello", pendingExit: false }), false);
  assert.equal(shouldExitOnInterrupt({ value: "", pendingExit: false }), false);
  assert.equal(shouldExitOnInterrupt({ value: "", pendingExit: true }), true);
});

test("interrupt action cancels execution before any exit behavior", () => {
  assert.equal(
    getInterruptAction({ inputValue: "hello", pendingExit: false, isExecuting: true }),
    "cancel-execution"
  );
  assert.equal(
    getInterruptAction({ inputValue: "", pendingExit: true, isExecuting: true }),
    "cancel-execution"
  );
});

test("interrupt action preserves two-step exit flow while idle", () => {
  assert.equal(
    getInterruptAction({ inputValue: "hello", pendingExit: false, isExecuting: false }),
    "clear-input"
  );
  assert.equal(
    getInterruptAction({ inputValue: "", pendingExit: false, isExecuting: false }),
    "arm-exit"
  );
  assert.equal(
    getInterruptAction({ inputValue: "", pendingExit: true, isExecuting: false }),
    "exit"
  );
});

test("terminal delete key defaults to backward delete while ctrl+d stays forward delete", () => {
  assert.deepEqual(
    resolveKeypressAction("", {
      leftArrow: false,
      rightArrow: false,
      home: false,
      end: false,
      backspace: false,
      delete: true,
      ctrl: false,
      meta: false,
      super: false,
    }, "\x7f"),
    { type: "backspace" }
  );

  assert.deepEqual(
    resolveKeypressAction("d", {
      leftArrow: false,
      rightArrow: false,
      home: false,
      end: false,
      backspace: false,
      delete: false,
      ctrl: true,
      meta: false,
      super: false,
    }),
    { type: "deleteForward" }
  );

  assert.deepEqual(
    resolveKeypressAction("", {
      leftArrow: false,
      rightArrow: false,
      home: false,
      end: false,
      backspace: false,
      delete: true,
      ctrl: false,
      meta: false,
      super: false,
    }, "\x1b[3~"),
    { type: "deleteForward" }
  );
});

test("single-match autocomplete inserts immediately and does not open a menu", () => {
  const state = createEditorState("he");
  const result = openSuggestions(state, {
    tokenStart: 0,
    tokenEnd: 2,
    items: [{ value: "help", label: "help", kind: "command" }],
  });

  assert.equal(result.menu, null);
  assert.equal(result.nextState.value, "help ");
  assert.equal(result.nextState.cursorOffset, 5);
});

test("first tab on multiple matches opens a suggestion menu without mutating input", () => {
  const state = createEditorState("actor ");
  const result = openSuggestions(state, {
    tokenStart: 6,
    tokenEnd: 6,
    items: [
      { value: "deploy", label: "deploy", kind: "command" },
      { value: "execute", label: "execute", kind: "command" },
      { value: "get", label: "get", kind: "command" },
    ],
  });

  assert.equal(result.nextState.value, "actor ");
  assert.equal(result.nextState.cursorOffset, 6);
  assert.deepEqual(result.menu, {
    isOpen: true,
    tokenStart: 6,
    tokenEnd: 6,
    query: "",
    candidates: [
      { value: "deploy", label: "deploy", kind: "command" },
      { value: "execute", label: "execute", kind: "command" },
      { value: "get", label: "get", kind: "command" },
    ],
    activeIndex: 0,
  });
});

test("tab and arrow navigation both cycle the active suggestion and wrap", () => {
  const state = createEditorState("actor ");
  const first = openSuggestions(state, {
    tokenStart: 6,
    tokenEnd: 6,
    items: [
      { value: "deploy", label: "deploy", kind: "command" },
      { value: "execute", label: "execute", kind: "command" },
      { value: "get", label: "get", kind: "command" },
    ],
  });

  const second = moveSuggestionSelection(first.menu!, 1);
  assert.equal(second.activeIndex, 1);

  const third = moveSuggestionSelection(second, 1);
  assert.equal(third.activeIndex, 2);

  const fourth = moveSuggestionSelection(third, 1);
  assert.equal(fourth.activeIndex, 0);

  const fifth = moveSuggestionSelection(fourth, -1);
  assert.equal(fifth.activeIndex, 2);
});

test("accepting an open suggestion inserts it into the prompt and closes the menu", () => {
  const state = createEditorState("actor ");
  const opened = openSuggestions(state, {
    tokenStart: 6,
    tokenEnd: 6,
    items: [
      { value: "deploy", label: "deploy", kind: "command" },
      { value: "execute", label: "execute", kind: "command" },
      { value: "get", label: "get", kind: "command" },
    ],
  });

  const moved = moveSuggestionSelection(opened.menu!, 1);
  const accepted = acceptSuggestion(state, moved);

  assert.equal(accepted.value, "actor execute ");
  assert.equal(accepted.cursorOffset, 14);
});

test("accepting a suggestion preserves text after the cursor for mid-line completion", () => {
  const state = createEditorState("actor  --address 0x123", 6);
  const opened = openSuggestions(state, {
    tokenStart: 6,
    tokenEnd: 6,
    items: [{ value: "deploy", label: "deploy", kind: "command" }],
  });

  assert.equal(opened.nextState.value, "actor deploy --address 0x123");
  assert.equal(opened.nextState.cursorOffset, 13);
});

test("single-match file path completions quote spaces before inserting", () => {
  const state = createEditorState("actor deploy actors/h");
  const result = openSuggestions(state, {
    tokenStart: 13,
    tokenEnd: 21,
    items: [{ value: "actors/hello world.py", label: "actors/hello world.py", kind: "path" }],
  });

  assert.equal(result.menu, null);
  assert.equal(result.nextState.value, 'actor deploy "actors/hello world.py" ');
  assert.equal(result.nextState.cursorOffset, 37);
});

test("single-match directory completions keep path traversal open", () => {
  const state = createEditorState("actor deploy actors/n");
  const result = openSuggestions(state, {
    tokenStart: 13,
    tokenEnd: 21,
    items: [{ value: "actors/nested/", label: "actors/nested/", kind: "path", detail: "directory" }],
  });

  assert.equal(result.menu, null);
  assert.equal(result.nextState.value, "actor deploy actors/nested/");
  assert.equal(result.nextState.cursorOffset, 27);
});
