import { describe, expect, it } from "vitest";
import { parseGitDiff } from "../src/git/parse.js";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,0 +4,2 @@
+line4
+line5
@@ -9,2 +11 @@
-old9
-old10
+new11
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+a
+b
+c
diff --git a/src/dead.ts b/src/dead.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/dead.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
diff --git a/src/old.ts b/src/newer.ts
similarity index 92%
rename from src/old.ts
rename to src/newer.ts
index 5555555..6666666 100644
--- a/src/old.ts
+++ b/src/newer.ts
@@ -2 +2 @@
-p
+q
diff --git a/bin/blob b/bin/blob
index 7777777..8888888 100644
Binary files a/bin/blob and b/bin/blob differ
`;

describe("parseGitDiff", () => {
  const files = parseGitDiff(SAMPLE);

  it("parses multiple files and preserves status", () => {
    expect(files.map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/new.ts",
      "src/dead.ts",
      "src/newer.ts",
    ]);
    expect(files.map((f) => f.status)).toEqual([
      "modified",
      "added",
      "deleted",
      "renamed",
    ]);
  });

  it("keeps accurate hunk ranges and line contents", () => {
    const a = files[0];
    expect(a.hunks).toHaveLength(2);
    expect(a.hunks[0].newRange).toEqual({ start: 4, end: 6 });
    expect(a.hunks[0].oldRange).toEqual({ start: 3, end: 3 });
    expect(a.hunks[0].addedLines).toEqual(["line4", "line5"]);
    expect(a.hunks[1].oldRange).toEqual({ start: 9, end: 11 });
    expect(a.hunks[1].removedLines).toEqual(["old9", "old10"]);
  });

  it("records rename from/to", () => {
    const r = files[3];
    expect(r.status).toBe("renamed");
    expect(r.oldPath).toBe("src/old.ts");
    expect(r.path).toBe("src/newer.ts");
  });

  it("ignores binary files", () => {
    expect(files.some((f) => f.path === "bin/blob")).toBe(false);
  });
});
