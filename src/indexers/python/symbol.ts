import type { NodeKind } from "../../graph/types.js";

/**
 * Parser for scip-python symbol strings.
 *
 * Format: "scip-python python <packageName> <version> <descriptors>"
 * e.g.: scip-python python probe 0.1.0 `probe_pkg.repo`/Service#save().
 *        local 0
 *
 * Descriptor grammar (differs from scip-typescript):
 *   `dotted.module`/   namespace — dotted module path (backtick-escaped)
 *   name/              namespace — plain segment (e.g. "probe_pkg/")
 *   __init__:          meta — marks the file/module symbol
 *   name.              term — variable / attribute
 *   name#              type — class
 *   name().            method — function OR method (parent decides)
 *   (name)             parameter
 *   [name]             type parameter
 *
 * Relative-import module references arrive UNQUALIFIED (e.g.
 * "models/__init__:" for `from .models import X`); the converter resolves
 * them to canonical module nodes by unique tail-match.
 */

export type PyDescriptorSuffix =
  | "namespace"
  | "meta"
  | "term"
  | "type"
  | "method"
  | "parameter"
  | "typeParameter";

export interface PyDescriptor {
  name: string;
  suffix: PyDescriptorSuffix;
}

export type PySymbolKind =
  | "module"
  | "method"
  | "function"
  | "class"
  | "variable"
  | "parameter"
  | "typeParameter"
  | "local"
  | "unknown";

export interface ParsedPySymbol {
  raw: string;
  packageName: string;
  descriptors: PyDescriptor[];
  kind: PySymbolKind;
  /** Final descriptor name (e.g. "save"). */
  name: string;
  /** Enclosing `Type#` name when the symbol is a class member. */
  parentTypeName?: string;
  /** True when the final descriptor is a class member (# parent). */
  insideType: boolean;
}

const LOCAL_RE = /^local \d+/;

export function parsePythonSymbol(raw: string): ParsedPySymbol | undefined {
  if (LOCAL_RE.test(raw)) {
    return {
      raw, packageName: "", descriptors: [],
      kind: "local", name: raw, insideType: false,
    };
  }
  const parts = raw.split(" ");
  if (parts.length < 5 || parts[0] !== "scip-python") return undefined;
  const packageName = parts[2];
  const descriptors = parseDescriptors(parts.slice(4).join(" "));
  if (descriptors.length === 0) return undefined;

  const last = descriptors[descriptors.length - 1];
  const parent = descriptors[descriptors.length - 2];
  const insideType = parent?.suffix === "type";

  let kind: PySymbolKind;
  if (last.suffix === "meta") {
    kind = "module"; // `.../__init__:` marks the file-level symbol
  } else if (last.suffix === "method") {
    // `C#m().` → method; `f().` or `outer().inner().` → function
    kind = insideType ? "method" : "function";
  } else if (last.suffix === "type") {
    kind = "class";
  } else if (last.suffix === "term") {
    kind = "variable";
  } else if (last.suffix === "parameter") {
    kind = "parameter";
  } else if (last.suffix === "typeParameter") {
    kind = "typeParameter";
  } else {
    kind = "unknown"; // bare namespace refs that aren't module markers
  }

  return {
    raw,
    packageName,
    descriptors,
    kind,
    name: last.name,
    insideType,
    parentTypeName: insideType ? parent?.name : undefined,
  };
}

function parseDescriptors(text: string): PyDescriptor[] {
  const out: PyDescriptor[] = [];
  let i = 0;
  while (i < text.length) {
    let name = "";
    if (text[i] === "`") {
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
      while (i < text.length && !".#/:([ ".includes(text[i])) i++;
      name = text.slice(start, i);
    }
    if (i >= text.length) {
      if (name) out.push({ name, suffix: "term" });
      break;
    }
    const ch = text[i];
    if (ch === "/") {
      out.push({ name, suffix: "namespace" });
      i++;
    } else if (ch === ":") {
      out.push({ name, suffix: "meta" });
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

/** Map a parsed Python symbol onto a Ripple NodeKind (undefined = skip). */
export function pyNodeKind(parsed: ParsedPySymbol): NodeKind | undefined {
  switch (parsed.kind) {
    case "module":
      return "file";
    case "method":
      return "method";
    case "function":
      return "function";
    case "class":
      return "class";
    case "variable":
      return "variable";
    default:
      return undefined; // parameters, type params, locals, unknowns
  }
}

/** Display name, e.g. "save()" or "Service#save()". */
export function pyDisplayName(parsed: ParsedPySymbol): string {
  const suffix = parsed.kind === "method" || parsed.kind === "function" ? "()" : "";
  if (parsed.insideType && parsed.parentTypeName) {
    return `${parsed.parentTypeName}#${parsed.name}${suffix}`;
  }
  return `${parsed.name}${suffix}`;
}

/**
 * Tail used to match an unqualified relative-import module reference
 * (e.g. "models/__init__:" → "models") against canonical module ids.
 * Returns the module path with '/' separators, or undefined for
 * non-module symbols.
 */
export function moduleTail(parsed: ParsedPySymbol): string | undefined {
  if (parsed.kind !== "module") return undefined;
  const ns = parsed.descriptors
    .filter((d) => d.suffix === "namespace")
    .map((d) => d.name.replace(/\./g, "/"))
    .join("/");
  return ns || undefined;
}
