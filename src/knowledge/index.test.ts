import test from "node:test";
import assert from "node:assert/strict";
import { docsIndex, getDocSection, retrieveSections, renderKnowledgeContext } from "./index.js";
import { KNOWLEDGE_SECTIONS } from "./sections.js";
import { WALKTHROUGH_LESSONS } from "../walkthrough.js";

test("knowledge sections have unique ids and non-empty bodies", () => {
  const ids = new Set(KNOWLEDGE_SECTIONS.map((s) => s.id));
  assert.equal(ids.size, KNOWLEDGE_SECTIONS.length);
  for (const section of KNOWLEDGE_SECTIONS) {
    assert.ok(section.body.length > 100, `section ${section.id} too short`);
    assert.ok(section.keywords.length >= 3, `section ${section.id} needs keywords`);
  }
});

test("retrieval surfaces gas docs for a gas question", () => {
  const sections = retrieveSections("how much gas do storage cells cost?", 1200);
  assert.ok(sections.length > 0);
  assert.ok(sections.some((s) => s.id === "gas" || s.id === "storage"));
});

test("retrieval returns nothing for an off-topic prompt", () => {
  const sections = retrieveSections("hi", 1200);
  assert.equal(sections.length, 0);
  assert.equal(renderKnowledgeContext(sections), "");
});

test("docs index lists every topic and lookup matches loosely", () => {
  const index = docsIndex();
  for (const section of KNOWLEDGE_SECTIONS) {
    assert.ok(index.includes(section.id));
  }
  assert.equal(getDocSection("gas")?.id, "gas");
  assert.equal(getDocSection("Cycles and Cells")?.id, "gas");
  assert.equal(getDocSection("nope-not-a-topic"), null);
});

test("walkthrough has ordered, screen-sized lessons", () => {
  assert.ok(WALKTHROUGH_LESSONS.length >= 5);
  for (const lesson of WALKTHROUGH_LESSONS) {
    assert.ok(lesson.title.length > 0);
    const lines = lesson.body.split("\n");
    assert.ok(lines.length <= 30, `lesson "${lesson.title}" too tall (${lines.length} lines)`);
    for (const line of lines) {
      assert.ok(line.length <= 78, `lesson "${lesson.title}" line too wide: ${line}`);
    }
  }
});
