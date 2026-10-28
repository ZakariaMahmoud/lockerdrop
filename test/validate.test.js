import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCode,
  isValidCode,
  isValidFileId,
  sanitizeFileName,
  sanitizeWorkspaceName,
} from '../src/validate.js';

test('isValidCode accepts 4–8 chars of 1-9 and letters', () => {
  for (const code of ['abcd', 'A1b2', 'Zz9Yy8Xx', '1234']) assert.equal(isValidCode(code), true, code);
});

test('isValidCode rejects zero, symbols, wrong length and non-strings', () => {
  for (const code of ['abc', 'abcdefghi', 'ab0d', 'ab-d', 'ab d', '', 'ééée', null, 1234]) {
    assert.equal(isValidCode(code), false, String(code));
  }
});

test('generateCode produces valid codes of the requested length', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateCode();
    assert.equal(code.length, 8);
    assert.equal(isValidCode(code), true, code);
  }
  assert.equal(generateCode(5).length, 5);
  assert.doesNotMatch(Array.from({ length: 200 }, () => generateCode()).join(''), /[IlO]/);
});

test('isValidFileId only accepts 32 lowercase hex chars', () => {
  assert.equal(isValidFileId('a'.repeat(32)), true);
  assert.equal(isValidFileId('../'.padEnd(32, 'a')), false);
  assert.equal(isValidFileId('A'.repeat(32)), false);
  assert.equal(isValidFileId(undefined), false);
});

test('sanitizeFileName strips path separators and control chars', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitizeFileName('a\\b\u0000c.txt'), 'a_b_c.txt');
  assert.equal(sanitizeFileName('  rapport final.pdf '), 'rapport final.pdf');
  assert.equal(sanitizeFileName('..'), null);
  assert.equal(sanitizeFileName('   '), null);
  assert.equal(sanitizeFileName(42), null);
  assert.equal(Array.from(sanitizeFileName('😀'.repeat(300))).length, 200);
});

test('sanitizeWorkspaceName trims, limits and rejects empty', () => {
  assert.equal(sanitizeWorkspaceName('  Course files \n'), 'Course files');
  assert.equal(sanitizeWorkspaceName(''), null);
  assert.equal(sanitizeWorkspaceName(undefined), null);
  assert.equal(sanitizeWorkspaceName('x'.repeat(100)).length, 60);
});

test('names lose invisible direction-override characters', () => {
  // "invoice<RLO>fdp.exe" would display as "invoiceexe.pdf".
  assert.equal(sanitizeFileName('invoice\u202Efdp.exe'), 'invoicefdp.exe');
  assert.equal(sanitizeFileName('a\u2066b\u2069c\u200Fd\u200E.txt'), 'abcd.txt');
  assert.equal(sanitizeFileName('\u202E'), null);
  assert.equal(sanitizeWorkspaceName('Week\u202E 3'), 'Week 3');
});
