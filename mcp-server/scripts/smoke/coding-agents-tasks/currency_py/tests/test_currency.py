import pytest

from shop.cart import Cart
from shop.invoice import invoice_line
from shop.money import format_price


def test_usd_is_still_the_default():
    assert format_price(150) == "$1.50"
    assert format_price(150, "USD") == "$1.50"


def test_eur_uses_a_comma_and_a_trailing_euro_sign():
    assert format_price(150, "EUR") == "1,50 €"


def test_gbp_uses_the_pound_sign():
    assert format_price(99, "GBP") == "£0.99"


def test_unknown_currency_raises_value_error():
    with pytest.raises(ValueError):
        format_price(1, "XYZ")


def test_cart_defaults_to_usd():
    c = Cart()
    c.add("pen", 150, 2)
    assert c.summary() == "pen x2: $3.00\nTotal: $3.00"


def test_cart_uses_its_currency_everywhere():
    c = Cart("EUR")
    c.add("pen", 150, 2)
    c.add("ink", 50)
    assert c.summary() == "pen x2: 3,00 €\nink x1: 0,50 €\nTotal: 3,50 €"


def test_invoice_line_defaults_to_usd():
    assert invoice_line({"name": "pen", "cents": 150}) == "pen\t$1.50"


def test_invoice_line_takes_a_currency():
    assert invoice_line({"name": "pen", "cents": 150}, "GBP") == "pen\t£1.50"
