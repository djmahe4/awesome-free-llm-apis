import { describe, it, expect } from 'vitest';
import { apiSurface } from '../src/tools/coding-agents/cross-file.js';
import { unassignedMembers } from '../src/tools/coding-agents/verify-guard.js';
import { filesImplicated } from '../src/tools/coding-agents/repair-loop.js';

// The cross-file context, the unassigned-member hint and frame-based repair localization were written
// against JS/TS syntax only. Python, Go and Rust (the other languages the verify runner allows) need the same.

describe('apiSurface beyond JS/TS', () => {
    it('Python: def, async def, class, decorators-free bodies dropped', () => {
        const py = [
            'from money import format_price',
            '',
            'class Cart:',
            "    def __init__(self, currency='USD'):",
            '        self.items = []',
            '',
            '    async def load(self, url: str) -> None:',
            '        pass',
            '',
            'def invoice_line(item, currency="USD"):',
            '    return f"{item.name}"',
        ].join('\n');
        const s = apiSurface(py, 'src/cart.py');
        expect(s).toContain('class Cart:');
        expect(s).toContain("def __init__(self, currency='USD'):");
        expect(s).toContain('async def load(self, url: str) -> None:');
        expect(s).toContain('def invoice_line(item, currency="USD"):');
        expect(s).toContain('from money import format_price');
        expect(s).not.toContain('self.items = []');
    });

    it('Go: func, method receivers and type declarations', () => {
        const go = 'package shop\n\ntype Cart struct {\n\tItems []Item\n}\n\nfunc (c *Cart) Summary() string {\n\treturn ""\n}\n\nfunc FormatPrice(cents int, currency string) string {\n\treturn ""\n}\n';
        const s = apiSurface(go, 'cart.go');
        expect(s).toContain('type Cart struct {');
        expect(s).toContain('func (c *Cart) Summary() string {');
        expect(s).toContain('func FormatPrice(cents int, currency string) string {');
        expect(s).not.toContain('return ""');
    });

    it('Rust: pub fn, struct, impl', () => {
        const rs = 'pub struct Cart {\n    items: Vec<Item>,\n}\n\nimpl Cart {\n    pub fn new(currency: &str) -> Self {\n        Cart { items: vec![] }\n    }\n}\n\nfn helper() {}\n';
        const s = apiSurface(rs, 'src/cart.rs');
        expect(s).toContain('pub struct Cart {');
        expect(s).toContain('impl Cart {');
        expect(s).toContain('pub fn new(currency: &str) -> Self {');
        expect(s).toContain('fn helper() {}');
        expect(s).not.toContain('Cart { items: vec![] }');
    });
});

describe('unassignedMembers for Python self', () => {
    const PY = [
        'class Cart:',
        '    def __init__(self):',
        '        self.items = []',
        '',
        '    def summary(self):',
        '        return [format_price(i, self.currency) for i in self.items]',
    ].join('\n');

    it('reports self.member read but never assigned', () => {
        expect(unassignedMembers(PY, 'src/cart.py')).toEqual(['currency']);
    });

    it('is quiet once it is assigned, and ignores methods called through self', () => {
        expect(unassignedMembers(PY.replace('        self.items = []', '        self.items = []\n        self.currency = currency'), 'src/cart.py')).toEqual([]);
        expect(unassignedMembers('class A:\n    def total(self):\n        return 1\n    def s(self):\n        return self.total()\n', 'a.py')).toEqual([]);
    });
});

describe('filesImplicated with non-JS stack frames', () => {
    const T = ['src/money.py', 'src/cart.py', 'src/invoice.py'];
    it('Python traceback: File "...", line N', () => {
        const brief = 'Traceback (most recent call last):\n  File "C:\\tmp\\ws\\src\\invoice.py", line 4, in invoice_line\n    return f"{x}"';
        expect(filesImplicated(T, ['tests/test_currency.py::test_x'], brief)).toEqual(['src/invoice.py']);
    });
    it('Go and Rust frames: path:line', () => {
        expect(filesImplicated(['money.go', 'cart.go'], ['TestX'], '\t/home/u/ws/cart.go:17 +0x1d')).toEqual(['cart.go']);
        expect(filesImplicated(['src/money.rs', 'src/cart.rs'], ['tests::x'], "thread 'x' panicked at src/cart.rs:12:5:")).toEqual(['src/cart.rs']);
    });
});
