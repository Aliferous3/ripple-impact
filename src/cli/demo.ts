import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `ripple demo` — materializes a small scratch repository exercising every
 * result category (runtime + type impact, tests, evidence) so a new user
 * can see real output in under a minute. Idempotent: recreates the repo.
 */

const BASE_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    { name: "ripple-demo", version: "0.0.0", private: true, type: "module" },
    null,
    2,
  ),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src"],
    },
    null,
    2,
  ),
  "src/types.ts": [
    "export interface User {",
    "  name: string;",
    "}",
    "",
    "export interface Profile {",
    "  user: User;",
    "}",
    "",
  ].join("\n"),
  "src/render.ts": [
    'import type { User } from "./types.js";',
    "",
    "export function renderUser(user: User): string {",
    "  return `user:${user.name}`;",
    "}",
    "",
    "export function greet(user: User): string {",
    '  return `hi ${user.name}`;',
    "}",
    "",
  ].join("\n"),
  "src/notify.ts": [
    'import { renderUser } from "./render.js";',
    'import type { User } from "./types.js";',
    "",
    "export function notify(user: User): string {",
    "  return renderUser(user);",
    "}",
    "",
  ].join("\n"),
  "src/unrelated.ts": [
    "export function slugify(s: string): string {",
    '  return s.toLowerCase().replace(/\\s+/g, "-");',
    "}",
    "",
  ].join("\n"),
  "src/render.test.ts": [
    'import { renderUser } from "./render.js";',
    "",
    "export function testRenderUser(): boolean {",
    '  return renderUser({ name: "ada" }) === "user:ada";',
    "}",
    "",
  ].join("\n"),
};

// Working-tree changes applied after the base commit: a runtime body
// change in renderUser() (called by notify() and the test) plus a
// type-shape change to User.
const EDIT_RENDER = '  return `user:${user.name}@${user.name}`;';
const EDIT_TYPES = "export interface User {\n  name: string;\n  email: string;\n}";

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

export function createDemoRepo(dir = join(tmpdir(), "ripple-demo")): string {
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(BASE_FILES)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=Ripple Demo", "-c", "user.email=demo@example.invalid", "commit", "-qm", "base"]);

  const render = join(dir, "src/render.ts");
  writeFileSync(
    render,
    readFileSyncText(render).replace(
      "  return `user:${user.name}`;",
      EDIT_RENDER,
    ),
  );
  writeFileSync(
    join(dir, "src/types.ts"),
    readFileSyncText(join(dir, "src/types.ts")).replace(
      "export interface User {\n  name: string;\n}",
      EDIT_TYPES,
    ),
  );
  return dir;
}

function readFileSyncText(path: string): string {
  return readFileSync(path, "utf8");
}
