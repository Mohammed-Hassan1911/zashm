import { clearOrderConfirmation, readOrderConfirmation, saveOrderConfirmation } from '../src/lib/orderConfirmation.mjs';

const values = new Map();
globalThis.sessionStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
};

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${message}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${message}`);
  }
}

console.log('\n[1] order confirmation session persistence');
const order = {
  id: 'ZSH-123',
  customer: 'Private Customer',
  phone: '01012345678',
  address: 'Private Address',
  total: 1450,
  subtotal: 1500,
  discount: 100,
  shippingCost: 50,
  city: 'Cairo',
  tracking_url: '/track?order=ZSH-123',
  items: [{ productId: 7, name: 'Jacket', size: 'M', color: 'Black', qty: 1, price: 1500 }],
};

ok(saveOrderConfirmation(order), 'a valid order confirmation is saved');
const stored = values.get('zashm_order_confirmation');
ok(!stored.includes('Private Customer') && !stored.includes('01012345678') && !stored.includes('Private Address'),
  'customer contact details are excluded from session storage');
ok(readOrderConfirmation()?.id === 'ZSH-123' && readOrderConfirmation()?.items[0]?.name === 'Jacket',
  'saved confirmation can be restored after a page reload');
clearOrderConfirmation();
ok(readOrderConfirmation() === null, 'confirmation is cleared when the customer leaves the confirmation page');
values.set('zashm_order_confirmation', '{invalid');
ok(readOrderConfirmation() === null && !values.has('zashm_order_confirmation'),
  'malformed saved confirmation is rejected and removed');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
