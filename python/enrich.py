#!/usr/bin/env python3
"""Ripple Python enrichment — syntax classification for SCIP intersection.

Reads JSON on stdin:  {"files": [{"id": "rel/path.py", "text": "..."}]}
Writes JSON to stdout: {"files": {id: {"calls": [[sl,sc,el,ec]...],
                                    "types": [{"r": [sl,sc,el,ec], "k": "annotation"|"base-class"}...]}},
                      "errors": {id: "message"}}

Ranges are 0-based (line, char) with UTF-16 character units to match SCIP.

Optional modes: default "classify" (above), or "sourcemap" which returns
{"defs": [...], "comments": [[off,off]...], "literals": [[off,off]...],
 "typeOnly": [[sl,sc,el,ec]...]} per file — the deterministic source facts
Ripple's change mapper needs for deleted-def attribution, hunk comment/
literal filtering, and type-only module statement ranges.

This script performs SYNTAX classification only. It never resolves symbol
identity — SCIP does that. Deterministic, no network, stdlib only.
"""

import ast
import io
import json
import re
import sys
import tokenize


def _col16(line_bytes: bytes, byte_col: int) -> int:
    """UTF-8 byte column -> UTF-16 code units (SCIP range convention)."""
    s = line_bytes[:byte_col].decode("utf-8", "replace")
    return len(s.encode("utf-16-le")) // 2


class _Classifier(ast.NodeVisitor):
    def __init__(self, source: str):
        self.lines = source.splitlines()
        self.line_bytes = [ln.encode("utf-8") for ln in self.lines]
        self.calls = []  # callee-name ranges
        self.types = []  # {"r": range, "k": kind}
        self._decorator_heads = set()

    # -- helpers ---------------------------------------------------------

    def _rng(self, node) -> list:
        sl = node.lineno - 1
        el = node.end_lineno - 1
        sc = _col16(self.line_bytes[sl], node.col_offset)
        ec = _col16(self.line_bytes[el], node.end_col_offset)
        return [sl, sc, el, ec]

    def _attr_tail_rng(self, node) -> list:
        """Range of the trailing `attr` name in an Attribute node."""
        el = node.end_lineno - 1
        ec = _col16(self.line_bytes[el], node.end_col_offset)
        attr_len = len(node.attr.encode("utf-16-le")) // 2
        return [el, ec - attr_len, el, ec]

    def _callee_rng(self, func):
        """The name-range a SCIP occurrence would occupy for a call callee."""
        if isinstance(func, ast.Name):
            return self._rng(func)
        if isinstance(func, ast.Attribute):
            return self._attr_tail_rng(func)
        return None  # Call/Subscript/Lambda/etc. — no name to intersect

    def _emit_annotation_names(self, expr, kind):
        """Emit every name-leaf inside a type-position expression."""
        if isinstance(expr, ast.Name):
            self.types.append({"r": self._rng(expr), "k": kind})
        elif isinstance(expr, ast.Attribute):
            self.types.append({"r": self._attr_tail_rng(expr), "k": kind})
        elif isinstance(expr, ast.Constant) and isinstance(expr.value, str):
            # String/forward annotation: "User | None" — parse the inner
            # expression and remap ranges into the source string.
            self._emit_string_annotation(expr, kind)
        elif isinstance(expr, ast.Subscript):
            self._emit_annotation_names(expr.value, kind)
            self._emit_annotation_names(expr.slice, kind)
        elif isinstance(expr, ast.BinOp):
            self._emit_annotation_names(expr.left, kind)
            self._emit_annotation_names(expr.right, kind)
        elif isinstance(expr, (ast.Tuple, ast.List, ast.Set)):
            for e in expr.elts:
                self._emit_annotation_names(e, kind)
        elif isinstance(expr, ast.UnaryOp):
            self._emit_annotation_names(expr.operand, kind)
        elif isinstance(expr, ast.Starred):
            self._emit_annotation_names(expr.value, kind)
        elif isinstance(expr, ast.IfExp):
            self._emit_annotation_names(expr.body, kind)
            self._emit_annotation_names(expr.orelse, kind)
        # Constants, Calls, Lambda, etc. — no name leaves to classify.

    def _emit_string_annotation(self, const, kind):
        line = self.lines[const.lineno - 1] if const.lineno - 1 < len(self.lines) else ""
        # Find the quote character that opens the literal on its first line.
        quote_at = -1
        for i, ch in enumerate(line):
            if ch in "\"'" and i >= const.col_offset:
                quote_at = i
                break
        if quote_at < 0:
            return
        q = line[quote_at]
        triple = line[quote_at : quote_at + 3] in ('"""', "'''")
        content_col = quote_at + (3 if triple else 1)
        try:
            inner = ast.parse(const.value, mode="eval")
        except SyntaxError:
            return  # Not a parseable annotation — conservative, no ranges.
        base_line = const.lineno - 1
        for node in ast.walk(inner):
            if isinstance(node, ast.Name):
                sl = base_line + node.lineno - 1
                el = base_line + node.end_lineno - 1
                if node.lineno == 1:
                    sc = content_col + node.col_offset
                else:
                    sc = node.col_offset
                if node.end_lineno == 1:
                    ec = content_col + node.end_col_offset
                else:
                    ec = node.end_col_offset
                self.types.append({"r": [sl, sc, el, ec], "k": kind})
            elif isinstance(node, ast.Attribute):
                # Only the trailing attr name; remap like above.
                el = base_line + node.end_lineno - 1
                if node.end_lineno == 1:
                    ec = content_col + node.end_col_offset
                else:
                    ec = node.end_col_offset
                attr_len = len(node.attr)
                self.types.append({"r": [el, ec - attr_len, el, ec], "k": kind})

    # -- visitors --------------------------------------------------------

    def visit_Call(self, node):
        # A call in decorator HEAD position stays a reference: `@dec` and
        # `@dec(...)` execute at definition time, but Ripple's contract
        # treats decorators conservatively. Calls inside decorator ARGS
        # are still real calls (they execute when the module loads).
        if id(node) not in self._decorator_heads:
            r = self._callee_rng(node.func)
            if r is not None:
                self.calls.append(r)
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        self._visit_func(node)

    def visit_AsyncFunctionDef(self, node):
        self._visit_func(node)

    def _visit_func(self, node):
        for d in node.decorator_list:
            if isinstance(d, ast.Call):
                self._decorator_heads.add(id(d))
        if node.returns is not None:
            self._emit_annotation_names(node.returns, "annotation")
        self.generic_visit(node)

    def visit_arg(self, node):
        if node.annotation is not None:
            self._emit_annotation_names(node.annotation, "annotation")
        self.generic_visit(node)

    def visit_AnnAssign(self, node):
        self._emit_annotation_names(node.annotation, "annotation")
        self.generic_visit(node)

    def visit_ClassDef(self, node):
        for d in node.decorator_list:
            if isinstance(d, ast.Call):
                self._decorator_heads.add(id(d))
        for b in node.bases:
            self._emit_annotation_names(b, "base-class")
        for kw in node.keywords:
            self._emit_annotation_names(kw.value, "base-class")
        self.generic_visit(node)

    def visit_TypeAlias(self, node):  # Python 3.12+ `type X = ...`
        self._emit_annotation_names(node.value, "annotation")
        self.generic_visit(node)


def classify(source: str):
    tree = ast.parse(source)
    v = _Classifier(source)
    v.visit(tree)
    v.calls.sort()
    v.types.sort(key=lambda t: t["r"])
    return {"calls": v.calls, "types": v.types}


# ---------------------------------------------------------------------------
# sourcemap mode — deterministic source facts for change mapping
# ---------------------------------------------------------------------------

_UTF16LINE_CACHE = {}


def _line_tables(source: str):
    """UTF-16 start offsets per line (0-based rows)."""
    lines = source.split("\n")
    starts = [0]
    acc = 0
    for ln in lines[:-1]:
        acc += len(ln.encode("utf-16-le")) // 2 + 1
        starts.append(acc)
    return lines, starts


def _u16col(line: str, cp_col: int) -> int:
    """Code-point column -> UTF-16 column."""
    return len(line[:cp_col].encode("utf-16-le")) // 2


def _tok_ranges(source: str):
    """Comment and string-literal char ranges via the stdlib tokenizer.

    Offsets are UTF-16 units (JS string indices). F-strings (3.12+) are
    emitted as their literal text chunks only — interpolation expressions
    remain ordinary code, matching how template substitutions are treated
    for other languages. On tokenize failure, the whole file is reported
    as literal so whitespace edits can never be silently dropped.
    """
    lines, starts = _line_tables(source)

    def off(rc):
        r, c = rc
        if r - 1 >= len(lines):
            return len(source.encode("utf-16-le")) // 2
        return starts[r - 1] + _u16col(lines[r - 1], c)

    comments, literals = [], []
    fstring = getattr(tokenize, "FSTRING_START", None)
    literal_kinds = {tokenize.STRING}
    if fstring is not None:
        literal_kinds.update(
            {tokenize.FSTRING_START, tokenize.FSTRING_MIDDLE, tokenize.FSTRING_END}
        )
    try:
        for t in tokenize.generate_tokens(io.StringIO(source).readline):
            if t.type == tokenize.COMMENT:
                comments.append([off(t.start), off(t.end)])
            elif t.type in literal_kinds:
                literals.append([off(t.start), off(t.end)])
    except (tokenize.TokenError, IndentationError, SyntaxError):
        total = len(source.encode("utf-16-le")) // 2
        return [], [[0, total]]
    return comments, literals


_DEF_NAME = {
    "func": re.compile(r"\bdef\s+([A-Za-z_][A-Za-z0-9_]*)"),
    "class": re.compile(r"\bclass\s+([A-Za-z_][A-Za-z0-9_]*)"),
}


def _name_span(line: str, kind: str):
    """(name, utf16 start col, utf16 end col) on the def's first line."""
    m = _DEF_NAME[kind].search(line)
    if not m:
        return None
    return (m.group(1), _u16col(line, m.start(1)), _u16col(line, m.end(1)))


def _defs(tree, source: str):
    """SourceDef-shaped entries: {name, kind, nameRange, extent,
    start, end, topLevel}. Mirrors the TypeScript extractor's rules:

      - functions/methods/classes get extent = decorators..body end
      - class members are named "Cls#member" and are topLevel
      - nested defs inside function bodies get plain names, topLevel False
      - module/class variable targets are emitted; function locals too
        (topLevel False) so containment/parent attribution still works
    """
    lines, starts = _line_tables(source)
    lb = [ln.encode("utf-8") for ln in lines]

    def b16(row, bcol):
        return _col16(lb[row], bcol) if row < len(lb) else 0

    def off16(row, u16col):
        return starts[row] + u16col if row < len(starts) else len(source)

    out = []

    def emit(node, name, kind, nsl_row, inside_fn):
        deco = getattr(node, "decorator_list", None) or []
        sl = min([node.lineno] + [d.lineno for d in deco]) - 1
        sc = (
            min(
                [node.col_offset]
                + [d.col_offset for d in deco if d.lineno - 1 == sl]
            )
            if deco
            else node.col_offset
        )
        sc16 = b16(sl, sc)
        el = node.end_lineno - 1
        ec16 = b16(el, node.end_col_offset)
        out.append(
            {
                "name": name,
                "kind": kind,
                "nameRange": nsl_row,
                "extent": [sl, sc16, el, ec16],
                "start": off16(sl, sc16),
                "end": off16(el, ec16),
                "topLevel": not inside_fn,
            }
        )

    def var_target(t, inside_fn, cls_path):
        if isinstance(t, ast.Name):
            l, c, e = t.lineno - 1, t.col_offset, t.end_col_offset
            name = f"{cls_path}#{t.id}" if cls_path else t.id
            emit(
                t,
                name,
                "variable",
                [l, b16(l, c), t.end_lineno - 1, b16(t.end_lineno - 1, e)],
                inside_fn and cls_path is None,
            )

    def walk(node, inside_fn, cls_path):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                line = lines[child.lineno - 1] if child.lineno - 1 < len(lines) else ""
                span = _name_span(line, "func")
                qual = f"{cls_path}#{child.name}" if cls_path else child.name
                emit(
                    child,
                    qual,
                    "method" if cls_path else "function",
                    [child.lineno - 1, span[1], child.lineno - 1, span[2]]
                    if span
                    else [child.lineno - 1, 0, child.lineno - 1, 0],
                    inside_fn and cls_path is None,
                )
                # Class members stay addressable (topLevel True); defs
                # nested inside function bodies are locals (topLevel False).
                walk(child, True, None)
            elif isinstance(child, ast.ClassDef):
                line = lines[child.lineno - 1] if child.lineno - 1 < len(lines) else ""
                span = _name_span(line, "class")
                qual = f"{cls_path}#{child.name}" if cls_path else child.name
                emit(
                    child,
                    qual,
                    "class",
                    [child.lineno - 1, span[1], child.lineno - 1, span[2]]
                    if span
                    else [child.lineno - 1, 0, child.lineno - 1, 0],
                    inside_fn,
                )
                # Members are addressable like TS class members; a class
                # nested anywhere inside a class body is not topLevel —
                # mirror of the TS rule that class children are "inside".
                for member in child.body:
                    if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        line = (
                            lines[member.lineno - 1]
                            if member.lineno - 1 < len(lines)
                            else ""
                        )
                        span = _name_span(line, "func")
                        emit(
                            member,
                            f"{qual}#{member.name}",
                            "method",
                            [
                                member.lineno - 1,
                                span[1],
                                member.lineno - 1,
                                span[2],
                            ]
                            if span
                            else [member.lineno - 1, 0, member.lineno - 1, 0],
                            False,
                        )
                        walk(member, True, None)
                    elif isinstance(member, ast.ClassDef):
                        # Nested classes inside a class body are not
                        # topLevel (same as TS nested-class handling).
                        line = (
                            lines[member.lineno - 1]
                            if member.lineno - 1 < len(lines)
                            else ""
                        )
                        span = _name_span(line, "class")
                        emit(
                            member,
                            f"{qual}#{member.name}",
                            "class",
                            [
                                member.lineno - 1,
                                span[1],
                                member.lineno - 1,
                                span[2],
                            ]
                            if span
                            else [member.lineno - 1, 0, member.lineno - 1, 0],
                            True,
                        )
                        walk(member, False, f"{qual}#{member.name}")
                    elif isinstance(member, ast.AnnAssign):
                        var_target(member.target, False, qual)
                    elif isinstance(member, ast.Assign):
                        for t in member.targets:
                            var_target(t, False, qual)
                    else:
                        walk(member, True, qual)
            elif isinstance(child, ast.AnnAssign):
                var_target(child.target, inside_fn, cls_path)
            elif isinstance(child, ast.Assign):
                for t in child.targets:
                    var_target(t, inside_fn, cls_path)
            else:
                walk(child, inside_fn, cls_path)

    walk(tree, False, None)
    return out


def _type_only_ranges(tree, source: str):
    """Top-level statements that can never execute runtime bindings:

      if TYPE_CHECKING: ...      (incl. `if typing.TYPE_CHECKING:`)
      type X = ...               (3.12+ TypeAlias)
      from __future__ import ... (binds nothing at runtime)
    """
    lines, _ = _line_tables(source)
    lb = [ln.encode("utf-8") for ln in lines]

    def rng(node):
        return [
            node.lineno - 1,
            _col16(lb[node.lineno - 1], node.col_offset),
            node.end_lineno - 1,
            _col16(lb[node.end_lineno - 1], node.end_col_offset),
        ]

    def is_type_checking(test):
        if isinstance(test, ast.Name):
            return test.id == "TYPE_CHECKING"
        if isinstance(test, ast.Attribute):
            return test.attr == "TYPE_CHECKING"
        if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
            return False  # `if not TYPE_CHECKING:` executes at runtime
        return False

    out = []
    for st in tree.body:
        if isinstance(st, ast.If) and is_type_checking(st.test):
            out.append(rng(st))
        elif sys.version_info >= (3, 12) and isinstance(st, ast.TypeAlias):
            out.append(rng(st))
        elif (
            isinstance(st, ast.ImportFrom)
            and st.module == "__future__"
        ):
            out.append(rng(st))
    return out


def sourcemap(source: str):
    comments, literals = _tok_ranges(source)
    try:
        tree = ast.parse(source)
    except SyntaxError:
        # Still return tokenizer facts — a fragment (e.g. a def-body slice)
        # cannot be parsed but its comments/literals are still exact.
        return {
            "defs": [],
            "comments": comments,
            "literals": literals,
            "typeOnly": [],
        }
    return {
        "defs": _defs(tree, source),
        "comments": comments,
        "literals": literals,
        "typeOnly": _type_only_ranges(tree, source),
    }


def main():
    req = json.load(sys.stdin)
    mode = req.get("mode", "classify")
    fn = sourcemap if mode == "sourcemap" else classify
    out = {"files": {}, "errors": {}}
    for f in req.get("files", []):
        fid = f.get("id")
        try:
            out["files"][fid] = fn(f.get("text", ""))
        except SyntaxError as e:
            out["errors"][fid] = f"syntax: {e.msg} (line {e.lineno})"
        except Exception as e:  # never let one file kill the batch
            out["errors"][fid] = f"{type(e).__name__}: {e}"
    json.dump(out, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
