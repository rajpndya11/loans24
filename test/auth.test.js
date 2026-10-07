import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'x'.repeat(40);
const { normalisePhone, maskPhone } = await import('../server/auth.js');

test('phone numbers are normalised to 10 digits', () => {
  assert.equal(normalisePhone('98765 43210'), '9876543210');
  assert.equal(normalisePhone('+91-98765-43210'), '9876543210');
  assert.equal(normalisePhone('09876543210'), '9876543210');
  assert.equal(normalisePhone('919876543210'), '9876543210');
  assert.equal(normalisePhone('1234567890'), null); // Indian mobiles start 6-9
  assert.equal(normalisePhone('98765'), null);
});

test('phone numbers are masked for display', () => {
  assert.equal(maskPhone('9876543210'), '98xxxxxx10');
});
