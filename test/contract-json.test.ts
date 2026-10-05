import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractJsonError, parseContractJson } from '../src/util/contract-json.js';
import { assertSupportedJsonSchema, validateJsonSchema } from '../src/util/json-schema.js';
import { selectContractResponseText } from '../src/runtime/read/hybrid-reader.js';

test('shared recovery preserves controls, invalid source escapes and unambiguous raw quotes', () => {
  const source = String.raw`{"content":"tree.append(f"{indent}{name}/")\nout.write("=== FILES ===")\nif b\"\x00\" in chunk:\n    return False\npattern = r\"\d+\""}`;
  const parsed = parseContractJson(source);
  assert.deepEqual(parsed.value, { content: 'tree.append(f"{indent}{name}/")\nout.write("=== FILES ===")\nif b"\\x00" in chunk:\n    return False\npattern = r"\\d+"' });
  assert.equal(parsed.repaired, true);
  assert.deepEqual(parseContractJson('{"content":"  one\n\ttwo\n"}').value, { content: '  one\n\ttwo\n' });
});

test('presentation and lexical repairs preserve values without inventing missing data', () => {
  assert.deepEqual(parseContractJson('JSON\n{bare_key: \'hello\', /* comment */ list: [1,2,],}').value, { bare_key: 'hello', list: [1,2] });
  assert.deepEqual(parseContractJson('{“content”:“ação”}').value, { content: 'ação' });
  assert.deepEqual(parseContractJson('```json\n{"content":"```json\\n{}\\n```"}\n```').value, { content: '```json\n{}\n```' });
  for (const source of ['{"x":1', '{"x":"cut', '{"x":tru}', '{"x":1} {"x":2}', '{"x":1,"x":2}', 'Example: {"x":1}', '{"x":1}/*unfinished']) {
    assert.throws(() => parseContractJson(source), ContractJsonError, source);
  }
});

test('quote repair rejects the interpretation that swallows a neighboring optional field', () => {
  assert.throws(() => parseContractJson('{"path":"x.py","content":"print("hello")","mode":"append"}'), /Multiple possible JSON interpretations/);
});

test('valid source strings remain byte exact and recovery remains bounded', () => {
  const content = '  <tool_call>{"x":"y"}</tool_call>\r\n\t# ação 😀\n';
  const source = JSON.stringify({content});
  assert.deepEqual(parseContractJson(source).value, {content});
  assert.equal(parseContractJson(source).repaired, false);
  assert.throws(() => parseContractJson('['.repeat(66) + '0' + ']'.repeat(66)), /nesting limit/);
  assert.throws(() => parseContractJson('x'.repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
  assert.deepEqual(parseContractJson(JSON.stringify(Array.from({length: 300}, (_, i) => String(i)))).value, Array.from({length: 300}, (_, i) => String(i)));
});

test('schema compositions retain root references and enforce previously ignored constraints', () => {
  const schema = { type:'object', $defs:{X:{type:'integer'}}, properties:{x:{anyOf:[{$ref:'#/$defs/X'},{type:'null'}]}}, required:['x'] };
  assert.equal(validateJsonSchema({x:1}, schema).valid, true);
  assert.equal(validateJsonSchema({x:'bad'}, schema).valid, false);
  assert.equal(validateJsonSchema('forbidden', {type:'string',not:{const:'forbidden'}}).valid, false);
  assert.equal(validateJsonSchema({x:1}, {...schema, properties:{x:{oneOf:[{$ref:'#/$defs/X'},{type:'null'}]}}}).valid, true);
  const value = {x:'1'};
  assert.equal(validateJsonSchema(value, {type:'object',properties:{x:{type:'integer'}}}).valid, false);
  assert.deepEqual(value, {x:'1'});
  assert.throws(() => assertSupportedJsonSchema({type:'object',unknownConstraint:true}), /unsupported JSON Schema/);
  assert.throws(() => assertSupportedJsonSchema({$ref:'https://external.invalid/schema'}), /unsupported JSON Schema/);
  assert.equal(validateJsonSchema('not-a-uuid', {type:'string',format:'uuid'}).valid, false);
  assert.equal(validateJsonSchema('2026-02-30', {type:'string',format:'date'}).valid, false);
  assert.throws(() => assertSupportedJsonSchema({type:'string',format:'unknown-format'}), /unsupported JSON Schema/);
  assert.equal(validateJsonSchema({}, {type:'object',required:['a/b~c']}).issues[0]?.path, '$/a~1b~0c');
});

test('buffered contracts recover renderer corruption only from an eligible completed raw stream', () => {
  const raw = '```json\n{"action":"use_tool","tool":"write_file","tool_input":{"content":"<div>hello</div>"}}\n```';
  assert.equal(selectContractResponseText('json\nBROKEN', raw, true), raw);
  assert.equal(selectContractResponseText('json\nBROKEN', raw, false), 'json\nBROKEN');
  assert.equal(selectContractResponseText('{"a":1,"b":2}', '{"b":2,"a":1}', true), '{"b":2,"a":1}');
  assert.throws(() => selectContractResponseText('{"action":"final_response"}', raw, true), /different valid contract/);
  assert.equal(selectContractResponseText('{"ok":true}', '{"cut":', true), '{"ok":true}');
});

test('missing punctuation is recovered only between complete grammar tokens', () => {
  assert.deepEqual(parseContractJson('{"path" "x.py" "count":2 "list":[true false 1 2 "a" "b"]}').value,
    {path:'x.py',count:2,list:[true,false,1,2,'a','b']});
  assert.throws(() => parseContractJson('{"content":undefined}'), ContractJsonError);
  assert.throws(() => parseContractJson('{"content":NaN}'), ContractJsonError);
});

test('the raw reader preserves tool envelopes stripped by HTML rendering', () => {
  const body = '{"name":"write_file","arguments":{"path":"x.html","content":"<div>hello</div>"}}';
  const raw = '<tool_call>' + body + '</tool_call>';
  assert.equal(selectContractResponseText(body, raw, true), raw);
  assert.equal(selectContractResponseText('HTML lost the source', raw, true), raw);
  const literal = JSON.stringify({content:raw});
  assert.equal(selectContractResponseText('HTML lost the source', literal, true), literal);
});
