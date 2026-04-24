/**
 * ActorExtractor — extracts Python actor code from LLM responses
 * and ensures the dispatch shim is present for PVM deployment.
 *
 * Adapted from dashboard/backend/src/services/actor-extractor.ts
 */

export interface ExtractedActor {
  className: string | null;
  code: string;
  filePath: string;
}

/**
 * Extract Python code blocks from LLM text, add dispatch shims,
 * and derive file paths from class names.
 */
export function extractActors(text: string): ExtractedActor[] {
  const blocks = extractPythonCodeBlocks(text);
  return blocks.map((rawCode) => {
    const code = ensureDispatchShim(rawCode);
    const className = extractClassName(code);
    const name = className
      ? className.replace(/Actor$/, "").replace(/([A-Z])/g, "_$1").replace(/^_/, "").toLowerCase()
      : "actor";
    return {
      className,
      code,
      filePath: `actors/${name}/main.py`,
    };
  });
}

function extractPythonCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```python\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const code = match[1].trim();
    // Only extract blocks that look like actors
    if (code.match(/class\s+\w+/) || code.match(/def\s+(init|handler)\s*\(/)) {
      blocks.push(code);
    }
  }
  return blocks;
}

function extractClassName(code: string): string | null {
  const match = code.match(/class\s+(\w+)\s*[:(]/);
  return match ? match[1] : null;
}

/**
 * If the code defines an @actor class but is missing the module-level
 * dispatch shim, append one. The PVM dispatches by bare module-level
 * function name, so every public handler needs a wrapper.
 */
function ensureDispatchShim(code: string): string {
  const classMatch = code.match(/@actor\s*\n(?:@[^\n]*\n)*class\s+(\w+)/);
  if (!classMatch) return code;
  const className = classMatch[1];

  const classStart = code.indexOf(`class ${className}`);
  if (classStart < 0) return code;
  const classBlock = code.slice(classStart);

  const publicMethods: string[] = [];
  const continuationMethods: string[] = [];
  const seen = new Set<string>();
  const methodRegex =
    /(?:\n    (@[^\n]+)\s*\n)?    (?:async\s+)?def\s+(\w+)\s*\(\s*self/g;
  let m;
  while ((m = methodRegex.exec(classBlock)) !== null) {
    const decorator = m[1] || "";
    const name = m[2];
    if (name.startsWith("_") || seen.has(name)) continue;
    seen.add(name);
    publicMethods.push(name);
    if (decorator.includes("runner.continuation") || decorator.includes("actor.continuation")) {
      continuationMethods.push(name);
    }
  }

  if (publicMethods.length === 0) return code;

  // Check if a complete shim already exists
  const existingModuleDefs = new Set<string>(
    [...code.matchAll(/^def\s+(\w+)\s*\(\s*payload\s*\)/gm)].map((mm) => mm[1])
  );
  const needed = publicMethods.filter((n) => !existingModuleDefs.has(n));
  const neededResume = continuationMethods
    .map((n) => `${n}__resume`)
    .filter((n) => !existingModuleDefs.has(n));
  const hasInstance = /^_actor\s*=\s*\w+\s*\(\s*\)/m.test(code);

  if (needed.length === 0 && neededResume.length === 0 && hasInstance) {
    return code;
  }

  const lines: string[] = [];
  lines.push("");
  lines.push("");
  lines.push("# -- Module-level dispatch shim (required by PVM) --");
  lines.push(`_actor = ${className}()`);
  lines.push("");
  for (const name of publicMethods) {
    lines.push(`def ${name}(payload):     return _actor.${name}(payload)`);
  }
  for (const name of continuationMethods) {
    lines.push(`def ${name}__resume(payload): return _actor.${name}__resume(payload)`);
  }

  return code.trimEnd() + "\n" + lines.join("\n") + "\n";
}
