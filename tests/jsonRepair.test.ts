// Auto-tests: lenient JSON-object repair (Help001). Zero deps, pure logic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { looseParseObject } from "../src/model/jsonRepair.ts";

test("valid JSON is parsed unchanged (incl. nested objects)", () => {
  assert.deepEqual(looseParseObject('{"path":"a.txt"}'), { path: "a.txt" });
  assert.deepEqual(looseParseObject('{"a":{"b":1},"c":[1,2]}'), { a: { b: 1 }, c: [1, 2] });
});

test("repairs single-quoted strings and keys", () => {
  assert.deepEqual(looseParseObject("{'path':'a.txt'}"), { path: "a.txt" });
  assert.deepEqual(looseParseObject("{'name':'read_file','arguments':{'path':'a.txt'}}"), {
    name: "read_file",
    arguments: { path: "a.txt" },
  });
});

test("repairs a trailing comma", () => {
  assert.deepEqual(looseParseObject('{"path":"a.txt",}'), { path: "a.txt" });
  assert.deepEqual(looseParseObject('{"a":1,"b":2,}'), { a: 1, b: 2 });
});

test("repairs unquoted (bare) keys", () => {
  assert.deepEqual(looseParseObject('{path:"a.txt"}'), { path: "a.txt" });
  assert.deepEqual(looseParseObject("{path:'a.txt', n:5}"), { path: "a.txt", n: 5 });
});

test("repairs Python literals True/False/None", () => {
  assert.deepEqual(looseParseObject('{"flag":True,"off":False,"x":None}'), { flag: true, off: false, x: null });
});

test("repairs smart quotes", () => {
  assert.deepEqual(looseParseObject("{“path”:“a.txt”}"), { path: "a.txt" });
});

test("repairs a truncated object (missing closing brace)", () => {
  assert.deepEqual(looseParseObject('{"path":"a.txt"'), { path: "a.txt" });
  assert.deepEqual(looseParseObject('{"a":{"b":1}'), { a: { b: 1 } });
});

test("A4: a truncated mid-string value is NOT completed (returns null, fail-safe)", () => {
  assert.equal(looseParseObject('{"path":"a.txt","content":"function f() {'), null); // cut off inside a value
  assert.equal(looseParseObject("{'content':'partial value"), null);
  assert.equal(looseParseObject('{"a":"b","c":"unclosed'), null);
  // brace-only truncation (strings closed) still recovers — proves we only refuse an OPEN string, not all truncation
  assert.deepEqual(looseParseObject('{"path":"a.txt"'), { path: "a.txt" });
});

test("A5: smart/curly quotes — preserved inside values, straightened as delimiters", () => {
  assert.deepEqual(looseParseObject('{"msg":"she said “hi”"}'), { msg: "she said “hi”" }); // curly INSIDE a value kept verbatim
  assert.deepEqual(looseParseObject("{“cmd”:“echo }”}"), { cmd: "echo }" }); // curly delimiters + a brace inside the value
  assert.deepEqual(looseParseObject("{‘path’:‘a.txt’}"), { path: "a.txt" }); // curly single-quote delimiters
});

test("does NOT corrupt quotes/braces that live inside string values", () => {
  // already valid JSON -> returned as-is, apostrophe + inner brace untouched
  assert.deepEqual(looseParseObject('{"msg":"it\'s fine"}'), { msg: "it's fine" });
  assert.deepEqual(looseParseObject('{"command":"echo \'}\'"}'), { command: "echo '}'" });
  // single-quoted object whose double-quoted-equivalent value contains an apostrophe
  assert.deepEqual(looseParseObject("{'a':1,'b':'x'}"), { a: 1, b: "x" });
});

test("returns null for arrays, non-objects, and unrecoverable garbage (never throws)", () => {
  assert.equal(looseParseObject("[1,2,3]"), null);
  assert.equal(looseParseObject("just some prose"), null);
  assert.equal(looseParseObject("{not real json at all"), null); // bare unquoted value -> not guessed
  assert.equal(looseParseObject(""), null);
  assert.equal(looseParseObject("42"), null);
});

test("extracts the object even with surrounding prose", () => {
  assert.deepEqual(looseParseObject('Sure: {"path":"a.txt"} done'), { path: "a.txt" });
});
