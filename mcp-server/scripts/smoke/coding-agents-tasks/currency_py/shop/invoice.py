from shop.money import format_price


def invoice_line(item):
    return f"{item['name']}\t{format_price(item['cents'])}"
