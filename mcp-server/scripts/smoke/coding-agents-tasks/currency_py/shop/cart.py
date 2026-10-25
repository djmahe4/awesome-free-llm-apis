from shop.money import format_price


class Cart:
    def __init__(self):
        self.items = []

    def add(self, name, cents, qty=1):
        self.items.append({"name": name, "cents": cents, "qty": qty})

    def total(self):
        return sum(i["cents"] * i["qty"] for i in self.items)

    def summary(self):
        lines = [f"{i['name']} x{i['qty']}: {format_price(i['cents'] * i['qty'])}" for i in self.items]
        lines.append(f"Total: {format_price(self.total())}")
        return "\n".join(lines)
