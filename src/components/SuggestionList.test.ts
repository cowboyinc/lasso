import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "ink";
import { SuggestionList } from "./SuggestionList.js";

test("suggestion labels strip terminal control sequences before rendering", () => {
  const output = renderToString(
    React.createElement(SuggestionList, {
      menu: {
        isOpen: true,
        tokenStart: 0,
        tokenEnd: 0,
        query: "",
        activeIndex: 0,
        candidates: [
          {
            kind: "path",
            value: "actors/main.py",
            label: "actors/\u001b]52;c;Zm9v\u0007main.py",
            detail: "dir\u001b[31m",
          },
        ],
      },
    })
  );

  assert.equal(output.includes("\u001b"), false);
  assert.equal(output.includes("\u0007"), false);
  assert.equal(output.includes("actors/main.py"), true);
  assert.equal(output.includes("dir"), true);
});
