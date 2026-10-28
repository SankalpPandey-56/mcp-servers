#!/usr/bin/env node
import { serve, money } from './_shared.js';
import { BRACKETS, STD_DEDUCTION, tax, marginalRate, calculateTax } from './tax.js';

serve('mcp-tax-calc', '1.0.0', [
  {
    name: 'us_federal_tax',
    desc: 'Estimate 2026 US federal income tax (single filer, standard deduction): gross annual income.',
    schema: { type: 'object', properties: { gross_income: { type: 'number' } }, required: ['gross_income'] },
    handler: async ({ gross_income }) => {
      if (typeof gross_income !== 'number' || !Number.isFinite(gross_income) || gross_income < 0) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Error: gross_income must be a finite, non-negative number.' }],
        };
      }

      const { taxable, tax: t, effectiveRate, marginalRate: marginal, afterTax } = calculateTax(gross_income);
      return {
        content: [
          {
            type: 'text',
            text: `Taxable income: $${money(taxable)}\nEstimated federal tax: $${money(t)}\nEffective rate: ${effectiveRate.toFixed(1)}%\nMarginal rate: ${(marginal * 100).toFixed(1)}%\nAfter-tax: $${money(afterTax)}`,
          },
        ],
      };
    },
  },
]);
