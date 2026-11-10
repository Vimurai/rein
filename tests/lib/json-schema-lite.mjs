// json-schema-lite.mjs — the subset of JSON Schema 2020-12 the published contract schemas use
// (E-422; D-153 r4, D-155; release-artifact.md §Component 6). Built-ins only: no new dependency.
//
//   import { validate } from "./json-schema-lite.mjs";
//   validate(schema, value) → [] when valid, else ["<json pointer>: <why>", …]
//   node tests/lib/json-schema-lite.mjs <schema.json> <document.json>   (exit 0 valid, 1 invalid, 2 usage)
//
// Keywords: $ref (to "#/$defs/<name>" only), type (one or a list), const, enum, pattern,
// minLength, minimum, required, properties, additionalProperties (boolean or schema), propertyNames, items,
// minItems, uniqueItems. Any other keyword in a schema is an error, so a schema can never
// assert something this validator silently ignores.
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KNOWN = new Set(["$schema", "$id", "$defs", "$ref", "title", "description", "type", "const", "enum",
  "pattern", "minLength", "minimum", "required", "properties", "additionalProperties", "propertyNames", "items", "minItems", "uniqueItems"]);

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

export function validate(schema, value, root = schema, at = "") {
  const errs = [];
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) errs.push(`${at || "/"}: schema keyword '${k}' is not supported`);
  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m && root.$defs?.[m[1]];
    if (!target) return [...errs, `${at || "/"}: unresolvable $ref ${schema.$ref}`];
    return [...errs, ...validate(target, value, root, at)];
  }
  const t = typeOf(value);
  if (schema.type) {
    const want = [].concat(schema.type);
    if (!want.some((w) => w === t || (w === "number" && t === "integer"))) return [...errs, `${at || "/"}: is ${t}, want ${want.join("|")}`];
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) errs.push(`${at || "/"}: is not ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${at || "/"}: ${JSON.stringify(value)} not in enum`);
  if (t === "string") {
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errs.push(`${at || "/"}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errs.push(`${at || "/"}: shorter than ${schema.minLength}`);
  }
  if ((t === "integer" || t === "number") && schema.minimum !== undefined && value < schema.minimum) errs.push(`${at || "/"}: below ${schema.minimum}`);
  if (t === "object") {
    for (const r of schema.required ?? []) if (!(r in value)) errs.push(`${at || "/"}: missing '${r}'`);
    for (const [k, v] of Object.entries(value)) {
      const p = `${at}/${k}`;
      if (schema.propertyNames) errs.push(...validate(schema.propertyNames, k, root, `${p} (name)`));
      if (schema.properties && k in schema.properties) errs.push(...validate(schema.properties[k], v, root, p));
      else if (schema.additionalProperties === false) errs.push(`${p}: not allowed`);
      else if (typeof schema.additionalProperties === "object") errs.push(...validate(schema.additionalProperties, v, root, p));
    }
  }
  if (t === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${at || "/"}: fewer than ${schema.minItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errs.push(`${at || "/"}: items are not unique`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, root, `${at}/${i}`)));
  }
  return errs;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [s, d] = process.argv.slice(2);
  if (!s || !d) { process.stderr.write("usage: json-schema-lite.mjs <schema.json> <document.json>\n"); process.exit(2); }
  const errs = validate(JSON.parse(readFileSync(s, "utf8")), JSON.parse(readFileSync(d, "utf8")));
  for (const e of errs.slice(0, 20)) process.stdout.write(`${e}\n`);
  process.exit(errs.length ? 1 : 0);
}
