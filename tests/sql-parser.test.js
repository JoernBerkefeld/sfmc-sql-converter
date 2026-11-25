import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as api from '../src/index.js';
import { MESSAGE_CODES, createMessage, parseSql } from '../src/index.js';

/**
 * Converts a 1-based line / column pair to a 0-based offset.
 *
 * @param {string} text source text
 * @param {number} line 1-based line
 * @param {number} column 1-based column
 * @returns {number} offset
 */
function offsetOf(text, line, column) {
    let offset = 0;
    for (let current = 1; current < line; current++) {
        offset = text.indexOf('\n', offset) + 1;
    }
    return offset + column - 1;
}

/**
 * Returns the source text a message points at.
 *
 * @param {string} text source text
 * @param {object} message message with line/column/endLine/endColumn
 * @returns {string} marked text
 */
function marked(text, message) {
    return text.slice(
        offsetOf(text, message.line, message.column),
        offsetOf(text, message.endLine, message.endColumn),
    );
}

/**
 * Parses a query that must succeed without errors.
 *
 * @param {string} text query
 * @returns {object} ast
 */
function ok(text) {
    const result = parseSql(text);
    const errors = result.messages.filter((message) => message.severity === 'error');
    assert.deepEqual(errors, [], `unexpected errors for: ${text}`);
    assert.ok(result.ast);
    return result.ast;
}

/**
 * Parses a query that must fail with the given code and checks the marked text.
 *
 * @param {string} text query
 * @param {string} code expected message code
 * @param {string} [markedText] expected text covered by the message location
 * @returns {object} the error message
 */
function fails(text, code, markedText) {
    const result = parseSql(text);
    assert.equal(result.ast, null, `expected no AST for: ${text}`);
    const message = result.messages.find((entry) => entry.severity === 'error');
    assert.ok(message, `expected an error for: ${text}`);
    assert.equal(message.code, code, `wrong code for: ${text} (${message.message})`);
    assert.ok(message.message.length > 20, 'message must explain the problem');
    if (markedText !== undefined) {
        assert.equal(marked(text, message), markedText);
    }
    return message;
}

/**
 * Parses a query and returns its WHERE expression.
 *
 * @param {string} condition WHERE condition text
 * @returns {object} where expression
 */
function where(condition) {
    return ok(`SELECT * FROM DE WHERE ${condition}`).where;
}

/**
 * Removes loc properties recursively for easier structural comparison.
 *
 * @param {unknown} node AST node
 * @returns {unknown} node without loc
 */
function strip(node) {
    if (Array.isArray(node)) {
        return node.map((entry) => strip(entry));
    }
    if (node && typeof node === 'object') {
        return Object.fromEntries(
            Object.entries(node)
                .filter(([key]) => key !== 'loc')
                .map(([key, value]) => [key, strip(value)]),
        );
    }
    return node;
}

describe('exports', () => {
    it('exposes parseSql, createMessage and every code constant as named exports', () => {
        assert.equal(typeof api.parseSql, 'function');
        assert.equal(typeof api.createMessage, 'function');
        for (const [key, value] of Object.entries(MESSAGE_CODES)) {
            assert.equal(key, value);
            assert.equal(api[key], value);
        }
        assert.equal(api.default, undefined);
    });

    it('createMessage copies the location', () => {
        const message = createMessage('warning', 'X', 'text', {
            line: 1,
            column: 2,
            endLine: 3,
            endColumn: 4,
            start: 0,
        });
        assert.deepEqual(message, {
            severity: 'warning',
            code: 'X',
            message: 'text',
            line: 1,
            column: 2,
            endLine: 3,
            endColumn: 4,
        });
    });
});

describe('supported SELECT constructs', () => {
    it('parses SELECT * FROM', () => {
        const ast = ok('SELECT * FROM Subscribers');
        assert.equal(ast.type, 'select');
        assert.equal(ast.columns, '*');
        assert.equal(ast.top, null);
        assert.equal(ast.where, null);
        assert.deepEqual(ast.orderBy, []);
        assert.equal(ast.from.name, 'Subscribers');
        assert.deepEqual(ast.loc, {
            start: 0,
            end: 25,
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 26,
        });
    });

    it('parses a column list with locations', () => {
        const text = 'SELECT Email, FirstName FROM DE';
        const ast = ok(text);
        assert.deepEqual(
            ast.columns.map((column) => column.name),
            ['Email', 'FirstName'],
        );
        assert.equal(marked(text, ast.columns[1].loc), 'FirstName');
        assert.equal(ast.columns[1].loc.start, 14);
        assert.equal(ast.columns[1].loc.end, 23);
    });

    it('treats keywords case-insensitively', () => {
        const ast = ok('select top 3 a from b where c = 1 and d is not null order by a desc');
        assert.equal(ast.top, 3);
        assert.equal(ast.where.type, 'and');
        assert.equal(ast.orderBy[0].direction, 'DESC');
    });

    it('strips brackets and allows spaces inside them', () => {
        const ast = ok(
            'SELECT [First Name], [Order] FROM [My Data Extension] WHERE [Zip Code] = 1',
        );
        assert.deepEqual(
            ast.columns.map((column) => column.name),
            ['First Name', 'Order'],
        );
        assert.equal(ast.from.name, 'My Data Extension');
        assert.equal(ast.where.column, 'Zip Code');
    });

    it('unescapes ]] inside brackets', () => {
        assert.equal(ok('SELECT [a]]b] FROM DE').columns[0].name, 'a]b');
    });

    it('marks the bracketed name including the brackets', () => {
        const text = 'SELECT * FROM [My DE]';
        assert.equal(marked(text, ok(text).from.loc), '[My DE]');
    });

    it('parses TOP n', () => {
        assert.equal(ok('SELECT TOP 10 * FROM DE').top, 10);
    });

    it('parses TOP (n)', () => {
        assert.equal(ok('SELECT TOP (25) Email FROM DE').top, 25);
    });

    it('accepts a trailing semicolon', () => {
        const text = 'SELECT * FROM DE;';
        const ast = ok(text);
        assert.equal(ast.loc.end, 16);
    });

    it('ignores line and block comments', () => {
        const ast = ok(
            '-- leading\nSELECT /* cols */ Email -- trailing\nFROM /* multi\nline */ DE\n-- end',
        );
        assert.equal(ast.columns[0].name, 'Email');
        assert.equal(ast.from.name, 'DE');
    });

    it('reports multi-line locations', () => {
        const text = 'SELECT Email\nFROM DE\nWHERE\n  Age > 5';
        const ast = ok(text);
        assert.equal(ast.where.loc.line, 4);
        assert.equal(ast.where.loc.column, 3);
        assert.equal(ast.where.loc.endLine, 4);
        assert.equal(ast.where.loc.endColumn, 10);
        assert.equal(marked(text, ast.where.loc), 'Age > 5');
    });

    it('handles CRLF line endings', () => {
        const text = 'SELECT Email\r\nFROM DE\r\nWHERE Age > 5';
        const ast = ok(text);
        assert.equal(ast.where.loc.line, 3);
        assert.equal(ast.where.loc.column, 7);
    });

    it('parses a single ORDER BY column with default ASC', () => {
        const text = 'SELECT * FROM DE ORDER BY LastName';
        const ast = ok(text);
        assert.deepEqual(strip(ast.orderBy), [{ column: 'LastName', direction: 'ASC' }]);
        assert.equal(marked(text, ast.orderBy[0].loc), 'LastName');
    });

    it('parses multi-column ORDER BY with directions', () => {
        const text = 'SELECT * FROM DE ORDER BY [Last Name] DESC, FirstName asc, Age';
        const ast = ok(text);
        assert.deepEqual(strip(ast.orderBy), [
            { column: 'Last Name', direction: 'DESC' },
            { column: 'FirstName', direction: 'ASC' },
            { column: 'Age', direction: 'ASC' },
        ]);
        assert.equal(marked(text, ast.orderBy[0].loc), '[Last Name] DESC');
    });

    it('parses WHERE and ORDER BY together', () => {
        const ast = ok('SELECT TOP 5 Email FROM DE WHERE Active = 1 ORDER BY Email');
        assert.equal(ast.where.type, 'compare');
        assert.equal(ast.orderBy.length, 1);
    });

    it('accepts WITH (NOLOCK) and reports it as info', () => {
        const text = 'SELECT * FROM DE WITH (NOLOCK) WHERE a = 1';
        const result = parseSql(text);
        assert.ok(result.ast);
        assert.equal(result.ast.from.name, 'DE');
        assert.equal(result.messages.length, 1);
        assert.equal(result.messages[0].code, 'TABLE_HINT_IGNORED');
        assert.equal(result.messages[0].severity, 'info');
        assert.equal(marked(text, result.messages[0]), 'WITH (NOLOCK)');
    });

    it('accepts unicode names', () => {
        assert.equal(ok('SELECT Straße FROM Kündigungen').from.name, 'Kündigungen');
    });
});

describe('WHERE conditions', () => {
    for (const op of ['=', '<>', '>', '>=', '<', '<=']) {
        it(`parses the ${op} operator`, () => {
            assert.deepEqual(strip(where(`Age ${op} 18`)), {
                type: 'compare',
                op,
                column: 'Age',
                value: { kind: 'number', value: '18' },
            });
        });
    }

    it('normalizes != to <>', () => {
        assert.equal(where("Status != 'x'").op, '<>');
    });

    it('parses string values with locations', () => {
        const text = "SELECT * FROM DE WHERE Status = 'Active'";
        const expression = ok(text).where;
        assert.deepEqual(expression.value.kind, 'string');
        assert.equal(expression.value.value, 'Active');
        assert.equal(marked(text, expression.value.loc), "'Active'");
        assert.equal(marked(text, expression.loc), "Status = 'Active'");
    });

    it("unescapes '' inside strings", () => {
        assert.equal(where("Name = 'O''Brien'").value.value, "O'Brien");
        assert.equal(where("Name = ''''").value.value, "'");
        assert.equal(where("Name = ''").value.value, '');
    });

    it("accepts N'unicode' strings", () => {
        assert.equal(where("Name = N'Jörn'").value.value, 'Jörn');
    });

    it('parses negative and decimal numbers as written', () => {
        assert.equal(where('Balance > -5').value.value, '-5');
        assert.equal(where('Balance > 12.50').value.value, '12.50');
        assert.equal(where('Balance > -0.75').value.value, '-0.75');
        const text = 'SELECT * FROM DE WHERE Balance > -5';
        assert.equal(marked(text, ok(text).where.value.loc), '-5');
    });

    it('parses LIKE', () => {
        assert.deepEqual(strip(where("Email LIKE '%@example.com'")), {
            type: 'like',
            column: 'Email',
            pattern: { kind: 'string', value: '%@example.com' },
        });
    });

    it('parses IN and NOT IN', () => {
        assert.deepEqual(strip(where("Country IN ('DE', 'AT', 1)")), {
            type: 'in',
            negated: false,
            column: 'Country',
            values: [
                { kind: 'string', value: 'DE' },
                { kind: 'string', value: 'AT' },
                { kind: 'number', value: '1' },
            ],
        });
        const text = "SELECT * FROM DE WHERE Country NOT IN ('CH')";
        const expression = ok(text).where;
        assert.equal(expression.negated, true);
        assert.equal(marked(text, expression.loc), "Country NOT IN ('CH')");
    });

    it('parses BETWEEN', () => {
        assert.deepEqual(strip(where("Joined BETWEEN '2026-01-01' AND '2026-12-31'")), {
            type: 'between',
            column: 'Joined',
            low: { kind: 'string', value: '2026-01-01' },
            high: { kind: 'string', value: '2026-12-31' },
        });
    });

    it('parses IS NULL and IS NOT NULL', () => {
        assert.deepEqual(strip(where('Phone IS NULL')), {
            type: 'null',
            negated: false,
            column: 'Phone',
        });
        assert.equal(where('Phone is not null').negated, true);
    });

    it('gives AND higher precedence than OR', () => {
        assert.deepEqual(strip(where('a = 1 OR b = 2 AND c = 3')), {
            type: 'or',
            left: { type: 'compare', op: '=', column: 'a', value: { kind: 'number', value: '1' } },
            right: {
                type: 'and',
                left: {
                    type: 'compare',
                    op: '=',
                    column: 'b',
                    value: { kind: 'number', value: '2' },
                },
                right: {
                    type: 'compare',
                    op: '=',
                    column: 'c',
                    value: { kind: 'number', value: '3' },
                },
            },
        });
    });

    it('chains AND and OR left-associatively', () => {
        const expression = where('a = 1 AND b = 2 AND c = 3');
        assert.equal(expression.type, 'and');
        assert.equal(expression.left.type, 'and');
        assert.equal(expression.right.column, 'c');
        const mixed = where('a = 1 AND b = 2 OR c = 3 AND d = 4');
        assert.equal(mixed.type, 'or');
        assert.equal(mixed.left.type, 'and');
        assert.equal(mixed.right.type, 'and');
    });

    it('respects parentheses over precedence', () => {
        const expression = where('(a = 1 OR b = 2) AND c = 3');
        assert.equal(expression.type, 'and');
        assert.equal(expression.left.type, 'or');
    });

    it('parses nesting depth 4+', () => {
        const expression = where("((((a = 1 OR b = 2) AND c = 3) OR d LIKE 'x%') AND (e IS NULL))");
        assert.equal(expression.type, 'and');
        assert.equal(expression.left.type, 'or');
        assert.equal(expression.left.left.type, 'and');
        assert.equal(expression.left.left.left.type, 'or');
        assert.equal(expression.left.left.left.left.column, 'a');
        assert.equal(expression.right.type, 'null');
    });

    it('parses deep redundant parentheses', () => {
        const depth = 50;
        const expression = where(`${'('.repeat(depth)}a = 1${')'.repeat(depth)}`);
        assert.equal(expression.type, 'compare');
    });

    it('sets and/or locations from left to right operand', () => {
        const text = 'SELECT * FROM DE WHERE a = 1 AND b = 2';
        assert.equal(marked(text, ok(text).where.loc), 'a = 1 AND b = 2');
    });

    it('accepts bracketed column names in conditions', () => {
        assert.equal(where("[E Mail] LIKE 'a%'").column, 'E Mail');
    });
});

describe('unsupported constructs', () => {
    it('rejects JOIN', () => {
        fails('SELECT * FROM A INNER JOIN B ON A.x = B.x', 'UNSUPPORTED_JOIN', 'INNER JOIN');
        fails(
            'SELECT * FROM A LEFT OUTER JOIN B ON A.x = B.x',
            'UNSUPPORTED_JOIN',
            'LEFT OUTER JOIN',
        );
        fails('SELECT * FROM A JOIN B ON A.x = B.x', 'UNSUPPORTED_JOIN', 'JOIN');
        fails('SELECT * FROM A CROSS APPLY B', 'UNSUPPORTED_JOIN', 'CROSS APPLY');
    });

    it('rejects comma joins', () => {
        fails('SELECT * FROM A, B', 'UNSUPPORTED_JOIN', ', B');
    });

    it('rejects subqueries in WHERE, IN, FROM, columns and EXISTS', () => {
        fails(
            'SELECT * FROM A WHERE x IN (SELECT y FROM B)',
            'UNSUPPORTED_SUBQUERY',
            '(SELECT y FROM B)',
        );
        fails('SELECT * FROM (SELECT * FROM B)', 'UNSUPPORTED_SUBQUERY', '(SELECT * FROM B)');
        fails('SELECT (SELECT 1) FROM B', 'UNSUPPORTED_SUBQUERY', '(SELECT 1)');
        fails(
            'SELECT * FROM A WHERE x = (SELECT y FROM B)',
            'UNSUPPORTED_SUBQUERY',
            '(SELECT y FROM B)',
        );
        fails(
            'SELECT * FROM A WHERE EXISTS (SELECT 1 FROM B)',
            'UNSUPPORTED_SUBQUERY',
            'EXISTS (SELECT 1 FROM B)',
        );
        fails('SELECT * FROM A WHERE (SELECT 1) = 1', 'UNSUPPORTED_SUBQUERY', '(SELECT 1)');
    });

    it('rejects GROUP BY', () => {
        fails('SELECT a FROM B GROUP BY a', 'UNSUPPORTED_GROUP_BY', 'GROUP BY');
        fails('SELECT a FROM B WHERE a = 1 GROUP BY a', 'UNSUPPORTED_GROUP_BY', 'GROUP BY');
    });

    it('rejects HAVING', () => {
        fails('SELECT a FROM B HAVING a > 1', 'UNSUPPORTED_HAVING', 'HAVING');
    });

    it('rejects aggregates', () => {
        fails('SELECT COUNT(*) FROM B', 'UNSUPPORTED_AGGREGATE', 'COUNT(*)');
        fails('SELECT max(Age) FROM B', 'UNSUPPORTED_AGGREGATE', 'max(Age)');
        fails('SELECT * FROM B WHERE SUM(x) > 1', 'UNSUPPORTED_AGGREGATE', 'SUM(x)');
    });

    it('rejects DISTINCT', () => {
        fails('SELECT DISTINCT Email FROM B', 'UNSUPPORTED_DISTINCT', 'DISTINCT');
    });

    it('rejects functions in columns, conditions, values and ORDER BY', () => {
        fails('SELECT LOWER(Email) FROM B', 'UNSUPPORTED_FUNCTION', 'LOWER(Email)');
        fails(
            'SELECT * FROM B WHERE Created > DATEADD(day, -7, GETDATE())',
            'UNSUPPORTED_FUNCTION',
            'DATEADD(day, -7, GETDATE())',
        );
        fails('SELECT * FROM B WHERE Created > GETDATE()', 'UNSUPPORTED_FUNCTION', 'GETDATE()');
        fails(
            'SELECT * FROM B WHERE CONVERT(date, Created) = 1',
            'UNSUPPORTED_FUNCTION',
            'CONVERT(date, Created)',
        );
        fails("SELECT * FROM B WHERE LEFT(Zip, 2) = '10'", 'UNSUPPORTED_FUNCTION', 'LEFT(Zip, 2)');
        fails('SELECT * FROM B ORDER BY LOWER(a)', 'UNSUPPORTED_FUNCTION', 'LOWER(a)');
        fails("SELECT * FROM B WHERE a IN ('x', UPPER('y'))", 'UNSUPPORTED_FUNCTION', "UPPER('y')");
    });

    it('rejects CASE expressions', () => {
        fails("SELECT CASE WHEN a = 1 THEN 'x' END FROM B", 'UNSUPPORTED_FUNCTION', 'CASE');
    });

    it('rejects column-vs-column comparisons', () => {
        const message = fails(
            'SELECT * FROM B WHERE FirstName = LastName',
            'UNSUPPORTED_COLUMN_COMPARISON',
            'FirstName = LastName',
        );
        assert.match(message.message, /'LastName'/);
        fails(
            'SELECT * FROM B WHERE a BETWEEN b AND 5',
            'UNSUPPORTED_COLUMN_COMPARISON',
            'a BETWEEN b',
        );
        fails('SELECT * FROM B WHERE a LIKE [b]', 'UNSUPPORTED_COLUMN_COMPARISON', 'a LIKE [b]');
    });

    it('rejects aliases with and without AS', () => {
        fails('SELECT Email AS Mail FROM B', 'UNSUPPORTED_ALIAS', 'Email AS Mail');
        fails('SELECT Email Mail FROM B', 'UNSUPPORTED_ALIAS', 'Email Mail');
        fails('SELECT * FROM B AS x', 'UNSUPPORTED_ALIAS', 'B AS x');
        fails('SELECT * FROM B x WHERE x.a = 1', 'UNSUPPORTED_ALIAS', 'B x');
    });

    it('rejects prefixed names', () => {
        fails('SELECT b.Email FROM B', 'UNSUPPORTED_QUALIFIED_NAME', 'b.Email');
        fails('SELECT * FROM ENT.[Shared DE]', 'UNSUPPORTED_QUALIFIED_NAME', 'ENT.[Shared DE]');
    });

    it('rejects NOT LIKE', () => {
        fails("SELECT * FROM B WHERE a NOT LIKE 'x%'", 'UNSUPPORTED_NOT_LIKE', 'NOT LIKE');
    });

    it('rejects NOT BETWEEN', () => {
        fails(
            'SELECT * FROM B WHERE a NOT BETWEEN 1 AND 2',
            'UNSUPPORTED_NOT_BETWEEN',
            'NOT BETWEEN',
        );
    });

    it('rejects NOT around a group or condition', () => {
        fails(
            'SELECT * FROM B WHERE NOT (a = 1 OR b = 2)',
            'UNSUPPORTED_NOT_CONDITION',
            'NOT (a = 1 OR b = 2)',
        );
        fails('SELECT * FROM B WHERE x = 1 AND NOT a = 1', 'UNSUPPORTED_NOT_CONDITION', 'NOT a');
    });

    it('rejects * mixed with columns', () => {
        fails('SELECT *, Email FROM B', 'UNSUPPORTED_STAR_WITH_COLUMNS', '*, Email');
        fails('SELECT Email, * FROM B', 'UNSUPPORTED_STAR_WITH_COLUMNS', '*');
    });

    it('rejects UNION / EXCEPT / INTERSECT', () => {
        fails('SELECT a FROM B UNION SELECT a FROM C', 'UNSUPPORTED_UNION', 'UNION');
        fails(
            'SELECT a FROM B WHERE a = 1 UNION ALL SELECT a FROM C',
            'UNSUPPORTED_UNION',
            'UNION ALL',
        );
        fails('SELECT a FROM B ORDER BY a EXCEPT SELECT a FROM C', 'UNSUPPORTED_UNION', 'EXCEPT');
    });

    it('rejects multiple statements', () => {
        fails(
            'SELECT a FROM B; SELECT b FROM C',
            'UNSUPPORTED_MULTIPLE_STATEMENTS',
            'SELECT b FROM C',
        );
    });

    it('warns about system data views but still returns the AST', () => {
        for (const view of ['_Subscribers', '_Sent', '_Open', '_Click', '_Bounce', '_Job']) {
            const text = `SELECT * FROM ${view}`;
            const result = parseSql(text);
            assert.ok(result.ast, view);
            assert.equal(result.ast.from.name, view);
            assert.equal(result.messages.length, 1);
            assert.equal(result.messages[0].severity, 'warning');
            assert.equal(result.messages[0].code, 'SYSTEM_DATA_VIEW');
            assert.equal(marked(text, result.messages[0]), view);
        }
    });

    it('rejects TOP PERCENT and invalid TOP values', () => {
        fails('SELECT TOP 10 PERCENT * FROM B', 'INVALID_TOP', 'TOP 10 PERCENT');
        fails('SELECT TOP 1.5 * FROM B', 'INVALID_TOP', 'TOP 1.5');
        fails('SELECT TOP x * FROM B', 'INVALID_TOP', 'TOP x');
        fails('SELECT TOP 5 WITH TIES * FROM B', 'INVALID_TOP', 'TOP 5 WITH TIES');
    });

    it('rejects comparisons with NULL', () => {
        fails('SELECT * FROM B WHERE a = NULL', 'NULL_COMPARISON', 'NULL');
    });

    it('rejects a value before the column', () => {
        fails('SELECT * FROM B WHERE 5 < Age', 'LITERAL_ON_LEFT', '5');
        fails("SELECT * FROM B WHERE 'x' = a", 'LITERAL_ON_LEFT', "'x'");
    });

    it('rejects ORDER BY column position', () => {
        fails('SELECT a FROM B ORDER BY 1', 'EXPECTED_IDENTIFIER', '1');
    });

    it('rejects non-SELECT statements', () => {
        fails('UPDATE B SET a = 1', 'EXPECTED_SELECT', 'UPDATE');
        fails('DELETE FROM B', 'EXPECTED_SELECT', 'DELETE');
        fails('FROM B', 'EXPECTED_SELECT', 'FROM');
    });
});

describe('syntax errors', () => {
    it('reports empty input', () => {
        fails('', 'EMPTY_INPUT');
        fails('   \n\t ', 'EMPTY_INPUT');
        fails('-- only a comment', 'EMPTY_INPUT');
    });

    it('treats non-string input as empty', () => {
        for (const input of [undefined, null, 42, {}, []]) {
            const result = parseSql(input);
            assert.equal(result.ast, null);
            assert.equal(result.messages[0].code, 'EMPTY_INPUT');
        }
    });

    it('reports a missing FROM', () => {
        fails('SELECT a', 'EXPECTED_FROM');
        fails('SELECT a b c', 'UNSUPPORTED_ALIAS', 'a b');
    });

    it('reports a missing data extension name', () => {
        fails('SELECT * FROM', 'EXPECTED_IDENTIFIER');
        fails('SELECT * FROM WHERE', 'EXPECTED_IDENTIFIER', 'WHERE');
    });

    it('suggests brackets for reserved words used as names', () => {
        const message = fails('SELECT Order FROM B', 'EXPECTED_IDENTIFIER', 'Order');
        assert.match(message.message, /\[Order\]/);
    });

    it('reports unterminated strings, brackets and comments', () => {
        fails("SELECT * FROM B WHERE a = 'abc", 'UNTERMINATED_STRING', "'abc");
        fails('SELECT [abc FROM B', 'UNTERMINATED_IDENTIFIER', '[abc FROM B');
        fails('SELECT * FROM B /* open', 'UNTERMINATED_COMMENT', '/* open');
        fails('SELECT [] FROM B', 'EMPTY_IDENTIFIER', '[]');
    });

    it('rejects U+2028 / U+2029 inside a [name]', () => {
        for (const codePoint of [0x20_28, 0x20_29]) {
            const separator = String.fromCodePoint(codePoint);
            fails(`SELECT [a${separator}b] FROM B`, 'UNSUPPORTED_LINE_SEPARATOR', separator);
            fails(`SELECT A FROM [x]]y${separator}]`, 'UNSUPPORTED_LINE_SEPARATOR', separator);
        }
    });

    it('reports unexpected characters with hints', () => {
        const quotes = fails('SELECT * FROM B WHERE a = "x"', 'UNEXPECTED_CHARACTER', '"');
        assert.match(quotes.message, /single quotes/);
        const variable = fails('SELECT * FROM B WHERE a = @x', 'UNEXPECTED_CHARACTER', '@');
        assert.match(variable.message, /Variables/);
        fails('SELECT * FROM B WHERE a = 1 & 2', 'UNEXPECTED_CHARACTER', '&');
    });

    it('reports a missing closing parenthesis at the opening one', () => {
        fails('SELECT * FROM B WHERE (a = 1', 'MISSING_CLOSING_PAREN', '(');
        fails("SELECT * FROM B WHERE a IN ('x', 'y'", 'MISSING_CLOSING_PAREN', '(');
    });

    it('reports an extra closing parenthesis', () => {
        fails('SELECT * FROM B WHERE a = 1)', 'SYNTAX_ERROR', ')');
    });

    it('reports missing operators and values', () => {
        fails('SELECT * FROM B WHERE a', 'EXPECTED_OPERATOR');
        fails('SELECT * FROM B WHERE a 1', 'EXPECTED_OPERATOR', '1');
        fails('SELECT * FROM B WHERE a =', 'EXPECTED_VALUE');
        fails('SELECT * FROM B WHERE a IN ()', 'EXPECTED_VALUE', ')');
        fails('SELECT * FROM B WHERE a = 1 AND', 'EXPECTED_IDENTIFIER');
        fails('SELECT * FROM B WHERE', 'EXPECTED_IDENTIFIER');
    });

    it('reports a non-text LIKE pattern', () => {
        fails('SELECT * FROM B WHERE a LIKE 5', 'EXPECTED_STRING', '5');
    });

    it('reports BETWEEN without AND and IS without NULL', () => {
        fails('SELECT * FROM B WHERE a BETWEEN 1 OR 2', 'SYNTAX_ERROR', 'OR');
        fails('SELECT * FROM B WHERE a IS 5', 'SYNTAX_ERROR', '5');
    });

    it('reports conditions not joined with AND / OR', () => {
        fails('SELECT * FROM B WHERE a = 1 b = 2', 'SYNTAX_ERROR', 'b');
    });

    it('reports ORDER without BY', () => {
        fails('SELECT * FROM B ORDER a', 'SYNTAX_ERROR', 'a');
    });

    it('reports the location on later lines', () => {
        const message = fails('SELECT *\nFROM B\nWHERE a = GETDATE()', 'UNSUPPORTED_FUNCTION');
        assert.equal(message.line, 3);
        assert.equal(message.column, 11);
        assert.equal(message.endLine, 3);
        assert.equal(message.endColumn, 20);
    });
});

describe('robustness', () => {
    const garbage = [
        ')))(((',
        'SELECT',
        'SELECT SELECT SELECT',
        'select * from',
        'SELECT * FROM B WHERE ((((',
        'SELECT * FROM B WHERE a = 1 OR OR',
        'SELECT * FROM B ORDER BY',
        'SELECT * FROM B ORDER BY a,',
        'SELECT a,, b FROM C',
        'SELECT , FROM',
        '\u{0}\u{1}\u{2}',
        '🙂🙂🙂',
        "'''''",
        '[[[[',
        '/*/',
        'SELECT * FROM B WHERE a = -',
        'SELECT * FROM B WHERE a = - 5',
        'SELECT TOP',
        'SELECT TOP (5 * FROM B',
        'SELECT * FROM B WITH (NOLOCK',
        'SELECT * FROM B WHERE NOT',
        'SELECT * FROM B WHERE a NOT',
        'SELECT * FROM B WHERE a NOT x',
        'SELECT * FROM B INNER',
        'SELECT * FROM B UNION',
        'SELECT * FROM B,',
        'SELECT * FROM B AS',
        'SELECT a.',
        'SELECT * FROM B WHERE EXISTS',
        'SELECT COUNT(',
        `SELECT * FROM B WHERE ${'('.repeat(100_000)}a = 1`,
    ];

    for (const input of garbage) {
        it(`never throws on ${JSON.stringify(input.slice(0, 40))}`, () => {
            const result = parseSql(input);
            assert.equal(result.ast, null);
            assert.ok(result.messages.length > 0);
            for (const message of result.messages) {
                assert.ok(['error', 'warning', 'info'].includes(message.severity));
                assert.ok(Object.values(MESSAGE_CODES).includes(message.code));
                assert.ok(message.line >= 1 && message.column >= 1);
                assert.ok(
                    message.endLine > message.line ||
                        (message.endLine === message.line && message.endColumn >= message.column),
                );
            }
        });
    }

    it('never throws on random input', () => {
        const alphabet = [
            'SELECT ',
            'FROM ',
            'WHERE ',
            'AND ',
            'OR ',
            'NOT ',
            'IN ',
            'LIKE ',
            'IS ',
            'NULL ',
            '(',
            ')',
            ',',
            '*',
            "'x'",
            '[a b]',
            'a ',
            '1 ',
            '= ',
            '<> ',
            '-',
            ';',
            '--',
            '\n',
            'TOP ',
            'ORDER BY ',
        ];
        let seed = 12_345;
        const random = () => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed / 2_147_483_648;
        };
        for (let run = 0; run < 2000; run++) {
            let text = '';
            const length = Math.floor(random() * 20);
            for (let index = 0; index < length; index++) {
                text += alphabet[Math.floor(random() * alphabet.length)];
            }
            const result = parseSql(text);
            assert.ok(Array.isArray(result.messages), text);
            assert.equal(
                result.ast === null,
                result.messages.some((message) => message.severity === 'error'),
                text,
            );
        }
    });
});
