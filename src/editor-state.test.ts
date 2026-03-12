import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEditorAction,
  createEditorState,
  getCursorColumn,
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
