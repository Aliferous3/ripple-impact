import { describe, expect, it } from "vitest";
import { classifyHunk } from "../src/changes/classify.js";
import { typeOnlyModuleRanges } from "../src/changes/ast-defs.js";
import type { DiffHunk } from "../src/git/types.js";

/**
 * Unit tests for hunk classification. Each case supplies the full old/new
 * file text plus a hunk naming the changed lines — classifyHunk re-reads
 * those lines from the real text so AST-derived comment/literal ranges line
 * up exactly as they do for a real git diff.
 */
function singleLineHunk(
  oldLineNo: number,
  newLineNo: number,
  removed: string,
  added: string,
): DiffHunk {
  return {
    oldRange: { start: oldLineNo, end: oldLineNo + 1 },
    newRange: { start: newLineNo, end: newLineNo + 1 },
    removedLines: [removed],
    addedLines: [added],
  };
}

const wrap = (body: string): string =>
  `export function f(): string {\n${body}\n}\n`;

describe("classifyHunk string-literal awareness", () => {
  it("whitespace added inside a string literal → code (T16 regression)", () => {
    const oldBody = `  return "$ git log";`;
    const newBody = `  return "$  git log";`;
    const r = classifyHunk("a.ts", singleLineHunk(2, 2, oldBody, newBody), wrap(oldBody), wrap(newBody));
    expect(r).toBe("code");
  });

  it("whitespace inside an escaped-quote string → code", () => {
    const oldBody = `  return "a \\"b\\" c";`;
    const newBody = `  return "a \\"b\\"  c";`;
    const r = classifyHunk("a.ts", singleLineHunk(2, 2, oldBody, newBody), wrap(oldBody), wrap(newBody));
    expect(r).toBe("code");
  });

  it("whitespace inside template literal text → code", () => {
    const oldBody = "  return `a ${x} b`;";
    const newBody = "  return `a ${x}  b`;";
    const r = classifyHunk("a.ts", singleLineHunk(2, 2, oldBody, newBody), wrap(oldBody), wrap(newBody));
    expect(r).toBe("code");
  });

  it("whitespace inside ${...} substitution → non-semantic", () => {
    const oldBody = "  return `a ${x}b`;";
    const newBody = "  return `a ${ x }b`;";
    const r = classifyHunk("a.ts", singleLineHunk(2, 2, oldBody, newBody), wrap(oldBody), wrap(newBody));
    expect(r).toBe("non-semantic");
  });

  it("multiline template text change → code", () => {
    const oldText = "export function f(): string {\n  return `line one\nline two`;\n}\n";
    const newText = "export function f(): string {\n  return `line one\nline  two`;\n}\n";
    const hunk: DiffHunk = {
      oldRange: { start: 3, end: 4 },
      newRange: { start: 3, end: 4 },
      removedLines: ["line two`;"],
      addedLines: ["line  two`;"],
    };
    expect(classifyHunk("a.ts", hunk, oldText, newText)).toBe("code");
  });

  it("comment containing string-like syntax stays non-semantic", () => {
    const oldBody = `  // say "hi" to x\n  return "a";`;
    const newBody = `  // say "hi there" to x\n  return "a";`;
    const hunk: DiffHunk = {
      oldRange: { start: 2, end: 3 },
      newRange: { start: 2, end: 3 },
      removedLines: [`  // say "hi" to x`],
      addedLines: [`  // say "hi there" to x`],
    };
    expect(classifyHunk("a.ts", hunk, wrap(oldBody), wrap(newBody))).toBe("non-semantic");
  });

  it("non-whitespace string content change → code", () => {
    const oldBody = `  return "abc";`;
    const newBody = `  return "abd";`;
    expect(classifyHunk("a.ts", singleLineHunk(2, 2, oldBody, newBody), wrap(oldBody), wrap(newBody))).toBe("code");
  });

  it("code reindentation stays non-semantic (no blanket regression)", () => {
    const oldBody = `  return "$ git log";`;
    const newBody = `      return "$ git log";`;
    expect(classifyHunk("a.ts", singleLineHunk(2, 2, oldBody, newBody), wrap(oldBody), wrap(newBody))).toBe("non-semantic");
  });

  it("trailing whitespace outside literals stays non-semantic", () => {
    const oldBody = `  return "a";`;
    const newBody = `  return "a";   `;
    expect(classifyHunk("a.ts", singleLineHunk(2, 2, oldBody, newBody), wrap(oldBody), wrap(newBody))).toBe("non-semantic");
  });

  it("missing file text falls back to whitespace-insensitive compare", () => {
    const r = classifyHunk(
      "a.ts",
      singleLineHunk(1, 1, `  return "a";`, `    return "a";`),
      undefined,
      undefined,
    );
    expect(r).toBe("non-semantic");
  });
});

describe("typeOnlyModuleRanges", () => {
  const t = (code: string): number => typeOnlyModuleRanges("a.ts", code).length;

  it("covers pure type statements only", () => {
    expect(t(`import type { A } from "./x";`)).toBe(1);
    expect(t(`import type { A as B } from "./x";`)).toBe(1);
    expect(t(`import { type A, type B } from "./x";`)).toBe(1);
    expect(t(`export type { A } from "./x";`)).toBe(1);
    expect(t(`export type A = string;`)).toBe(1);
    expect(t(`import type A = require("./x");`)).toBe(1);
  });

  it("excludes anything carrying a runtime binding", () => {
    expect(t(`import { A } from "./x";`)).toBe(0);
    expect(t(`import { type A, B } from "./x";`)).toBe(0);
    expect(t(`import def, { type A } from "./x";`)).toBe(0);
    expect(t(`import "./x";`)).toBe(0);
    expect(t(`export { type A, b } from "./x";`)).toBe(0);
    expect(t(`const x: A = 1;`)).toBe(0);
  });
});
