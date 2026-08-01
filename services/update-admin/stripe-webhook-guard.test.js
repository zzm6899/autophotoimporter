const test = require('node:test');
const assert = require('node:assert/strict');
const { isKeptraLicenseCheckout } = require('./stripe-webhook-guard');

test('ignores a Watermark Vault booking checkout', () => {
  assert.equal(isKeptraLicenseCheckout({ app: 'watermark-vault', type: 'booking-deposit' }), false);
});

test('accepts an explicitly tagged Keptra license checkout', () => {
  assert.equal(isKeptraLicenseCheckout({ checkout_source: 'keptra-license', plan: 'lifetime' }), true);
});
