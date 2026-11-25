import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseSql } from '../src/sql-parser.js';
import { parseSsjs } from '../src/parse-ssjs.js';
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
 * Parses SSJS that must succeed without errors and returns the result.
 *
 * @param {string} code SSJS code
 * @returns {object} parse result
 */
function ok(code) {
    const result = parseSsjs(code);
    assert.deepEqual(
        result.messages.filter((message) => message.severity === 'error'),
        [],
        `unexpected errors for: ${code}`,
    );
    assert.ok(result.ast);
    return result;
}

/**
 * Asserts that SSJS code gives the same AST (ignoring loc) as a SQL query.
 *
 * @param {string} code SSJS code
 * @param {string} sql equivalent SQL
 */
function sameAs(code, sql) {
    const expected = parseSql(sql);
    assert.equal(expected.ast !== null, true, `SQL must parse: ${sql}`);
    assert.deepEqual(stripLoc(ok(code).ast), stripLoc(expected.ast));
}

/**
 * Parses SSJS that must fail with one error and returns that error.
 *
 * @param {string} code SSJS code
 * @param {string} code_ expected message code
 * @returns {object} the error message
 */
function error(code, code_) {
    const result = parseSsjs(code);
    assert.equal(result.ast, null);
    const errors = result.messages.filter((message) => message.severity === 'error');
    assert.equal(errors.length, 1, JSON.stringify(result.messages));
    assert.equal(errors[0].code, code_);
    return errors[0];
}

/**
 * Builds a WSProxy retrieve snippet with a header comment.
 *
 * @param {string} filter filter source
 * @param {string} [columns] column array source
 * @returns {string} SSJS code
 */
function wsproxy(filter, columns = '["Name", "Age"]') {
    return `// SQL: FROM [Customers] (external key CUST_KEY)
var api = new Script.Util.WSProxy();
var result = api.retrieve("DataExtensionObject[CUST_KEY]", ${columns}, ${filter});`;
}

const simple = (property, operator, value) =>
    `{ Property: "${property}", SimpleOperator: "${operator}", Value: ${value} }`;

describe('parseSsjs — WSProxy operators', () => {
    const cases = [
        ['equals', '"x"', "Name = 'x'"],
        ['notEquals', '"x"', "Name <> 'x'"],
        ['greaterThan', '"5"', 'Name > 5'],
        ['greaterThanOrEqual', '5', 'Name >= 5'],
        ['lessThan', '"-2.5"', 'Name < -2.5'],
        ['lessThanOrEqual', '"007"', "Name <= '007'"],
        // without a sqlLike check the like filter matches anywhere
        ['like', '"a%"', "Name LIKE '%a%'"],
        ['like', '"123"', "Name LIKE '%123%'"],
        ['IN', '["a", "b", 3]', "Name IN ('a', 'b', 3)"],
        ['between', '["1", "9"]', 'Name BETWEEN 1 AND 9'],
        ['isNull', '""', 'Name IS NULL'],
        ['isNotNull', '""', 'Name IS NOT NULL'],
    ];
    for (const [operator, value, condition] of cases) {
        it(`${operator} ${value}`, () => {
            sameAs(
                wsproxy(simple('Name', operator, value)),
                `SELECT Name, Age FROM [Customers] WHERE ${condition}`,
            );
        });
    }

    it('accepts operator names in any case', () => {
        sameAs(
            wsproxy(simple('Name', 'EQUALS', '"x"')),
            "SELECT Name, Age FROM Customers WHERE Name = 'x'",
        );
    });

    it('accepts DateValue as Value', () => {
        sameAs(
            wsproxy('{Property: "Name", SimpleOperator: "greaterThan", DateValue: "2026-01-01"}'),
            "SELECT Name, Age FROM Customers WHERE Name > '2026-01-01'",
        );
    });

    it('isNull without Value', () => {
        sameAs(
            wsproxy('{Property: "Name", SimpleOperator: "isNull"}'),
            'SELECT Name, Age FROM Customers WHERE Name IS NULL',
        );
    });
});

describe('parseSsjs — nesting and syntax', () => {
    it('reads nested ComplexFilterParts to any depth', () => {
        const filter = `{
            LeftOperand: {
                LeftOperand: ${simple('A', 'equals', '"1"')},
                LogicalOperator: "AND",
                RightOperand: ${simple('B', 'equals', '"2"')},
            },
            LogicalOperator: "OR",
            RightOperand: {
                LeftOperand: ${simple('C', 'like', '"%x%"')},
                LogicalOperator: "and",
                RightOperand: {
                    LeftOperand: ${simple('D', 'isNotNull', '""')},
                    LogicalOperator: "OR",
                    RightOperand: ${simple('E', 'lessThan', '"0"')}
                }
            }
        }`;
        sameAs(
            wsproxy(filter),
            "SELECT Name, Age FROM Customers WHERE (A = 1 AND B = 2) OR (C LIKE '%x%' AND (D IS NOT NULL OR E < 0))",
        );
    });

    it('left-nested AND chains equal the SQL parser output', () => {
        const filter = `{LeftOperand: {LeftOperand: ${simple('A', 'equals', '"1"')}, LogicalOperator: "AND", RightOperand: ${simple('B', 'equals', '"2"')}}, LogicalOperator: "AND", RightOperand: ${simple('C', 'equals', '"3"')}}`;
        sameAs(wsproxy(filter), 'SELECT Name, Age FROM Customers WHERE A = 1 AND B = 2 AND C = 3');
    });

    it('accepts quoted keys, single quotes, trailing commas and comments', () => {
        const filter = String.raw`{ 'Property': 'Name', /* the operator */ "SimpleOperator": 'equals', // line comment
            "Value": 'it\'s', }`;
        sameAs(wsproxy(filter), "SELECT Name, Age FROM Customers WHERE Name = 'it''s'");
    });

    it('reads a filter given as a variable, with parts as variables', () => {
        const code = `// SQL: FROM [Customers] (external key CUST_KEY)
var proxy = new Script.Util.WSProxy();
var cols = ["Name"];
var left = ${simple('A', 'equals', '"1"')};
var right = ${simple('B', 'notEquals', '"x"')};
var filter = { LeftOperand: left, LogicalOperator: "AND", RightOperand: right };
var data = proxy.retrieve("DataExtensionObject[CUST_KEY]", cols, filter, { BatchSize: 2500 }, {});`;
        sameAs(code, "SELECT Name FROM Customers WHERE A = 1 AND B <> 'x'");
    });

    it('uses the last assignment before the call', () => {
        const code = `var f = ${simple('A', 'equals', '"old"')};
f = ${simple('A', 'equals', '"new"')};
var r = p.retrieve("DataExtensionObject[K]", ["A"], f);`;
        assert.equal(ok(code).ast.where.value.value, 'new');
    });

    it('reads the code inside <script runat="server"> and ignores HTML around it', () => {
        const code = `<p>Don't worry</p>
<script runat="server">
Platform.Load("core", "1.1.1");
var p = new Script.Util.WSProxy();
var r = p.retrieve("DataExtensionObject[K]", ["A"], ${simple('A', 'equals', '"1"')});
</script>
<p>It's fine</p>`;
        sameAs(code, 'SELECT A FROM K WHERE A = 1');
    });

    it('works without a filter', () => {
        sameAs(
            'var r = proxy.retrieve("DataExtensionObject[K]", ["A", "B"]);',
            'SELECT A, B FROM K',
        );
        sameAs('var r = proxy.retrieve("DataExtensionObject[K]", ["A"], null);', 'SELECT A FROM K');
    });
});

describe('parseSsjs — header comment and meta', () => {
    it('takes name and key from the header', () => {
        const result = ok(wsproxy(simple('A', 'equals', '"1"')));
        assert.deepEqual(result.meta, {
            target: 'ssjs-wsproxy',
            deKey: 'CUST_KEY',
            deName: 'Customers',
        });
        assert.equal(result.ast.from.name, 'Customers');
        assert.equal(result.ast.from.loc.line, 1);
        assert.equal(result.ast.from.loc.column, 14);
        assert.equal(result.ast.from.loc.endColumn, 25);
    });

    it('uses the key as name without a header (info)', () => {
        const result = ok('var r = p.retrieve("DataExtensionObject[My_Key]", ["A"]);');
        assert.equal(result.ast.from.name, 'My_Key');
        assert.deepEqual(result.meta, { target: 'ssjs-wsproxy', deKey: 'My_Key' });
        assert.equal(result.messages[0].code, REVERSE_MESSAGE_CODES.FROM_NAME_FROM_KEY);
        assert.equal(result.messages[0].severity, 'info');
    });

    it('reads bracketed names with spaces and a SELECT header', () => {
        const code = `// SQL: SELECT [First Name], Email
// SQL: FROM [My ]] DE] (external key abc-123)
var rows = DataExtension.Init("abc-123").Rows.Retrieve();`;
        const result = ok(code);
        assert.equal(result.ast.from.name, 'My ] DE');
        assert.deepEqual(stripLoc(result.ast.columns), [{ name: 'First Name' }, { name: 'Email' }]);
        assert.equal(result.meta.target, 'ssjs-rows-retrieve');
    });

    it('header in a block comment', () => {
        const code = `/* SQL: SELECT * FROM [Customers] (external key K) */
var r = DataExtension.Init("K").Rows.Retrieve({Property: "A", SimpleOperator: "equals", Value: "x"});`;
        sameAs(code, "SELECT * FROM Customers WHERE A = 'x'");
    });

    it('folds <> chains into NOT IN only with the NOT IN header marker', () => {
        const filter = `{LeftOperand: ${simple('A', 'notEquals', '"x"')}, LogicalOperator: "AND", RightOperand: ${simple('A', 'notEquals', '"y"')}}`;
        const body = `var r = p.retrieve("DataExtensionObject[K]", ["A"], ${filter});`;
        sameAs(body, "SELECT A FROM K WHERE A <> 'x' AND A <> 'y'");
        const folded = ok(`// SQL: NOT IN\n${body}`);
        assert.equal(folded.meta.foldNotIn, true);
        assert.deepEqual(
            stripLoc(folded.ast),
            stripLoc(parseSql("SELECT A FROM K WHERE A NOT IN ('x', 'y')").ast),
        );
    });

    it('folds only the pure <> subtree', () => {
        const notIn = `{LeftOperand: ${simple('A', 'notEquals', '"x"')}, LogicalOperator: "AND", RightOperand: ${simple('A', 'notEquals', '"y"')}}`;
        const filter = `{LeftOperand: ${simple('B', 'equals', '"1"')}, LogicalOperator: "AND", RightOperand: ${notIn}}`;
        const result = ok(
            `// SQL: NOT IN\nvar r = p.retrieve("DataExtensionObject[K]", ["A"], ${filter});`,
        );
        assert.deepEqual(
            stripLoc(result.ast.where),
            stripLoc(parseSql("SELECT A FROM K WHERE B = 1 AND (A NOT IN ('x', 'y'))").ast.where),
        );
    });
});

describe('parseSsjs — Rows.Retrieve and Platform.Function', () => {
    it('DataExtension.Init via variable', () => {
        const code = `var de = DataExtension.Init("K");
var rows = de.Rows.Retrieve({Property: "Age", SimpleOperator: "IN", Value: [1, 2]});`;
        sameAs(code, 'SELECT * FROM K WHERE Age IN (1, 2)');
    });

    it('Rows.Retrieve without filter', () => {
        sameAs('var rows = DataExtension.Init("K").Rows.Retrieve();', 'SELECT * FROM K');
    });

    it('Platform.Function.LookupRows with single column', () => {
        const result = ok(
            'var rows = Platform.Function.LookupRows("Customers", "Email", "a@b.c");',
        );
        assert.deepEqual(
            stripLoc(result.ast),
            stripLoc(parseSql("SELECT * FROM Customers WHERE Email = 'a@b.c'").ast),
        );
        assert.deepEqual(result.meta, { target: 'ssjs-lookuprows', deName: 'Customers' });
    });

    it('LookupRows with arrays and header columns', () => {
        sameAs(
            '// SQL: SELECT Name, Age\nvar rows = LookupRows("Customers", ["City", "Age"], ["Berlin", 30]);',
            "SELECT Name, Age FROM Customers WHERE City = 'Berlin' AND Age = 30",
        );
    });

    it('LookupOrderedRows with count and sort', () => {
        sameAs(
            'var rows = Platform.Function.LookupOrderedRows("Customers", 10, "LastName ASC, Age DESC", "City", "Berlin");',
            "SELECT TOP 10 * FROM Customers WHERE City = 'Berlin' ORDER BY LastName ASC, Age DESC",
        );
    });

    it('LookupOrderedRows count 0 means no TOP', () => {
        sameAs(
            'var rows = LookupOrderedRows("Customers", 0, "[Last Name]", "City", "Berlin");',
            "SELECT * FROM Customers WHERE City = 'Berlin' ORDER BY [Last Name]",
        );
    });

    it('order-by loc points inside the string', () => {
        const code = 'LookupOrderedRows("D", 1, "A, B DESC", "C", "x")';
        const item = ok(code).ast.orderBy[1];
        assert.equal(code.slice(item.loc.start, item.loc.end), 'B DESC');
    });
});

describe('parseSsjs — bare filter objects', () => {
    it('bare object literal: columns * and unknown FROM warning', () => {
        const result = ok(simple('A', 'equals', '"1"'));
        assert.equal(result.ast.columns, '*');
        assert.equal(result.ast.from.name, '');
        assert.equal(result.meta.target, 'ssjs-filter');
        assert.equal(result.messages[0].code, REVERSE_MESSAGE_CODES.FROM_UNKNOWN);
        assert.equal(result.messages[0].severity, 'warning');
    });

    it('bare filter variables: the last filter object is the whole filter', () => {
        const code = `var a = ${simple('A', 'equals', '"1"')};
var b = ${simple('B', 'equals', '"2"')};
var filter = {LeftOperand: a, LogicalOperator: "OR", RightOperand: b};`;
        assert.deepEqual(
            stripLoc(ok(code).ast.where),
            stripLoc(parseSql('SELECT * FROM X WHERE A = 1 OR B = 2').ast.where),
        );
    });

    it('bare filter with a FROM header has no warning', () => {
        const result = ok(
            `// SQL: FROM [Customers] (external key K)\n${simple('A', 'equals', '"1"')}`,
        );
        assert.equal(result.messages.length, 0);
        assert.deepEqual(result.meta, { target: 'ssjs-filter', deName: 'Customers', deKey: 'K' });
    });
});

describe('parseSsjs — errors', () => {
    it('existsInString is rejected', () => {
        const code = wsproxy(simple('A', 'existsInString', '"x"'));
        const message = error(code, REVERSE_MESSAGE_CODES.UNSUPPORTED_FILTER_OPERATOR);
        const line = code.split('\n', 3)[2];
        assert.equal(message.line, 3);
        assert.equal(message.column, line.indexOf('"existsInString"') + 1);
    });

    it('beginsWith is rejected with a like hint', () => {
        const message = error(
            wsproxy(simple('A', 'beginsWith', '"x"')),
            REVERSE_MESSAGE_CODES.UNSUPPORTED_FILTER_OPERATOR,
        );
        assert.match(message.message, /like/);
    });

    it('unknown operator', () => {
        error(wsproxy(simple('A', 'sameAs', '"x"')), REVERSE_MESSAGE_CODES.UNKNOWN_FILTER_OPERATOR);
    });

    it('bad logical operator', () => {
        error(
            wsproxy(
                `{LeftOperand: ${simple('A', 'equals', '"1"')}, LogicalOperator: "XOR", RightOperand: ${simple('B', 'equals', '"1"')}}`,
            ),
            REVERSE_MESSAGE_CODES.INVALID_LOGICAL_OPERATOR,
        );
    });

    it('missing RightOperand', () => {
        error(
            wsproxy(`{LeftOperand: ${simple('A', 'equals', '"1"')}, LogicalOperator: "AND"}`),
            REVERSE_MESSAGE_CODES.INVALID_FILTER,
        );
    });

    it('missing SimpleOperator', () => {
        error(wsproxy('{Property: "A", Value: "1"}'), REVERSE_MESSAGE_CODES.INVALID_FILTER);
    });

    it('IN needs an array, between two values, equals no null', () => {
        error(wsproxy(simple('A', 'IN', '"x"')), REVERSE_MESSAGE_CODES.INVALID_FILTER_VALUE);
        error(wsproxy(simple('A', 'between', '["1"]')), REVERSE_MESSAGE_CODES.INVALID_FILTER_VALUE);
        error(wsproxy(simple('A', 'equals', 'null')), REVERSE_MESSAGE_CODES.INVALID_FILTER_VALUE);
        error(wsproxy(simple('A', 'equals', '["1"]')), REVERSE_MESSAGE_CODES.INVALID_FILTER_VALUE);
        error(
            wsproxy('{Property: "A", SimpleOperator: "equals"}'),
            REVERSE_MESSAGE_CODES.INVALID_FILTER_VALUE,
        );
    });

    it('calculated values and calls are rejected with their position', () => {
        const code =
            'var r = p.retrieve("DataExtensionObject[K]", ["A"], {Property: "A", SimpleOperator: "equals", Value: Request.GetQueryStringParameter("x")});';
        const message = error(code, REVERSE_MESSAGE_CODES.UNSUPPORTED_EXPRESSION);
        assert.equal(
            code.slice(message.column - 1, message.endColumn - 1),
            'Request.GetQueryStringParameter("x")',
        );
        error(
            wsproxy(simple('A', 'equals', '"a" + "b"')),
            REVERSE_MESSAGE_CODES.UNSUPPORTED_EXPRESSION,
        );
        error(
            wsproxy(simple('A', 'greaterThan', 'new Date()')),
            REVERSE_MESSAGE_CODES.UNSUPPORTED_EXPRESSION,
        );
    });

    it('variables that are not fixed values', () => {
        const message = error(
            wsproxy(simple('A', 'equals', 'someValue')),
            REVERSE_MESSAGE_CODES.VARIABLE_VALUE,
        );
        assert.match(message.message, /someValue/);
        error(
            `var v = Platform.Request.GetQueryStringParameter("v");\n${wsproxy(simple('A', 'equals', 'v'))}`,
            REVERSE_MESSAGE_CODES.VARIABLE_VALUE,
        );
        error(
            'var self = self;\nvar r = p.retrieve("DataExtensionObject[K]", ["A"], self);',
            REVERSE_MESSAGE_CODES.VARIABLE_VALUE,
        );
        error('var rows = de.Rows.Retrieve();', REVERSE_MESSAGE_CODES.VARIABLE_VALUE);
    });

    it('not a data extension object type', () => {
        error(
            'var r = p.retrieve("Subscriber", ["EmailAddress"]);',
            REVERSE_MESSAGE_CODES.INVALID_OBJECT_TYPE,
        );
    });

    it('argument count and column checks', () => {
        error(
            'var r = p.retrieve("DataExtensionObject[K]");',
            REVERSE_MESSAGE_CODES.ARGUMENT_COUNT,
        );
        error('var r = LookupRows("D", "A");', REVERSE_MESSAGE_CODES.ARGUMENT_COUNT);
        error(
            'var r = p.retrieve("DataExtensionObject[K]", []);',
            REVERSE_MESSAGE_CODES.INVALID_ARGUMENT,
        );
        error(
            'var r = LookupRows("D", ["A", "B"], ["1"]);',
            REVERSE_MESSAGE_CODES.INVALID_ARGUMENT,
        );
        error(
            'var r = LookupOrderedRows("D", "ten", "A", "B", "1");',
            REVERSE_MESSAGE_CODES.INVALID_COUNT,
        );
        error(
            'var r = LookupOrderedRows("D", 5, "A ASC DESC", "B", "1");',
            REVERSE_MESSAGE_CODES.INVALID_ORDER_BY,
        );
    });

    it('nothing to convert', () => {
        error('var x = 1;', REVERSE_MESSAGE_CODES.NO_LOOKUP_FOUND);
        error('   // only a comment\n', 'EMPTY_INPUT');
    });

    it('several lookups: first converted, warning', () => {
        const result = ok('var a = LookupRows("D", "A", "1");\nvar b = LookupRows("E", "B", "2");');
        assert.equal(result.ast.from.name, 'D');
        assert.equal(result.messages[0].code, REVERSE_MESSAGE_CODES.MULTIPLE_LOOKUPS);
        assert.equal(result.messages[0].line, 2);
    });

    it('unterminated string and unclosed call', () => {
        error('var r = LookupRows("D, "A", "1");\n', 'UNTERMINATED_STRING');
        error('var r = LookupRows("D", "A", "1"', 'MISSING_CLOSING_PAREN');
    });
});

describe('parseSsjs — garbage input never throws', () => {
    const inputs = [
        undefined,
        null,
        42,
        '',
        '{',
        '}{',
        '((((',
        'p.retrieve(',
        'p.retrieve("DataExtensionObject[K]", ["A"], {LeftOperand:',
        '/* unclosed',
        '`template`',
        '\u{0}￿💥',
        '{LeftOperand:'.repeat(5000),
        `var a = ${'['.repeat(20000)}`,
        'DataExtension.Init(',
        ').Rows.Retrieve()',
    ];
    for (const input of inputs) {
        it(`does not throw for ${JSON.stringify(String(input)).slice(0, 40)}`, () => {
            const result = parseSsjs(input);
            assert.ok(Array.isArray(result.messages));
            assert.equal(typeof result.meta, 'object');
            if (result.ast === null) {
                assert.ok(result.messages.some((message) => message.severity === 'error'));
            }
        });
    }
});
