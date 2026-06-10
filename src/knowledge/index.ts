import { readFileSync, existsSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { KNOWLEDGE_SECTIONS } from "./sections.js";
import type { KnowledgeSection } from "./sections.js";

export type { KnowledgeSection };

/** Same heuristic as llm-client: code-ish text runs ~2 bytes/token. */
function estimateTokens(text: string): number {
  const hasCode = text.includes("```") || text.includes("def ") || text.includes("import ");
  const bytesPerToken = hasCode ? 2 : 3;
  return Math.ceil(text.length / bytesPerToken);
}

/**
 * Score sections by keyword overlap with the prompt and return the best
 * matches that fit within the token budget. Returns [] when nothing
 * matches, so generic prompts don't pay for irrelevant context.
 */
export function retrieveSections(
  prompt: string,
  budgetTokens: number
): KnowledgeSection[] {
  const words = new Set(
    prompt
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .filter((w) => w.length > 2)
  );

  const scored = KNOWLEDGE_SECTIONS.map((section) => {
    let score = 0;
    for (const keyword of section.keywords) {
      if (words.has(keyword)) score += 2;
      else if (keyword.includes(" ") && prompt.toLowerCase().includes(keyword)) score += 2;
    }
    return { section, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked: KnowledgeSection[] = [];
  let used = 0;
  for (const { section } of scored) {
    const cost = estimateTokens(section.body);
    if (used + cost > budgetTokens) continue;
    picked.push(section);
    used += cost;
    if (picked.length >= 3) break;
  }
  return picked;
}

/** Render retrieved sections as a system-prompt suffix for the AI builder. */
export function renderKnowledgeContext(sections: KnowledgeSection[]): string {
  if (sections.length === 0) return "";
  const blocks = sections.map(
    (section) => `## ${section.title}\n${section.body}`
  );
  return `\n\n# RELEVANT COWBOY REFERENCE (retrieved for this request)\n\n${blocks.join("\n\n")}`;
}

/** /docs with no topic: list available topics. */
export function docsIndex(): string {
  const rows = KNOWLEDGE_SECTIONS.map(
    (section) => `    /docs ${section.id.padEnd(14)} ${section.title}`
  );
  return ["  Bundled Cowboy reference topics:", "", ...rows].join("\n");
}

/** /docs <topic>: exact id match first, then substring match on id/title. */
export function getDocSection(topic: string): KnowledgeSection | null {
  const needle = topic.trim().toLowerCase();
  return (
    KNOWLEDGE_SECTIONS.find((s) => s.id === needle) ??
    KNOWLEDGE_SECTIONS.find(
      (s) => s.id.includes(needle) || s.title.toLowerCase().includes(needle)
    ) ??
    null
  );
}

// Small caps: the AI builder budgets an 8k-token context window, and
// trimMessages always keeps the most recent user message intact.
const MAX_LOCAL_FILE_BYTES = 3 * 1024;
const MAX_LOCAL_FILES = 2;

/**
 * Pull local source files the user referenced (e.g. "refactor
 * actors/hello/main.py") into the prompt context. Only .py files inside
 * the project directory are eligible; capped at 2 files / 8KB each so a
 * stray reference can't blow the context window.
 */
export function collectLocalFileContext(prompt: string): string {
  const matches = prompt.match(/[\w./-]+\.py\b/g);
  if (!matches) return "";

  const cwd = process.cwd();
  const blocks: string[] = [];
  const seen = new Set<string>();

  for (const ref of matches) {
    if (blocks.length >= MAX_LOCAL_FILES) break;
    if (isAbsolute(ref)) continue;
    const normalized = normalize(ref);
    if (normalized.startsWith("..")) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const fullPath = join(cwd, normalized);
    try {
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) continue;
      const content = readFileSync(fullPath, "utf-8").slice(0, MAX_LOCAL_FILE_BYTES);
      blocks.push(`File ${normalized}:\n\`\`\`python\n${content}\n\`\`\``);
    } catch {
      // Unreadable file: skip silently, the model just won't see it.
    }
  }

  if (blocks.length === 0) return "";
  return `\n\nLocal project files referenced in this request:\n\n${blocks.join("\n\n")}`;
}
