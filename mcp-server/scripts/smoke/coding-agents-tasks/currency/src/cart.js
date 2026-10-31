const { formatPrice } = require('./money');

class Cart {
  constructor() {
    this.items = [];
  }

  add(name, cents, qty = 1) {
    this.items.push({ name, cents, qty });
  }

  total() {
    return this.items.reduce((sum, i) => sum + i.cents * i.qty, 0);
  }

  summary() {
    const lines = this.items.map(i => `${i.name} x${i.qty}: ${formatPrice(i.cents * i.qty)}`);
    lines.push(`Total: ${formatPrice(this.total())}`);
    return lines.join('\n');
  }
}

module.exports = { Cart };
