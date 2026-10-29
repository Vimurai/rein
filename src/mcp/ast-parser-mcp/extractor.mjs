/**
 * extractor.mjs — E-95 (ast-repository-map.md §Components 1, §Data Model)
 *
 * Tree-sitter (WASM) symbol extraction for TS/JS. Loads web-tree-sitter +
 * prebuilt grammars from tree-sitter-wasms and walks the syntax tree to emit
 * the Extracted Symbol Schema { exports, classes, imports }. Ranking
 * (centrality_score) is deliberately left to the repo-mapper (E-96).
 *
 * Pure logic beyond the one-time async grammar load; no stdout writes.
 */

import Parser from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// E-98: grammars are VENDORED into the server dir (grammars/*.wasm) so the
// installed ~/.ai-os/mcp/ast-parser-mcp copy is self-contained — the installer
// rsync ships them with the server, no root-hoisted tree-sitter-wasms needed at
// runtime (tree-sitter-wasms remains a devDependency: the source of these .wasm).
const GRAMMARS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "grammars");

// Per-file parse timeout (blueprint §Security — DoS bound). web-tree-sitter
// returns a partial/aborted tree if a single parse exceeds this.
export const PARSE_TIMEOUT_MICROS = 500_000; // 500 ms

let _parsersByLang = null;

/** Map a file extension to a loadable grammar name (or null to skip). */
export function languageForFile(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "typescript";
  if (ext === ".tsx") return "tsx";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  return null;
}

/** Lazily init web-tree-sitter and load the JS/TS/TSX grammars (cached). */
export async function initParsers() {
  if (_parsersByLang) return _parsersByLang;
  await Parser.init();
  const langs = {
    javascript: "tree-sitter-javascript.wasm",
    typescript: "tree-sitter-typescript.wasm",
    tsx: "tree-sitter-tsx.wasm",
  };
  const out = {};
  for (const [name, wasm] of Object.entries(langs)) {
    const grammar = await Parser.Language.load(resolve(GRAMMARS_DIR, wasm));
    const p = new Parser();
    p.setLanguage(grammar);
    if (typeof p.setTimeoutMicros === "function") p.setTimeoutMicros(PARSE_TIMEOUT_MICROS);
    out[name] = p;
  }
  _parsersByLang = out;
  return out;
}

function stripQuotes(s) {
  if (!s) return s;
  const t = s.trim();
  return (t.length >= 2 && /^["'`]/.test(t)) ? t.slice(1, -1) : t;
}

function declaredNames(decl) {
  if (!decl) return [];
  switch (decl.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "class_declaration":
    case "abstract_class_declaration":
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration": {
      const n = decl.childForFieldName("name");
      return n ? [n.text] : [];
    }
    case "lexical_declaration":
    case "variable_declaration": {
      const names = [];
      for (const d of decl.namedChildren) {
        if (d.type === "variable_declarator") {
          const n = d.childForFieldName("name");
          if (n && n.type === "identifier") names.push(n.text);
        }
      }
      return names;
    }
    default:
      return [];
  }
}

/**
 * Walk a parsed tree and extract the symbol schema.
 * @returns {{ exports: string[], classes: Array<{name,methods}>, imports: string[] }}
 */
export function extractSymbols(tree) {
  const exportsSet = new Set();
  const importsSet = new Set();
  const classes = [];

  const walk = (node) => {
    switch (node.type) {
      case "import_statement": {
        const src = node.childForFieldName("source");
        if (src) importsSet.add(stripQuotes(src.text));
        break;
      }
      case "call_expression": {
        const fn = node.childForFieldName("function");
        if (fn && fn.text === "require") {
          const args = node.childForFieldName("arguments");
          if (args) for (const a of args.namedChildren) {
            if (a.type === "string") importsSet.add(stripQuotes(a.text));
          }
        }
        break;
      }
      case "class_declaration":
      case "abstract_class_declaration":
      case "class": {
        const nameNode = node.childForFieldName("name");
        const body = node.childForFieldName("body");
        const methods = [];
        if (body) for (const m of body.namedChildren) {
          if (m.type === "method_definition") {
            const mn = m.childForFieldName("name");
            const params = m.childForFieldName("parameters");
            if (mn) methods.push({ name: mn.text, signature: `${mn.text}${params ? params.text : "()"}` });
          }
        }
        if (nameNode) classes.push({ name: nameNode.text, methods });
        break;
      }
      case "export_statement": {
        const decl = node.childForFieldName("declaration");
        for (const nm of declaredNames(decl)) exportsSet.add(nm);
        for (const c of node.namedChildren) {
          if (c.type === "export_clause") {
            for (const spec of c.namedChildren) {
              if (spec.type === "export_specifier") {
                const nm = spec.childForFieldName("name") || spec.namedChildren[0];
                if (nm) exportsSet.add(nm.text);
              }
            }
          }
        }
        if (node.text.trimStart().startsWith("export default")) exportsSet.add("default");
        break;
      }
      case "assignment_expression": {
        // CommonJS: module.exports.X = … / exports.X = …
        const left = node.childForFieldName("left");
        if (left && left.type === "member_expression") {
          const obj = left.childForFieldName("object");
          const prop = left.childForFieldName("property");
          const objText = obj ? obj.text : "";
          if (prop && (objText === "exports" || objText === "module.exports")) {
            exportsSet.add(prop.text);
          }
        }
        break;
      }
    }
    for (const c of node.namedChildren) walk(c);
  };

  walk(tree.rootNode);
  return {
    exports: [...exportsSet],
    classes,
    imports: [...importsSet],
  };
}

/**
 * Parse source text for the given language name and extract its symbols.
 * Returns null when the language is unsupported or the parse is aborted by the
 * timeout (over-budget file).
 */
export async function extractFromSource(source, langName) {
  const parsers = await initParsers();
  const parser = parsers[langName];
  if (!parser) return null;
  const tree = parser.parse(source);
  if (!tree) return null; // parse aborted (timeout)
  return extractSymbols(tree);
}
