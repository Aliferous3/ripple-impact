import type { NodeKind } from "../../graph/types.js";

/**
 * Minimal parser for SCIP symbol strings.
 *
 * Format: "<scheme> <packageManager> <packageName> <version> <descriptors>"
 * e.g.: scip-typescript npm fixture-basic 0.0.0 src/auth/`session.ts`/refreshSession().
 *        local 2
 *
 * Descriptors are concatenated; each is a name plus a suffix:
 *   name/   namespace or package
 *   `name`/ backtick-escaped name (e.g. file paths)
 *   name.   term (value, variable, property)
 *   name#   type (class, interface, enum, ...)
 *   name(). or name(<disambiguator>).  method
 *   (name)  parameter
 *   [name]  type parameter
 */

export interface ParsedSymbol {
  /** Raw SCIP symbol string. */
  raw: string;
  /** npm package name from the package field, e.g. "fixture-basic". */
  packageName: string;
  /** Repo-relative file path recovered from descriptors, e.g. "src/auth/session.ts". */
  filePath: string | undefined;
  /** Display name of the last descriptor, e.g. "refreshSession". */
  name: string;
  /** Kind inferred from the descriptor suffix alone. */
  descriptorKind:
    | "module"
    | "method"
    | "type"
    | "term"
    | "parameter"
    | "typeParameter"
    | "local";
  /** Whether the last descriptor sits inside a `#` (type) descriptor. */
  insideType: boolean;
  /** Name of the enclosing `#` type descriptor, if any (e.g. "Session"). */
  parentTypeName?: string;
}

interface Descriptor {
  name: string;
  suffix: "namespace" | "term" | "type" | "method" | "parameter" | "typeParameter";
}

export function parseScipSymbol(symbol: string): ParsedSymbol | undefined {
  if (symbol.startsWith("local ")) {
    return {
      raw: symbol,
      packageName: "",
      filePath: undefined,
      name: symbol,
      descriptorKind: "local",
      insideType: false,
    };
  }
  // Format: scheme manager packageName version descriptors...
  const parts = symbol.split(" ");
  if (parts.length < 5) return undefined;
  const packageName = parts[2];
  const descriptorsText = parts.slice(4).join(" ");
  const descriptors = parseDescriptors(descriptorsText);
  if (descriptors.length === 0) return undefined;

  const last = descriptors[descriptors.length - 1];
  const parent = descriptors[descriptors.length - 2];

  // File path = concatenation of leading namespace descriptors.
  let filePath: string | undefined;
  const namespaces = descriptors.filter((d) => d.suffix === "namespace");
  if (
    namespaces.length > 0 &&
    last.suffix === "namespace"
  ) {
    filePath = namespaces.map((d) => d.name).join("/");
  } else if (namespaces.length > 0) {
    // symbols inside a file: path is everything up to (and including) the last
    // namespace descriptor before the symbol descriptors begin.
    filePath = namespaces.map((d) => d.name).join("/");
  }

  const descriptorKind =
    last.suffix === "namespace"
      ? "module"
      : last.suffix === "method"
        ? "method"
        : last.suffix === "type"
          ? "type"
          : last.suffix === "parameter"
            ? "parameter"
            : last.suffix === "typeParameter"
              ? "typeParameter"
              : "term";

  const insideType = parent?.suffix === "type";
  return {
    raw: symbol,
    packageName,
    filePath,
    name: last.name,
    descriptorKind,
    insideType,
    parentTypeName: insideType ? parent?.name : undefined,
  };
}

function parseDescriptors(text: string): Descriptor[] {
  const out: Descriptor[] = [];
  let i = 0;
  while (i < text.length) {
    let name = "";
    if (text[i] === "`") {
      // Backtick-escaped name; `` escapes a literal backtick.
      i++;
      let buf = "";
      while (i < text.length) {
        if (text[i] === "`") {
          if (text[i + 1] === "`") {
            buf += "`";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        buf += text[i++];
      }
      name = buf;
    } else {
      const start = i;
      while (i < text.length && !".#/([".includes(text[i])) i++;
      name = text.slice(start, i);
    }
    if (i >= text.length) {
      // Bare trailing name with no suffix — treat as a term.
      if (name) out.push({ name, suffix: "term" });
      break;
    }
    const ch = text[i];
    if (ch === "/") {
      out.push({ name, suffix: "namespace" });
      i++;
    } else if (ch === "#") {
      out.push({ name, suffix: "type" });
      i++;
    } else if (ch === ".") {
      out.push({ name, suffix: "term" });
      i++;
    } else if (ch === "(") {
      const close = text.indexOf(")", i);
      if (close === -1) break;
      const after = text[close + 1];
      if (after === ".") {
        out.push({ name, suffix: "method" });
        i = close + 2;
      } else {
        // parameter descriptor: the "(name)" itself is the descriptor
        out.push({ name: text.slice(i + 1, close), suffix: "parameter" });
        i = close + 1;
      }
    } else if (ch === "[") {
      const close = text.indexOf("]", i);
      if (close === -1) break;
      out.push({ name: text.slice(i + 1, close), suffix: "typeParameter" });
      i = close + 1;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * Map a parsed symbol + its SCIP SymbolInformation documentation (hover text)
 * onto a Ripple NodeKind. Returns undefined for symbols we do not model
 * (parameters, type parameters, locals).
 */
export function nodeKindFor(
  parsed: ParsedSymbol,
  documentation: string | undefined,
): NodeKind | undefined {
  const firstWord = documentation?.trim().split(/\s/)[0] ?? "";
  switch (parsed.descriptorKind) {
    case "module":
      return "file";
    case "method":
      return parsed.insideType ? "method" : "function";
    case "type":
      if (firstWord === "interface" || firstWord === "type") return "interface";
      return "class";
    case "term": {
      if (firstWord === "function") return "function";
      if (firstWord === "(method)" || firstWord === "constructor")
        return "method";
      if (firstWord === "interface" || firstWord === "type" || firstWord === "enum")
        return "interface";
      // `const f = () => ...` terms: hover type mentions `=>` or "function".
      if (documentation && /=>\s|:\s*\(.*\)\s*=>|\bfunction\b/.test(documentation))
        return "function";
      return "variable";
    }
    default:
      return undefined; // parameters, type parameters, locals
  }
}

/** Display name for a node, e.g. "refreshSession()" or "Session#refresh()". */
export function displayNameFor(parsed: ParsedSymbol): string {
  const suffix = parsed.descriptorKind === "method" ? "()" : "";
  if (parsed.insideType && parsed.parentTypeName)
    return `${parsed.parentTypeName}#${parsed.name}${suffix}`;
  return `${parsed.name}${suffix}`;
}
