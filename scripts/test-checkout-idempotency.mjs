import { clearCheckoutIdempotencyKey, getCheckoutIdempotencyKey } from '../src/lib/orderIdempotency.mjs';

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  }
}
function ok(value, label) { eq(Boolean(value), true, label); }

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) || null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

console.log('\n[1] persistent checkout idempotency');
{
  const storage = new MemoryStorage();
  const cart = [
    { product: { id: 17 }, qty: 2, size: 'M', color: 'Black' },
    { product: { id: 9 }, qty: 1, size: 'S', color: 'White' },
  ];
  const key = getCheckoutIdempotencyKey(cart, [storage]);
  ok(/^[a-f0-9]{64}$/.test(key), 'key has 256 bits of cryptographic randomness');
  eq(getCheckoutIdempotencyKey(cart, [storage]), key, 'retry reuses the saved key');
  eq(getCheckoutIdempotencyKey([...cart].reverse(), [storage]), key, 'cart line order does not change the key');
  eq(getCheckoutIdempotencyKey([{ ...cart[0], qty: 1 }, cart[1]], [storage]) === key, false,
    'a changed cart gets a new idempotency key');
}

console.log('\n[2] safe key lifecycle');
{
  const storage = new MemoryStorage();
  const cart = [{ productId: 123, qty: 1, size: 'L', color: 'Blue' }];
  const first = getCheckoutIdempotencyKey(cart, [storage]);
  clearCheckoutIdempotencyKey('0'.repeat(64), [storage]);
  eq(getCheckoutIdempotencyKey(cart, [storage]), first, 'a different key cannot clear the pending checkout');
  clearCheckoutIdempotencyKey(first, [storage]);
  eq(getCheckoutIdempotencyKey(cart, [storage]) === first, false, 'successful checkout clears only its matching key');
  let emptyRejected = false;
  try { getCheckoutIdempotencyKey([], [storage]); } catch (e) { emptyRejected = true; }
  eq(emptyRejected, true, 'empty cart cannot get an idempotency key');
  let storageRejected = false;
  try { getCheckoutIdempotencyKey(cart, []); } catch (e) { storageRejected = true; }
  eq(storageRejected, true, 'checkout fails visibly if no persistent storage is available');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
