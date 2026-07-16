import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonFromText } from "../src/runtime/json-extract.js";

test("extracts fenced json block", () => {
  const text = 'Before\n```json\n{"verified":true}\n```\nAfter';
  assert.deepEqual(extractJsonFromText(text), { verified: true });
});

test("extracts unfenced object", () => {
  assert.deepEqual(extractJsonFromText('noise {"a":1} noise'), { a: 1 });
});

test("uses the first fenced block when several exist", () => {
  const text = '```json\n{"a":1}\n```\ntext\n```json\n{"a":2}\n```';
  assert.deepEqual(extractJsonFromText(text), { a: 1 });
});

test("returns null for invalid json", () => {
  assert.equal(extractJsonFromText("```json\n{broken\n```"), null);
});

test("returns null when no object present", () => {
  assert.equal(extractJsonFromText("no json here"), null);
});
