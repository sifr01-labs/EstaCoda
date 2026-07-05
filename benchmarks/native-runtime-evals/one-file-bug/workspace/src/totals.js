function subtotalWithTax(items, taxRate) {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  return subtotal + taxRate;
}

module.exports = {
  subtotalWithTax
};
