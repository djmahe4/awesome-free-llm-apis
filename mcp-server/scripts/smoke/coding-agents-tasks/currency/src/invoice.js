const { formatPrice } = require('./money');

function invoiceLine(item) {
  return `${item.name}\t${formatPrice(item.cents)}`;
}

module.exports = { invoiceLine };
