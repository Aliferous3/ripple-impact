/**
 * Builds tmp/git-scenarios — a real git repository with tagged commits, one
 * per changed-symbol scenario. Tests checkout a tag and diff --base the
 * previous tag, so every scenario is exercised through real git plumbing.
 *
 *   npx tsx scripts/setup-git-fixture.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve("tmp/git-scenarios");

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Ripple Fixture",
  GIT_AUTHOR_EMAIL: "fixture@ripple.dev",
  GIT_COMMITTER_NAME: "Ripple Fixture",
  GIT_COMMITTER_EMAIL: "fixture@ripple.dev",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function git(...args: string[]): string {
  return execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
}

function write(rel: string, text: string): void {
  const p = join(ROOT, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

function commit(tag: string, message: string, fn: () => void): void {
  fn();
  git("add", "-A");
  git("commit", "-q", "-m", message);
  git("tag", "-f", tag);
}

// ---------- file contents ----------

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
`;

const session = (extra = "", sig = "id: string"): string =>
  `export function refreshSession(${sig}): string {
  return \`session-\${id}\`;
}

export function validateUser(id: string): boolean {
  return id.length > 0;
}

export function currentRegion(): string {
  return "us-east";
}
${extra}`;

const auth = `import { refreshSession, validateUser } from "./session";

export function authenticateRequest(id: string): string {
  if (!validateUser(id)) {
    throw new Error("invalid user");
  }
  return refreshSession(id);
}
`;

const authCommented = `import { refreshSession, validateUser } from "./session";

export function authenticateRequest(id: string): string {
  // validate before touching the session store
  if (!validateUser(id)) {
    throw new Error("invalid user");
  }
  return refreshSession(id); // session is now fresh
}
`;

const checkout = `import { authenticateRequest } from "./auth";

export function checkout(user: string): string {
  return \`order:\${authenticateRequest(user)}\`;
}
`;

const payment = `import { checkout } from "./checkout";

export function completePayment(user: string): string {
  return checkout(user) + ":paid";
}
`;

const paymentIndented = `import { checkout } from "./checkout";

export function completePayment(user: string): string {
    return checkout(user) + ":paid";
}
`;

const paymentV2 = `import { checkout } from "./checkout";

export function completePayment(user: string): string {
  const receipt = checkout(user);
  return receipt + ":settled";
}
`;

const settings = `import { validateUser } from "./session";

export function accountSettings(user: string): string {
  return validateUser(user) ? "ok" : "anon";
}
`;

const settingsWithImport = `import { validateUser } from "./session";
import { sendNotification } from "./notify";

export function accountSettings(user: string): string {
  return validateUser(user) ? "ok" : "anon";
}
`;

const notify = `function formatNotification(msg: string): string {
  return \`[n] \${msg}\`;
}

export function sendNotification(msg: string): string {
  return formatNotification(msg);
}
`;

const notifyV2 = `function formatNotification(msg: string): string {
  return \`[notification] \${msg}\`;
}

export function sendNotification(msg: string): string {
  return formatNotification(msg);
}
`;

const extra = (a = 1, b = 2, c = 3): string =>
  `export function alpha(): number {
  return ${a};
}

export function beta(): number {
  return ${b};
}

export function gamma(): number {
  return ${c};
}
`;

const extraNoBeta = (a = 10, c = 33): string =>
  `export function alpha(): number {
  return ${a};
}

export function gamma(): number {
  return ${c};
}
`;

const doomed = `export function legacyToken(): string {
  return "tok-1";
}
`;

const doomedEmpty = `// legacy token generation removed — callers migrated
`;

const legacy = `import { legacyToken } from "./doomed";

export function mintLegacy(): string {
  return legacyToken().toUpperCase();
}
`;

const util = `export function normalizePath(p: string): string {
  return p.replace(/\\\\/g, "/");
}

export function isEmpty(s: string): boolean {
  return s.length === 0;
}
`;

const utilV2 = `export function normalizePath(p: string): string {
  return p.replace(/\\\\/g, "/");
}

export function isEmpty(s: string): boolean {
  return s.trim().length === 0;
}
`;

const moved = `export function beta(): number {
  return 20;
}
`;

const testFile = `import { checkout } from "../src/checkout";
import { authenticateRequest } from "../src/auth";

export function testCheckout(): void {
  checkout("u1");
  authenticateRequest("u2");
}
`;

// ---------- build ----------

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", ROOT], { env, windowsHide: true });
write(".gitignore", "index.scip\ndist/\n");

commit("s0-base", "initial project", () => {
  write("tsconfig.json", TSCONFIG);
  write("src/session.ts", session());
  write("src/auth.ts", auth);
  write("src/checkout.ts", checkout);
  write("src/payment.ts", payment);
  write("src/settings.ts", settings);
  write("src/notify.ts", notify);
  write("src/extra.ts", extra());
  write("src/doomed.ts", doomed);
  write("src/legacy.ts", legacy);
  write("src/util.ts", util);
  write("tests/app.test.ts", testFile);
});

commit("s1-one-fn-modified", "change beta body", () => {
  write("src/extra.ts", extra(1, 20, 3));
});

commit("s2-sibling-isolation", "change gamma only", () => {
  write("src/extra.ts", extra(1, 20, 33));
});

commit("s3-two-fns", "change alpha and isEmpty", () => {
  write("src/extra.ts", extra(10, 20, 33));
  write("src/util.ts", utilV2);
});

commit("s4-fn-added", "add issueToken", () => {
  write("src/session.ts", session(`\nexport function issueToken(): string {
  return "t";
}\n`));
});

commit("s5-fn-deleted", "remove legacyToken", () => {
  write("src/doomed.ts", doomedEmpty);
});

commit("s6-signature-change", "refreshSession gains opts param", () => {
  write(
    "src/session.ts",
    session(`\nexport function issueToken(): string {
  return "t";
}\n`, "id: string, opts?: number"),
  );
});

commit("s7-file-renamed", "rename util.ts to utils.ts", () => {
  git("mv", "src/util.ts", "src/utils.ts");
});

commit("s8-fn-moved", "move beta to moved.ts", () => {
  write("src/extra.ts", extraNoBeta());
  write("src/moved.ts", moved);
});

commit("s9-comment-only", "comments only", () => {
  write("src/auth.ts", authCommented);
});

commit("s10-formatting", "reindent completePayment", () => {
  write("src/payment.ts", paymentIndented);
});

commit("s11-disconnected", "change notification module", () => {
  write("src/notify.ts", notifyV2);
});

commit("s12-multi-downstream", "change validateUser", () => {
  write(
    "src/session.ts",
    session(`\nexport function issueToken(): string {
  return "t";
}\n`, "id: string, opts?: number").replace(
      "return id.length > 0;",
      "return id.length > 1;",
    ),
  );
});

commit("s13-no-downstream", "change completePayment (nobody calls it)", () => {
  write("src/payment.ts", paymentV2);
});

commit("s14-multi-root", "change refreshSession and validateUser", () => {
  write(
    "src/session.ts",
    session(`\nexport function issueToken(): string {
  return "t";
}\n`, "id: string, opts?: number")
      .replace("return `session-${id}`;", "return `sess-${id}`;")
      .replace("return id.length > 1;", "return id.length > 2;"),
  );
});

commit("s15-import-only", "add unused import to settings", () => {
  write("src/settings.ts", settingsWithImport);
});

commit("s16-import-type", "add unused import type to session", () => {
  // Prepend onto the current file verbatim — only the import line may differ.
  const current = execFileSync(
    "git",
    ["-C", ROOT, "show", "HEAD:src/session.ts"],
    { encoding: "utf8" },
  );
  write("src/session.ts", `import type { checkout } from "./checkout";\n` + current);
});

const heavy = `export function heavyFn(x: string): string {
  const norm = x.trim().toLowerCase();
  const head = norm.slice(0, 4);
  return \`\${head}-\${norm.length}\`;
}
`;

const heavyUser = `import { heavyFn } from "./heavy";

export function useHeavy(v: string): string {
  return heavyFn(v) + "!";
}
`;

commit("s17a-fn-with-locals", "add heavyFn (contains local decls)", () => {
  write("src/heavy.ts", heavy);
  write("src/heavyUser.ts", heavyUser);
});

commit("s17-fn-with-locals-deleted", "remove heavyFn", () => {
  write("src/heavy.ts", "");
});

console.log(`fixture repo: ${ROOT}`);
console.log(git("log", "--oneline", "-20").trim());
console.log(git("tag", "-l").trim());
