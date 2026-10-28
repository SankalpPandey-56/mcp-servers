import { money } from './_shared.js';

// 2026 US federal brackets (single filer, approximate planning values)
export const BRACKETS = [
  [11925, 0.10], [48475, 0.12], [103350, 0.22], [197300, 0.24],
  [250525, 0.32], [626350, 0.35], [Infinity, 0.37],
];
export const STD_DEDUCTION = 15750;

export function tax(taxable) {
  let t = 0, prev = 0;
  for (const [cap, rate] of BRACKETS) {
    if (taxable > prev) {
      t += (Math.min(taxable, cap) - prev) * rate;
      prev = cap;
    } else break;
  }
  return t;
}

export function marginalRate(taxable) {
  if (taxable <= 0) return 0;
  for (const [cap, rate] of BRACKETS) {
    if (taxable <= cap) {
      return rate;
    }
  }
  return 0.37;
}

export function calculateTax(gross_income) {
  if (typeof gross_income !== 'number' || !Number.isFinite(gross_income) || gross_income < 0) {
    throw new Error('gross_income must be a finite, non-negative number');
  }

  const taxable = Math.max(0, gross_income - STD_DEDUCTION);
  const t = tax(taxable);
  const effectiveRate = gross_income === 0 ? 0 : (100 * t / gross_income);
  const marginal = marginalRate(taxable);
  const afterTax = gross_income - t;

  return {
    gross_income,
    taxable,
    tax: t,
    effectiveRate,
    marginalRate: marginal,
    afterTax,
  };
}
