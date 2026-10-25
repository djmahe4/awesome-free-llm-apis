import { describe, it, expect } from 'vitest';
import { arityErrorHint, buildRepairBrief } from '../src/tools/coding-agents/verify-guard.js';

// Traced: the 7B stayed stuck for six attempts on
//   TypeError: invoice_line() takes 1 positional argument but 2 were given
// without ever adding the parameter to the function's definition. The error already says so; the brief
// now spells out the action.

describe('arityErrorHint', () => {
    it('Python: too many positional arguments names the function and the fix', () => {
        const h = arityErrorHint("TypeError: invoice_line() takes 1 positional argument but 2 were given");
        expect(h).toMatch(/invoice_line is called with 2 arguments but its definition accepts 1/);
        expect(h).toMatch(/add the missing parameter to the definition of invoice_line/i);
    });

    it('Python: a method counts self, so the message says what the caller passes', () => {
        const h = arityErrorHint("TypeError: Cart.__init__() takes 1 positional argument but 2 were given");
        expect(h).toMatch(/Cart\.__init__ is called with 2 arguments but its definition accepts 1/);
    });

    it('Python: unexpected keyword argument', () => {
        const h = arityErrorHint("TypeError: format_price() got an unexpected keyword argument 'currency'");
        expect(h).toMatch(/format_price is called with the keyword argument currency/);
        expect(h).toMatch(/add a parameter named currency/i);
    });

    it('Python: a range of accepted counts', () => {
        expect(arityErrorHint('TypeError: f() takes from 1 to 2 positional arguments but 3 were given')).toMatch(/f is called with 3 arguments but its definition accepts 1 to 2/);
    });

    it('ignores output that is not an argument-count error', () => {
        expect(arityErrorHint('AssertionError: expected 3 to be 2')).toBeNull();
        expect(arityErrorHint('')).toBeNull();
    });
});

describe('repair brief', () => {
    it('includes the arity hint when the output has the error', () => {
        const brief = buildRepairBrief({
            command: 'pytest -q', exitCode: 1, patchedFiles: ['shop/invoice.py'], failedCases: ['tests/test_currency.py::test_invoice_line_takes_a_currency'],
            outputTail: "E   TypeError: invoice_line() takes 1 positional argument but 2 were given",
        } as any);
        expect(brief).toMatch(/invoice_line is called with 2 arguments but its definition accepts 1/);
    });
});
