/**
 * schema-validator.js — Lightweight JSON Schema validator (E-12)
 *
 * Validates payloads against JSON Schema Draft-07 sub-set used by AI-OS
 * state transition schemas (src/shared/schemas/state.json).
 *
 * Supported keywords:
 *   type, enum, required, additionalProperties,
 *   minLength, maxLength, pattern (strings),
 *   minimum, maximum (numbers/integers),
 *   items (arrays — validates each element against item schema)
 *
 * No external dependencies — pure Node.js ES module.
 *
 * Exports:
 *   validate(schema, payload) → { valid: boolean, errors: string[] }
 *   loadSchemas(schemasPath?)  → object  (reads state.json, returns .schemas)
 *   validateNamed(name, payload, schemasPath?) → { valid, errors }
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMAS_PATH = resolve(__dirname, "schemas", "state.json");

// ── Core validator ────────────────────────────────────────────────────────────

/**
 * Validate a payload against a JSON Schema (Draft-07 sub-set).
 * Returns { valid: boolean, errors: string[] }.
 */
export function validate(schema, payload, path = "") {
  const errors = [];
  _validateNode(schema, payload, path || "<root>", errors);
  return { valid: errors.length === 0, errors };
}

function _validateNode(schema, value, path, errors) {
  if (!schema || typeof schema !== "object") return;

  // ── type ─────────────────────────────────────────────────────────────────
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => _matchesType(t, value))) {
      errors.push(`${path}: expected type ${types.join("|")}, got ${_typeOf(value)}`);
      return; // further checks on wrong type are noise
    }
  }

  // ── enum ─────────────────────────────────────────────────────────────────
  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: must be one of [${schema.enum.map(v => JSON.stringify(v)).join(", ")}], got ${JSON.stringify(value)}`);
    }
  }

  // ── string constraints ────────────────────────────────────────────────────
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: minLength is ${schema.minLength}, got ${value.length}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: maxLength is ${schema.maxLength}, got ${value.length}`);
    }
    if (schema.pattern !== undefined) {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        errors.push(`${path}: must match pattern ${schema.pattern}`);
      }
    }
  }

  // ── number / integer constraints ──────────────────────────────────────────
  if (typeof value === "number") {
    if (schema.type === "integer" && !Number.isInteger(value)) {
      errors.push(`${path}: must be an integer, got ${value}`);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: minimum is ${schema.minimum}, got ${value}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: maximum is ${schema.maximum}, got ${value}`);
    }
  }

  // ── object constraints ────────────────────────────────────────────────────
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    // required
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) {
          errors.push(`${path}: missing required property '${key}'`);
        }
      }
    }

    // additionalProperties: false
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${path}: additional property '${key}' is not allowed`);
        }
      }
    }

    // recurse into properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          _validateNode(propSchema, value[key], `${path}.${key}`, errors);
        }
      }
    }
  }

  // ── array constraints ─────────────────────────────────────────────────────
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: minItems is ${schema.minItems}, got ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: maxItems is ${schema.maxItems}, got ${value.length}`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        _validateNode(schema.items, item, `${path}[${i}]`, errors);
      });
    }
  }
}

function _matchesType(type, value) {
  switch (type) {
    case "string":  return typeof value === "string";
    case "number":  return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null":    return value === null;
    case "array":   return Array.isArray(value);
    case "object":  return value !== null && typeof value === "object" && !Array.isArray(value);
    default:        return true;
  }
}

function _typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ── Schema loader ─────────────────────────────────────────────────────────────

let _schemasCache = null;

/**
 * Load and return the AI-OS state transition schemas.
 * Caches after first read. Pass schemasPath to override the default location.
 */
export function loadSchemas(schemasPath) {
  if (!schemasPath && _schemasCache) return _schemasCache;
  const path = schemasPath || DEFAULT_SCHEMAS_PATH;
  const raw  = JSON.parse(readFileSync(path, "utf8"));
  if (raw.version !== "1.0" || !raw.schemas) {
    throw new Error(`schema-validator: unexpected schema file format at ${path}`);
  }
  if (!schemasPath) _schemasCache = raw.schemas;
  return raw.schemas;
}

/**
 * Validate a payload against a named schema (e.g. "task_create").
 * Returns { valid: boolean, errors: string[], schemaName: string }.
 */
export function validateNamed(schemaName, payload, schemasPath) {
  const schemas = loadSchemas(schemasPath);
  if (!schemas[schemaName]) {
    return {
      valid:  false,
      errors: [`Unknown schema: '${schemaName}'. Available: ${Object.keys(schemas).join(", ")}`],
      schemaName,
    };
  }
  const result = validate(schemas[schemaName], payload);
  return { ...result, schemaName };
}
