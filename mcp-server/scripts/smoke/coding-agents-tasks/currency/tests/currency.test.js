const test = require('node:test');
const assert = require('node:assert');
const { formatPrice } = require('../src/money.js');
const { Cart } = require('../src/cart.js');
const { invoiceLine } = require('../src/invoice.js');

test('USD is still the default', () => {
  assert.strictEqual(formatPrice(150), '$1.50');
  assert.strictEqual(formatPrice(150, 'USD'), '$1.50');
});
test('EUR uses a comma and a trailing euro sign', () => assert.strictEqual(formatPrice(150, 'EUR'), '1,50 €'));
test('GBP uses the pound sign', () => assert.strictEqual(formatPrice(99, 'GBP'), '£0.99'));
test('unknown currency throws RangeError', () => assert.throws(() => formatPrice(1, 'XYZ'), RangeError));
test('cart defaults to USD', () => {
  const c = new Cart();
  c.add('pen', 150, 2);
  assert.strictEqual(c.summary(), 'pen x2: $3.00\nTotal: $3.00');
});
test('cart uses its currency everywhere', () => {
  const c = new Cart('EUR');
  c.add('pen', 150, 2);
  c.add('ink', 50);
  assert.strictEqual(c.summary(), 'pen x2: 3,00 €\nink x1: 0,50 €\nTotal: 3,50 €');
});
test('invoice line defaults to USD', () => assert.strictEqual(invoiceLine({ name: 'pen', cents: 150 }), 'pen\t$1.50'));
test('invoice line takes a currency', () => assert.strictEqual(invoiceLine({ name: 'pen', cents: 150 }, 'GBP'), 'pen\t£1.50'));
