import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BRACKETS,
  STD_DEDUCTION,
  calculateTax,
  marginalRate,
  tax,
} from '../src/tax.js';

test('zero income produces zero tax and 0.0% effective and marginal rates', () => {
  const result = calculateTax(0);
  assert.deepEqual(result, {
    gross_income: 0,
    taxable: 0,
    tax: 0,
    effectiveRate: 0,
    marginalRate: 0,
    afterTax: 0,
  });
});

test('income below standard deduction has zero taxable income and zero tax', () => {
  const result = calculateTax(10000);
  assert.deepEqual(result, {
    gross_income: 10000,
    taxable: 0,
    tax: 0,
    effectiveRate: 0,
    marginalRate: 0,
    afterTax: 10000,
  });
});

test('taxable income exactly on 10% bracket edge (11,925)', () => {
  const gross = STD_DEDUCTION + 11925;
  const result = calculateTax(gross);
  assert.equal(result.taxable, 11925);
  assert.equal(result.tax, 1192.5);
  assert.equal(result.marginalRate, 0.10);
  assert.equal(result.afterTax, gross - 1192.5);
  assert.equal(tax(11925), 1192.5);
  assert.equal(marginalRate(11925), 0.10);
});

test('taxable income just above 10% bracket edge falls into 12% bracket', () => {
  const gross = STD_DEDUCTION + 11926;
  const result = calculateTax(gross);
  assert.equal(result.taxable, 11926);
  assert.equal(result.marginalRate, 0.12);
  assert.equal(marginalRate(11926), 0.12);
});

test('taxable income on 12% bracket edge (48,475)', () => {
  const gross = STD_DEDUCTION + 48475;
  const result = calculateTax(gross);
  assert.equal(result.taxable, 48475);
  assert.equal(result.marginalRate, 0.12);
  assert.equal(marginalRate(48475), 0.12);
});

test('income in the 37% bracket', () => {
  // 37% bracket applies to taxable income over 626,350
  const gross = STD_DEDUCTION + 700000;
  const result = calculateTax(gross);
  assert.equal(result.taxable, 700000);
  assert.equal(result.marginalRate, 0.37);
  assert.equal(marginalRate(700000), 0.37);
  assert.ok(result.tax > 0);
  assert.equal(result.afterTax, gross - result.tax);
});

test('rejects negative or non-finite gross_income', () => {
  assert.throws(() => calculateTax(-100), /gross_income must be a finite, non-negative number/);
  assert.throws(() => calculateTax(NaN), /gross_income must be a finite, non-negative number/);
  assert.throws(() => calculateTax(Infinity), /gross_income must be a finite, non-negative number/);
  assert.throws(() => calculateTax('50000'), /gross_income must be a finite, non-negative number/);
});

test('exports standard deduction and 2026 brackets array', () => {
  assert.equal(STD_DEDUCTION, 15750);
  assert.equal(BRACKETS.length, 7);
  assert.deepEqual(BRACKETS[0], [11925, 0.10]);
  assert.deepEqual(BRACKETS[6], [Infinity, 0.37]);
});
