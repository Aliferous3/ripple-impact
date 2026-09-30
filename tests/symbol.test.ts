import { describe, expect, it } from "vitest";
import { parseScipSymbol } from "../src/indexers/scip/symbol.js";

describe("parseScipSymbol", () => {
  it("parses a top-level function", () => {
    const s = parseScipSymbol(
      "scip-typescript npm fixture-basic 0.0.0 src/auth/`session.ts`/refreshSession().",
    )!;
    expect(s.name).toBe("refreshSession");
    expect(s.descriptorKind).toBe("method");
    expect(s.insideType).toBe(false);
    expect(s.filePath).toBe("src/auth/session.ts");
    expect(s.packageName).toBe("fixture-basic");
  });

  it("parses a class method with parent type", () => {
    const s = parseScipSymbol(
      "scip-typescript npm m 0.0.0 src/`session.ts`/Session#refresh().",
    )!;
    expect(s.descriptorKind).toBe("method");
    expect(s.insideType).toBe(true);
    expect(s.parentTypeName).toBe("Session");
  });

  it("parses types and terms", () => {
    expect(
      parseScipSymbol("scip-typescript npm m 0.0.0 `a.ts`/Foo#")!.descriptorKind,
    ).toBe("type");
    expect(
      parseScipSymbol("scip-typescript npm m 0.0.0 `a.ts`/Foo#bar.")!.descriptorKind,
    ).toBe("term");
  });

  it("parses parameters and type parameters", () => {
    expect(
      parseScipSymbol("scip-typescript npm m 0.0.0 `a.ts`/f().(x)")!.descriptorKind,
    ).toBe("parameter");
    expect(
      parseScipSymbol("scip-typescript npm m 0.0.0 `a.ts`/f().[T]")!.descriptorKind,
    ).toBe("typeParameter");
  });

  it("parses module/file symbols", () => {
    const s = parseScipSymbol(
      "scip-typescript npm m 0.0.0 src/lib/`index.ts`/",
    )!;
    expect(s.descriptorKind).toBe("module");
    expect(s.filePath).toBe("src/lib/index.ts");
  });

  it("parses local symbols", () => {
    expect(parseScipSymbol("local 2")!.descriptorKind).toBe("local");
  });
});
