import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseSql } from '../src/sql-parser.js';
import { parseAmpscript } from '../src/parse-ampscript.js';
import { REVERSE_MESSAGE_CODES } from '../src/messages.js';

/**
 * Returns a copy of an AST without `loc` properties.
 *
 * @param {unknown} node AST node
 * @returns {unknown} copy without locations
 */
function stripLoc(node) {
    if (Array.isArray(node)) {
        return node.map((item) => stripLoc(item));
    }
    if (node && typeof node === 'object') {
        return Object.fromEntries(
            Object.entries(node)
                .filter(([key]) => key !== 'loc')
                .map(([key, value]) => [key, stripLoc(value)]),
        );
    }
    return node;
}

/**
 * Parses AMPscript that must succeed without errors and returns the result.
 *
 * @param {string} code AMPscript code
 * @returns {object} parse result
 */
function ok(code) {
    const result = parseAmpscript(code);
    assert.deepEqual(
        result.messages.filter((message) => message.severity === 'error'),
        [],
        `unexpected errors for: ${code}`,
    );
    assert.ok(result.ast);
    return result;
}

/**
 * Asserts that AMPscript code gives the same AST (ignoring loc) as a SQL query.
 *
 * @param {string} code AMPscript code
 * @param {string} sql equivalent SQL
 * @returns {object} parse result
 */
function sameAs(code, sql) {
    const expected = parseSql(sql);
    assert.ok(expected.ast, `SQL must parse: ${sql}`);
    const result = ok(code);
    assert.deepEqual(stripLoc(result.ast), stripLoc(expected.ast));
    return result;
}

/**
 * Parses AMPscript that must fail with one error and returns that error.
 *
 * @param {string} code AMPscript code
 * @param {string} expectedCode expected message code
 * @returns {object} the error message
 */
function error(code, expectedCode) {
    const result = parseAmpscript(code);
    assert.equal(result.ast, null);
    const errors = result.messages.filter((message) => message.severity === 'error');
    assert.equal(errors.length, 1, JSON.stringify(result.messages));
    assert.equal(errors[0].code, expectedCode);
    return errors[0];
}

describe('parseAmpscript — LookupRows', () => {
    it('single pair inside a block', () => {
        const result = sameAs(
            '%%[ SET @rows = LookupRows("Customers", "City", "Berlin") ]%%',
            "SELECT * FROM Customers WHERE City = 'Berlin'",
        );
        assert.deepEqual(result.meta, { target: 'ampscript-lookuprows', deName: 'Customers' });
    });

    it('several pairs become a left-nested AND chain', () => {
        sameAs(
            'SET @rows = LookupRows("Customers", "City", "Berlin", "Age", 30, "Code", "007")',
            "SELECT * FROM Customers WHERE City = 'Berlin' AND Age = 30 AND Code = '007'",
        );
    });

    it('numeric strings become numbers, others stay text', () => {
        sameAs(
            'LookupRows("D", "A", "42", "B", "4.5", "C", "-1", "E", "01", "F", "1e3")',
            "SELECT * FROM D WHERE A = 42 AND B = 4.5 AND C = -1 AND E = '01' AND F = '1e3'",
        );
    });

    it('single-quoted strings and doubled quotes', () => {
        sameAs(`LookupRows('D', 'A', 'say "hi"')`, `SELECT * FROM D WHERE A = 'say "hi"'`);
        sameAs(`LookupRows("D", "A", "say ""hi""")`, `SELECT * FROM D WHERE A = 'say "hi"'`);
        sameAs(`LookupRows('D', 'A', 'it''s')`, "SELECT * FROM D WHERE A = 'it''s'");
        sameAs(`LookupRows("D", "A", "it's")`, "SELECT * FROM D WHERE A = 'it''s'");
    });

    it('function names in any case', () => {
        sameAs('set @r = lookuprows("D", "A", "x")', "SELECT * FROM D WHERE A = 'x'");
    });

    it('header comment supplies the column list', () => {
        const code = `%%[
/* SQL: SELECT FirstName, [Last Name] */
VAR @rows, @row, @i
SET @rows = LookupRows("Customers", "City", "Berlin")
FOR @i = 1 TO RowCount(@rows) DO
  SET @row = Row(@rows, @i)
  OutputLine(Concat(Field(@row, "FirstName")))
NEXT @i
]%%`;
        sameAs(code, "SELECT FirstName, [Last Name] FROM Customers WHERE City = 'Berlin'");
    });

    it('header with FROM and external key fills meta.deKey', () => {
        const result = ok(
            '%%[ /* SQL: FROM [Customers] (external key CUST) */ SET @r = LookupRows("Customers", "A", "1") ]%%',
        );
        assert.deepEqual(result.meta, {
            target: 'ampscript-lookuprows',
            deName: 'Customers',
            deKey: 'CUST',
        });
    });

    it('ignores HTML and output blocks around the code', () => {
        sameAs(
            `<p>Don't panic</p>%%[ SET @r = LookupRows("D", "A", "x") ]%%<b>%%=Field(Row(@r, 1), "A")=%%</b>`,
            "SELECT * FROM D WHERE A = 'x'",
        );
    });

    it('locations point at the source', () => {
        const code = '%%[\nSET @r = LookupRows("Customers", "City", "Berlin")\n]%%';
        const { ast } = ok(code);
        assert.equal(code.slice(ast.from.loc.start, ast.from.loc.end), '"Customers"');
        assert.equal(code.slice(ast.where.loc.start, ast.where.loc.end), '"City", "Berlin"');
        assert.equal(ast.where.value.loc.line, 2);
        assert.equal(ast.loc.line, 2);
        assert.equal(ast.loc.column, 10);
    });

    it('case-sensitive variant: warning, same AST', () => {
        const result = sameAs('LookupRowsCS("D", "A", "x")', "SELECT * FROM D WHERE A = 'x'");
        assert.equal(result.messages[0].code, REVERSE_MESSAGE_CODES.CASE_SENSITIVE_LOOKUP);
        assert.equal(result.messages[0].severity, 'warning');
    });
});

describe('parseAmpscript — LookupOrderedRows', () => {
    it('count and sort', () => {
        const result = sameAs(
            'SET @r = LookupOrderedRows("Customers", 5, "LastName DESC, FirstName", "City", "Berlin")',
            "SELECT TOP 5 * FROM Customers WHERE City = 'Berlin' ORDER BY LastName DESC, FirstName ASC",
        );
        assert.equal(result.meta.target, 'ampscript-lookuporderedrows');
    });

    it('count 0 and -1 mean all rows', () => {
        sameAs(
            'LookupOrderedRows("D", 0, "A", "B", "x")',
            "SELECT * FROM D WHERE B = 'x' ORDER BY A",
        );
        sameAs(
            'LookupOrderedRows("D", -1, "A asc", "B", "x")',
            "SELECT * FROM D WHERE B = 'x' ORDER BY A",
        );
    });

    it('count given as text', () => {
        sameAs(
            'LookupOrderedRows("D", "3", "A", "B", "x")',
            "SELECT TOP 3 * FROM D WHERE B = 'x' ORDER BY A",
        );
    });

    it('with header columns and several pairs', () => {
        sameAs(
            '/* SQL: SELECT A, B */ LookupOrderedRows("D", 10, "[My Col] DESC", "B", "x", "C", 2)',
            "SELECT TOP 10 A, B FROM D WHERE B = 'x' AND C = 2 ORDER BY [My Col] DESC",
        );
    });

    it('CS variant', () => {
        const result = sameAs(
            'LookupOrderedRowsCS("D", 1, "A", "B", "x")',
            "SELECT TOP 1 * FROM D WHERE B = 'x' ORDER BY A",
        );
        assert.equal(result.meta.target, 'ampscript-lookuporderedrows');
    });
});

describe('parseAmpscript — Lookup', () => {
    it('return column becomes the SELECT list, with first-row info', () => {
        const result = sameAs(
            '%%[ SET @name = Lookup("Customers", "FirstName", "Email", "a@b.c", "Active", "true") ]%%',
            "SELECT FirstName FROM Customers WHERE Email = 'a@b.c' AND Active = 'true'",
        );
        assert.equal(result.meta.target, 'ampscript-lookup');
        assert.equal(result.messages[0].code, REVERSE_MESSAGE_CODES.LOOKUP_FIRST_ROW_ONLY);
        assert.equal(result.messages[0].severity, 'info');
    });

    it('inline output block', () => {
        sameAs('Hello %%=Lookup("D", "Name", "Id", 7)=%%!', 'SELECT Name FROM D WHERE Id = 7');
    });
});

describe('parseAmpscript — errors', () => {
    it('variable value: error at its exact position', () => {
        const code = '%%[\n  SET @rows = LookupRows("Customers",\n    "City", @city)\n]%%';
        const message = error(code, REVERSE_MESSAGE_CODES.VARIABLE_VALUE);
        assert.equal(message.line, 3);
        assert.equal(message.column, 13);
        assert.equal(message.endColumn, 18);
        assert.match(message.message, /replace it with the value/i);
    });

    it('variable as data extension name', () => {
        error('LookupRows(@de, "A", "x")', REVERSE_MESSAGE_CODES.VARIABLE_VALUE);
    });

    it('nested function call', () => {
        const code = 'LookupRows("D", "A", RequestParameter("a"))';
        const message = error(code, REVERSE_MESSAGE_CODES.UNSUPPORTED_EXPRESSION);
        assert.equal(
            code.slice(message.column - 1, message.endColumn - 1),
            'RequestParameter("a")',
        );
    });

    it('argument counts', () => {
        error('LookupRows("D", "A")', REVERSE_MESSAGE_CODES.ARGUMENT_COUNT);
        error('LookupRows("D", "A", "x", "B")', REVERSE_MESSAGE_CODES.ARGUMENT_COUNT);
        error('LookupOrderedRows("D", 1, "A")', REVERSE_MESSAGE_CODES.ARGUMENT_COUNT);
        error('Lookup("D", "A", "B")', REVERSE_MESSAGE_CODES.ARGUMENT_COUNT);
    });

    it('invalid arguments', () => {
        error('LookupRows(5, "A", "x")', REVERSE_MESSAGE_CODES.INVALID_ARGUMENT);
        error('LookupRows("D", 1, "x")', REVERSE_MESSAGE_CODES.INVALID_ARGUMENT);
        error('LookupOrderedRows("D", 1.5, "A", "B", "x")', REVERSE_MESSAGE_CODES.INVALID_COUNT);
        error(
            'LookupOrderedRows("D", 1, "A B C", "B", "x")',
            REVERSE_MESSAGE_CODES.INVALID_ORDER_BY,
        );
        error('LookupOrderedRows("D", 1, "", "B", "x")', REVERSE_MESSAGE_CODES.INVALID_ARGUMENT);
    });

    it('nothing to convert / empty', () => {
        error('%%[ SET @a = 1 ]%%', REVERSE_MESSAGE_CODES.NO_LOOKUP_FOUND);
        error('%%[ ]%%', 'EMPTY_INPUT');
        error('', 'EMPTY_INPUT');
    });

    it('unterminated string, comment and call', () => {
        error('%%[ LookupRows("D, "A", "x") ]%%', 'UNTERMINATED_STRING');
        error('%%[ /* never closed LookupRows("D", "A", "x") ]%%', 'UNTERMINATED_COMMENT');
        error('LookupRows("D", "A", "x"', 'MISSING_CLOSING_PAREN');
    });

    it('several lookups: first converted, warning', () => {
        const result = ok(
            'SET @a = LookupRows("D", "A", "1")\nSET @b = Lookup("E", "B", "C", "2")',
        );
        assert.equal(result.ast.from.name, 'D');
        assert.equal(result.messages[0].code, REVERSE_MESSAGE_CODES.MULTIPLE_LOOKUPS);
    });
});

describe('parseAmpscript — garbage input never throws', () => {
    const inputs = [
        undefined,
        null,
        {},
        '%%[',
        ']%%',
        '%%=',
        'LookupRows(',
        'LookupRows((((',
        'Lookup("D", "A", "B", @x',
        '\u{0}💥"',
        `LookupRows("D", ${'"A", "x", '.repeat(3000)}"A", "x")`,
        '<html><body>no code here</body></html>',
    ];
    for (const input of inputs) {
        it(`does not throw for ${JSON.stringify(String(input)).slice(0, 40)}`, () => {
            const result = parseAmpscript(input);
            assert.ok(Array.isArray(result.messages));
            assert.equal(typeof result.meta, 'object');
            if (result.ast === null) {
                assert.ok(result.messages.some((message) => message.severity === 'error'));
            }
        });
    }
});
