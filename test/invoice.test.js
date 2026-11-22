const assert = require('node:assert/strict');
const test = require('node:test');

const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function billedOrder(items, coupon = '') {
  const totals = pricing.computeTotals(items, coupon);
  const db = { nextOrderId: 1001, orders: [] };
  const order = orders.add(db, { ...totals, items, coupon, date: '22/11/2026' });
  return { order, totals };
}

function figures({ subtotal, discount, tax, cgst, sgst, total }) {
  return { subtotal, discount, tax, cgst, sgst, total };
}

test('invoice and billing agree on a whole percentage GST rate without a coupon', () => {
  const { order, totals } = billedOrder([
    { id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 50, qty: 2, gstRate: 5 }
  ]);
  const expected = { subtotal: 100, discount: 0, tax: 5, cgst: 2.5, sgst: 2.5, total: 105 };

  assert.deepStrictEqual(figures(totals), expected);
  assert.deepStrictEqual(invoice.computeInvoiceFigures(order), {
    ...expected,
    rows: [{
      name: 'Rice', sku: 'RICE', hsn: '1006', qty: 2, price: 50,
      gstPercent: 5, line: 100, lineTax: 5
    }]
  });

  const html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td class="r">₹105\.00/);
  assert.doesNotMatch(html, /Coupon Discount|Accountant Reconciliation Notice/);
});

test('invoice renders a stored string price with two decimal places', () => {
  const { order } = billedOrder([
    { id: 1, name: 'Rice', hsn: '1006', price: '100.00', qty: 1 }
  ]);

  assert.match(invoice.render(order), /<td class="r">₹100\.00<\/td><td class="r">5%<\/td>/);
});

test('invoice matches the billed total and GST for mixed HSN rates with a percentage coupon', () => {
  // Checkout stores the HSN on each line and leaves the GST rate implicit.
  const { order, totals } = billedOrder([
    { id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 200, qty: 2 },
    { id: 2, name: 'Ghee', sku: 'GHEE', hsn: '0405', price: 200, qty: 1 }
  ], 'SAVE10');

  assert.deepStrictEqual(figures(totals), {
    subtotal: 600, discount: 60, tax: 39.60, cgst: 19.80, sgst: 19.80, total: 579.60
  });
  assert.deepStrictEqual(totals.lines.map(({ gstPercent, discount, taxable, tax }) => ({
    gstPercent, discount, taxable, tax
  })), [
    { gstPercent: 5, discount: 40, taxable: 360, tax: 18 },
    { gstPercent: 12, discount: 20, taxable: 180, tax: 21.60 }
  ]);
  assert.equal(order.total, 579.60);
  assert.equal(order.tax, 39.60);
  assert.deepStrictEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 600, discount: 60, tax: 39.60, cgst: 19.80, sgst: 19.80, total: 579.60,
    rows: [
      { name: 'Rice', sku: 'RICE', hsn: '1006', qty: 2, price: 200, gstPercent: 5, line: 400, lineTax: 18 },
      { name: 'Ghee', sku: 'GHEE', hsn: '0405', qty: 1, price: 200, gstPercent: 12, line: 200, lineTax: 21.60 }
    ]
  });

  const html = invoice.render(order);
  assert.match(html, /5%<\/td><td class="r">₹18\.00<\/td>/);
  assert.match(html, /12%<\/td><td class="r">₹21\.60<\/td>/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹39\.60/);
  assert.match(html, /Coupon Discount \(SAVE10\)<\/td><td[^>]*>-₹60\.00/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹579\.60/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice GST and discount match billing when the grand totals already agreed', () => {
  const { order, totals } = billedOrder([
    { id: 1, name: 'Tea', hsn: '0902', price: 600, qty: 1 }
  ], 'SAVE10');

  assert.deepStrictEqual(figures(totals), {
    subtotal: 600, discount: 60, tax: 97.20, cgst: 48.60, sgst: 48.60, total: 637.20
  });
  assert.deepStrictEqual(figures(invoice.computeInvoiceFigures(order)), {
    subtotal: 600, discount: 60, tax: 97.20, cgst: 48.60, sgst: 48.60, total: 637.20
  });
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
  assert.deepStrictEqual(reports.getGstReconciliation({ orders: [order] }), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1001, date: '22/11/2026', customer: 'Walk-in', coupon: 'SAVE10',
      ledgerSubtotal: 600, ledgerDiscount: 60, ledgerTax: 97.20, ledgerTotal: 637.20,
      invoiceDiscount: 60, invoiceTax: 97.20, invoiceTotal: 637.20,
      delta: 0, matched: true
    }]
  });
});

test('invoice applies a flat coupon before calculating GST', () => {
  const { order, totals } = billedOrder([
    { id: 1, name: 'Ghee', hsn: '0405', price: 400, qty: 1, gstRate: 12 }
  ], 'FLAT50');

  assert.deepStrictEqual(figures(totals), {
    subtotal: 400, discount: 50, tax: 42, cgst: 21, sgst: 21, total: 392
  });
  assert.deepStrictEqual(figures(invoice.computeInvoiceFigures(order)), {
    subtotal: 400, discount: 50, tax: 42, cgst: 21, sgst: 21, total: 392
  });
});

test('invoice honors the percentage coupon cap', () => {
  const { order, totals } = billedOrder([
    { id: 1, name: 'Tea', hsn: '0902', price: 2000, qty: 1 }
  ], 'SAVE10');

  assert.deepStrictEqual(figures(totals), {
    subtotal: 2000, discount: 150, tax: 333, cgst: 166.50, sgst: 166.50, total: 2183
  });
  assert.deepStrictEqual(figures(invoice.computeInvoiceFigures(order)), {
    subtotal: 2000, discount: 150, tax: 333, cgst: 166.50, sgst: 166.50, total: 2183
  });
});

test('invoice excludes stored coupons below minimum or marked inactive', () => {
  // These stored order fixtures exercise invoice lookup independently of checkout validation.
  const items = [{ name: 'Tea', price: 100, qty: 1, gstRate: 18 }];

  assert.deepStrictEqual(figures(invoice.computeInvoiceFigures({ items, coupon: 'FLAT50' })), {
    subtotal: 100, discount: 0, tax: 18, cgst: 9, sgst: 9, total: 118
  });
  assert.deepStrictEqual(figures(invoice.computeInvoiceFigures({ items, coupon: 'DIWALI20' })), {
    subtotal: 100, discount: 0, tax: 18, cgst: 9, sgst: 9, total: 118
  });
});

test('invoice normalizes stored coupon codes like checkout', () => {
  const items = [{ name: 'Tea', price: 600, qty: 1, gstRate: 18 }];

  assert.equal(pricing.computeTotals(items, ' save10 ').discount, 60);
  assert.deepStrictEqual(figures(invoice.computeInvoiceFigures({ items, coupon: ' save10 ' })), {
    subtotal: 600, discount: 60, tax: 97.20, cgst: 48.60, sgst: 48.60, total: 637.20
  });
});

test('invoice respects decimal and explicit zero GST rates', () => {
  const { order, totals } = billedOrder([
    { id: 1, name: 'Rice', price: 100, qty: 1, gstRate: 0.05 },
    { id: 2, name: 'Exempt item', price: 100, qty: 1, gstRate: 0 }
  ]);
  const calculated = invoice.computeInvoiceFigures(order);

  assert.deepStrictEqual(totals.lines.map(({ gstPercent, tax }) => ({ gstPercent, tax })), [
    { gstPercent: 5, tax: 5 },
    { gstPercent: 0, tax: 0 }
  ]);
  assert.deepStrictEqual(calculated.rows.map(({ gstPercent, lineTax }) => ({ gstPercent, lineTax })), [
    { gstPercent: 5, lineTax: 5 },
    { gstPercent: 0, lineTax: 0 }
  ]);
  assert.deepStrictEqual(figures(calculated), {
    subtotal: 200, discount: 0, tax: 5, cgst: 2.5, sgst: 2.5, total: 205
  });
});

test('invoice sums the rounded line GST amounts', () => {
  const { order, totals } = billedOrder([
    { id: 1, name: 'Tea sample', price: 0.03, qty: 1, gstRate: 18 },
    { id: 2, name: 'Coffee sample', price: 0.03, qty: 1, gstRate: 18 }
  ]);
  const calculated = invoice.computeInvoiceFigures(order);

  assert.deepStrictEqual(figures(totals), {
    subtotal: 0.06, discount: 0, tax: 0.02, cgst: 0.01, sgst: 0.01, total: 0.08
  });
  assert.deepStrictEqual(calculated.rows.map(({ lineTax }) => lineTax), [0.01, 0.01]);
  assert.deepStrictEqual(figures(calculated), {
    subtotal: 0.06, discount: 0, tax: 0.02, cgst: 0.01, sgst: 0.01, total: 0.08
  });
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice and reconciliation still flag a different recorded total', () => {
  const { order } = billedOrder([
    { id: 1, name: 'Rice', hsn: '1006', price: 100, qty: 1, gstRate: 5 }
  ]);
  order.total = 104;

  assert.match(invoice.render(order), /Accountant Reconciliation Notice:.*₹105\.00.*₹104\.00.*by \+₹1\.00/);
  const report = reports.getGstReconciliation({ orders: [order] });
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.rows[0].delta, 1);
});
