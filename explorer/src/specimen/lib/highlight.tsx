import React from "react";

/* Restrained TypeScript colouring — vermilion keywords, warm paper strings,
   white identifiers, dust-muted punctuation. No theme chrome. */

const TOKEN =
  /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b(?:import|export|from|interface|type|const|let|var|function|return|new|extends|implements|as|async|await|of|in|if|else|switch|case|default|true|false|null|undefined|void|readonly|satisfies|typeof|instanceof|describe|it|expect|class|enum|namespace)\b)|(\b(?:string|number|boolean|any|unknown|never|Record|Promise|Partial|Pick|Omit|Array|Map|Set|Date|Error)\b)|(\b\d+(?:\.\d+)?\b)|([{}()[\];,.:?=&|<>+\-*/!#%@]+)|(\$[A-Za-z_]+)/g;

export function highlight(line: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const cls = m[1]
      ? "hl-comment"
      : m[2]
        ? "hl-string"
        : m[3]
          ? "hl-keyword"
          : m[4]
            ? "hl-type"
            : m[5]
              ? "hl-number"
              : m[6]
                ? "hl-punct"
                : "hl-ident";
    out.push(
      <span key={key++} className={cls}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}
