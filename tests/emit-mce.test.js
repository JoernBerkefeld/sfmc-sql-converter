import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    MCE_TARGETS,
    emitAmpscriptLookup,
    emitAmpscriptLookupOrderedRows,
    emitAmpscriptLookupRows,
    emitSsjsLookupOrderedRows,
    emitSsjsLookupRows,
    emitSsjsRowsRetrieve,
    emitSsjsWsproxy,
    parseSql,
    parseSsjs,
} from '../src/index.js';
import { ampString, jsString } from '../src/emit-mce.js';

// the six characters backslash, u, 0, 0, 5, C
const U005C = ['\\', 'u005C'].join('');

/**
 * Parses SQL and fails the test when it does not parse.
 *
 * @param {string} sql query
 * @returns {object} AST
 */
function ast(sql) {
    const result = parseSql(sql);
    assert.ok(result.ast, `query should parse: ${sql} ${JSON.stringify(result.messages)}`);
    return result.ast;
}

/**
 * Syntax-checks emitted SSJS (never runs it): strips the script tags and compiles the body.
 *
 * @param {string} code emitted SSJS
 */
function assertValidSsjs(code) {
    assert.match(code, /^<script runat="server">\n/);
    assert.match(code, /<\/script>$/);
    const body = code.replace(/^<script runat="server">/, '').replace(/<\/script>$/, '');
    // eslint-disable-next-line no-new-func -- syntax check only; the function is never called
    assert.doesNotThrow(() => new Function(body), `invalid SSJS:\n${code}`);
}

/**
 * Checks spans: inside the code, sorted, and one or more per condition / column / from.
 *
 * @param {object} result emitter result
 * @param {object} tree AST
 */
function assertSpans(result, tree) {
    const { code, spans } = result;
    let previous = -1;
    for (const span of spans) {
        assert.ok(span.start >= 0 && span.end <= code.length && span.start < span.end);
        assert.ok(span.start >= previous, 'spans are sorted');
        previous = span.start;
    }
    const ids = new Set(spans.map((span) => span.clauseId));
    assert.ok(ids.has('from'), 'from is mapped');
    let index = 0;
    const walk = (expr) => {
        if (!expr) {
            return;
        }
        if (expr.type === 'and' || expr.type === 'or') {
            walk(expr.left);
            walk(expr.right);
            return;
        }
        const id = `where-${index++}`;
        assert.ok(ids.has(id), `${id} is mapped`);
        const text = spans
            .filter((span) => span.clauseId === id)
            .map((span) => code.slice(span.start, span.end))
            .join(' ');
        assert.ok(text.includes(expr.column), `${id} span contains ${expr.column}`);
    };
    walk(tree.where);
    if (Array.isArray(tree.columns)) {
        for (const [columnIndex] of tree.columns.entries()) {
            assert.ok(ids.has(`column-${columnIndex}`), `column-${columnIndex} is mapped`);
        }
    }
}

const FIELDS = 'SELECT SubscriberKey, Email FROM [Customers]';

/**
 * Constructs and which targets can express them. `lookup` = equals + AND only targets;
 * `ordered` additionally needs ORDER BY; `single` = Lookup (one column).
 */
const CONSTRUCTS = [
    { name: 'equals', where: "Country = 'DE'", lookup: true },
    { name: 'equals AND equals', where: "Country = 'DE' AND Tier = 'Gold'", lookup: true },
    { name: 'not equals', where: "Country <> 'DE'", lookup: false, op: 'notEquals' },
    { name: 'greater than', where: 'Points > 500', lookup: false, op: 'greaterThan' },
    { name: 'greater or equal', where: 'Points >= 500', lookup: false, op: 'greaterThanOrEqual' },
    { name: 'less than', where: 'Points < 300', lookup: false, op: 'lessThan' },
    { name: 'less or equal', where: 'Points <= 300', lookup: false, op: 'lessThanOrEqual' },
    { name: 'LIKE', where: "Email LIKE '%example.com'", lookup: false, op: 'like' },
    { name: 'IN', where: "Country IN ('DE', 'ES')", lookup: false, op: 'IN' },
    { name: 'NOT IN', where: "Country NOT IN ('DE', 'ES')", lookup: false, op: 'notEquals' },
    { name: 'BETWEEN', where: 'Points BETWEEN 300 AND 1200', lookup: false, op: 'between' },
    { name: 'IS NULL', where: 'Tier IS NULL', lookup: false, op: 'isNull' },
    { name: 'IS NOT NULL', where: 'Tier IS NOT NULL', lookup: false, op: 'isNotNull' },
    { name: 'OR', where: "Country = 'US' OR Tier = 'Gold'", lookup: false },
    {
        name: 'grouped AND / OR',
        where: "(Country = 'DE' OR Country = 'FR') AND (Tier IS NULL OR Points < 100)",
        lookup: false,
    },
];

describe('emitters × constructs', () => {
    for (const construct of CONSTRUCTS) {
        for (const suffix of ['', ' ORDER BY Points DESC']) {
            const sql = `${FIELDS} WHERE ${construct.where}${suffix}`;
            const tree = ast(sql);
            for (const target of MCE_TARGETS) {
                it(`${target.id}: ${construct.name}${suffix ? ' + ORDER BY' : ''}`, () => {
                    const result = target.emit(tree, { sourceText: sql });
                    const isLookup =
                        target.id !== 'ssjs-wsproxy' && target.id !== 'ssjs-rows-retrieve';
                    const isOrdered = target.id.endsWith('lookuporderedrows');
                    // Lookup is never expected: two columns are selected
                    const isExpected =
                        (!isLookup || construct.lookup) &&
                        !(isOrdered && !suffix) &&
                        target.id !== 'ampscript-lookup';
                    if (!isExpected) {
                        assert.equal(typeof result.unavailable, 'string');
                        assert.ok(result.unavailable.length > 20);
                        return;
                    }
                    assert.equal(result.unavailable, undefined, result.unavailable);
                    assertSpans(result, tree);
                    if (target.language === 'ssjs') {
                        assertValidSsjs(result.code);
                    } else {
                        assert.match(result.code, /^%%\[\n[\s\S]*\n\]%%$/);
                    }
                    if (construct.op) {
                        assert.match(result.code, new RegExp(`SimpleOperator: "${construct.op}"`));
                    }
                });
            }
        }
    }
});

describe('SSJS filter objects', () => {
    it('values are always strings; numbers keep their text', () => {
        const { code } = emitSsjsWsproxy(ast(`${FIELDS} WHERE Points > 500 AND Amount <= 7.25`));
        assert.match(code, /Value: "500"/);
        assert.match(code, /Value: "7.25"/);
    });

    it('isNull / isNotNull get Value ""', () => {
        const { code } = emitSsjsRowsRetrieve(
            ast(`${FIELDS} WHERE Tier IS NULL OR Zip IS NOT NULL`),
        );
        assert.match(code, /SimpleOperator: "isNull",\n\s+Value: ""/);
        assert.match(code, /SimpleOperator: "isNotNull",\n\s+Value: ""/);
    });

    it('IN and BETWEEN use an array Value', () => {
        const { code } = emitSsjsWsproxy(
            ast(`${FIELDS} WHERE Country IN ('DE', 'ES', 'FR') AND Points BETWEEN 1 AND 10`),
        );
        assert.match(code, /SimpleOperator: "IN",\n\s+Value: \["DE", "ES", "FR"\]/);
        assert.match(code, /SimpleOperator: "between",\n\s+Value: \["1", "10"\]/);
    });

    it('NOT IN becomes an AND chain of notEquals', () => {
        const result = emitSsjsWsproxy(ast(`${FIELDS} WHERE Zip NOT IN ('1', '2', '3')`));
        assert.equal(result.code.match(/"notEquals"/g).length, 3);
        assert.equal(result.code.match(/LogicalOperator: "AND"/g).length, 2);
        const span = result.spans.find((item) => item.clauseId === 'where-0');
        const text = result.code.slice(span.start, span.end);
        assert.equal(text.match(/"notEquals"/g).length, 3, 'one span covers the whole chain');
    });

    it('NOT IN with one value is a single notEquals part', () => {
        const { code } = emitSsjsWsproxy(ast(`${FIELDS} WHERE Zip NOT IN ('1')`));
        assert.doesNotMatch(code, /LogicalOperator/);
        assert.match(code, /"notEquals"/);
    });

    it('LIKE patterns are passed as written', () => {
        const { code } = emitSsjsWsproxy(ast(`${FIELDS} WHERE Notes LIKE '%[%]_x%'`));
        assert.match(code, /SimpleOperator: "like",\n\s+Value: "%\[%\]_x%"/);
    });

    it('AND / OR become nested ComplexFilterParts in source order', () => {
        const { code } = emitSsjsWsproxy(ast(`${FIELDS} WHERE A = '1' AND (B = '2' OR C = '3')`));
        const order = code
            .matchAll(/Property: "(\w)"|LogicalOperator: "(\w+)"/g)
            .map((match) => match[1] ?? match[2])
            .toArray();
        assert.deepEqual(order, ['A', 'AND', 'B', 'OR', 'C']);
    });

    it('escapes quotes, backslashes and </script> in values', () => {
        const result = emitSsjsWsproxy(ast(String.raw`${FIELDS} WHERE Notes = 'a"b\c</script>'`));
        assertValidSsjs(result.code);
        // the backslash is written as a unicode escape, never as an escaped backslash (HTTP 422)
        assert.ok(result.code.includes(String.raw`Value: "a\"b${U005C}c<\/script>"`));
    });

    it('jsString and ampString escape for their language', () => {
        assert.equal(jsString('x"y'), String.raw`"x\"y"`);
        assert.equal(ampString('x"y'), '"x""y"');
    });
});

describe('WSProxy specifics', () => {
    it('uses the external key and keeps the name in a header comment', () => {
        const { code, spans } = emitSsjsWsproxy(ast(`${FIELDS} WHERE Country = 'DE'`), {
            deKey: 'CUST-KEY',
        });
        assert.match(code, /\/\/ SQL: FROM \[Customers\] \(external key CUST-KEY\)\n/);
        assert.match(code, /var objectType = "DataExtensionObject\[CUST-KEY\]";/);
        assert.equal(spans.filter((span) => span.clauseId === 'from').length, 2);
    });

    it('defaults the key to the name', () => {
        const { code } = emitSsjsWsproxy(ast(FIELDS));
        assert.match(code, /DataExtensionObject\[Customers\]/);
    });

    it('without WHERE calls retrieve with a null filter', () => {
        const { code } = emitSsjsWsproxy(ast(FIELDS));
        assert.match(code, /api\.retrieve\(objectType, cols, null\);/);
        assert.doesNotMatch(code, /var filter/);
    });

    it('SELECT * needs a column list', () => {
        const tree = ast('SELECT * FROM Customers');
        assert.match(emitSsjsWsproxy(tree).unavailable, /list of columns/);
        assert.match(
            emitSsjsWsproxy(tree, { columns: ['A', 'B'] }).code,
            /var cols = \["A", "B"\];/,
        );
        assert.match(
            emitSsjsWsproxy(tree, { schema: { fields: [{ name: 'X' }] } }).code,
            /var cols = \["X"\];/,
        );
    });

    it('rowsAsObjects (default) and paging flags', () => {
        const tree = ast(`${FIELDS} WHERE Country = 'DE'`);
        const plain = emitSsjsWsproxy(tree).code;
        assert.match(plain, /function toObject\(item\)/);
        assert.match(plain, /rows\.push\(toObject\(result\.Results\[i\]\)\);/);
        assert.doesNotMatch(plain, /getNextBatch|ContinueRequest/);
        const paged = emitSsjsWsproxy(tree, { output: { paging: true, rowsAsObjects: false } });
        assertValidSsjs(paged.code);
        assert.doesNotMatch(paged.code, /toObject/);
        assert.doesNotMatch(paged.code, /getNextBatch|hasMoreRows/);
        assert.match(paged.code, /var props = \{\};\n/);
        assert.match(
            paged.code,
            /props\.ContinueRequest = result\.RequestID;\n\s+result = api\.retrieve\(objectType, cols, filter, null, props\);/,
        );
        assert.match(paged.code, /rows\.push\(result\.Results\[i\]\);/);
        const pagedAll = emitSsjsWsproxy(ast(FIELDS), { output: { paging: true } });
        assertValidSsjs(pagedAll.code);
        assert.match(pagedAll.code, /api\.retrieve\(objectType, cols, null, null, props\);/);
    });

    it('without paging flags more rows in hasMoreRows with a hint', () => {
        const { code } = emitSsjsWsproxy(ast(`${FIELDS} WHERE Country = 'DE'`));
        assertValidSsjs(code);
        assert.match(code, /var hasMoreRows = false;\n/);
        assert.match(
            code,
            /if \(result\.HasMoreRows\) \{\n {4}\/\/ [^\n]*paging[^\n]*\n {4}hasMoreRows = true;\n\}\n/,
        );
    });

    it('without paging adds FIRST_BATCH_ONLY at the FROM name, with paging not', () => {
        const sql = `${FIELDS} WHERE Country = 'DE'`;
        const single = emitSsjsWsproxy(ast(sql)).messages;
        assert.deepEqual(
            single.map((message) => [message.severity, message.code]),
            [['info', 'FIRST_BATCH_ONLY']],
        );
        assert.match(single[0].message, /first batch of up to 2,500 rows/);
        assert.equal(sql.slice(single[0].column - 1, single[0].endColumn - 1), '[Customers]');
        const paged = emitSsjsWsproxy(ast(sql), { output: { paging: true } }).messages;
        assert.deepEqual(paged, []);
    });

    it('without WHERE and without paging reads back from the null filter', () => {
        const { code } = emitSsjsWsproxy(ast(FIELDS));
        const back = parseSsjs(code);
        assert.equal(back.ast.where, null);
        assert.equal(back.ast.from.name, 'Customers');
    });

    it('drops ORDER BY and TOP with warnings located in the SQL', () => {
        const sql = `SELECT TOP 5 SubscriberKey FROM Customers WHERE Country = 'DE' ORDER BY Points DESC, Email`;
        const result = emitSsjsWsproxy(ast(sql), { sourceText: sql });
        assert.deepEqual(
            result.messages.map((message) => [message.severity, message.code]),
            [
                ['warning', 'TOP_DROPPED'],
                ['warning', 'ORDER_BY_DROPPED'],
                ['info', 'FIRST_BATCH_ONLY'],
            ],
        );
        const [top, order] = result.messages;
        assert.equal(sql.slice(top.column - 1, top.endColumn - 1), 'SELECT TOP 5');
        assert.equal(sql.slice(order.column - 1, order.endColumn - 1), 'Points DESC, Email');
        assert.deepEqual(result.dropped, ['top', 'order-0', 'order-1']);
        assert.ok(result.spans.every((span) => span.clauseId !== 'top'));
    });
});

describe('Rows.Retrieve specifics', () => {
    it('uses DataExtension.Init(key) and keeps columns + name in header comments', () => {
        const { code } = emitSsjsRowsRetrieve(ast(`${FIELDS} WHERE Country = 'DE'`), {
            deKey: 'K1',
        });
        assert.match(
            code,
            /\/\/ SQL: SELECT SubscriberKey, Email\n\/\/ SQL: FROM \[Customers\] \(external key K1\)\n/,
        );
        assert.match(code, /var de = DataExtension\.Init\("K1"\);/);
        assert.match(code, /var rows = de\.Rows\.Retrieve\(filter\);/);
    });

    it('SELECT * has no column comment; no WHERE reads all rows', () => {
        const { code } = emitSsjsRowsRetrieve(ast('SELECT * FROM [My DE]'));
        assert.doesNotMatch(code, /SQL: SELECT/);
        assert.match(code, /de\.Rows\.Retrieve\(\);/);
    });

    it('brackets names in the column comment when needed', () => {
        const { code } = emitSsjsRowsRetrieve(ast('SELECT [First Name], [Order] FROM X'));
        assert.match(code, /\/\/ SQL: SELECT \[First Name\], \[Order\]\n/);
    });
});

describe('Lookup family', () => {
    const sql = `SELECT TOP 10 SubscriberKey, Email FROM [Customers] WHERE Country = 'DE' AND Tier = 'Gold' ORDER BY Points DESC, Email ASC`;
    const tree = ast(sql);

    it('SSJS LookupRows: name, field / value arrays, column comment; drops TOP and ORDER BY', () => {
        const result = emitSsjsLookupRows(tree, { sourceText: sql });
        assertValidSsjs(result.code);
        assert.match(result.code, /\/\/ SQL: SELECT SubscriberKey, Email\n/);
        assert.match(
            result.code,
            /Platform\.Function\.LookupRows\("Customers", \["Country", "Tier"\], \["DE", "Gold"\]\);/,
        );
        assert.deepEqual(
            result.messages.map((message) => message.code),
            ['TOP_DROPPED', 'ORDER_BY_DROPPED'],
        );
    });

    it('SSJS LookupOrderedRows: count from TOP, sort string, nothing dropped', () => {
        const result = emitSsjsLookupOrderedRows(tree, { sourceText: sql });
        assertValidSsjs(result.code);
        assert.match(
            result.code,
            /LookupOrderedRows\("Customers", 10, "Points DESC, Email ASC", \["Country", "Tier"\], \["DE", "Gold"\]\);/,
        );
        assert.deepEqual(result.messages, []);
        assert.deepEqual(result.dropped, []);
        const texts = Object.fromEntries(
            result.spans.map((span) => [span.clauseId, result.code.slice(span.start, span.end)]),
        );
        assert.equal(texts.top, '10');
        assert.equal(texts['order-0'], 'Points DESC');
        assert.equal(texts['order-1'], 'Email ASC');
    });

    it('LookupOrderedRows cannot sort by a column name with spaces', () => {
        const spaced = ast(`SELECT A FROM X WHERE B = '1' ORDER BY [First Name]`);
        assert.match(emitSsjsLookupOrderedRows(spaced).unavailable, /"First Name"/);
        assert.match(emitAmpscriptLookupOrderedRows(spaced).unavailable, /spaces or commas/);
    });

    it('LookupOrderedRows without TOP uses count 0', () => {
        const noTop = ast(`SELECT A FROM X WHERE B = '1' ORDER BY A`);
        assert.match(emitSsjsLookupOrderedRows(noTop).code, /LookupOrderedRows\("X", 0, "A ASC"/);
        assert.match(
            emitAmpscriptLookupOrderedRows(noTop).code,
            /LookupOrderedRows\("X", 0, "A ASC"/,
        );
    });

    it('AMPscript LookupRows: pairs, FOR loop with Field() per column, column comment', () => {
        const result = emitAmpscriptLookupRows(tree, { sourceText: sql });
        assert.equal(
            result.code,
            [
                '%%[',
                '/* SQL: SELECT SubscriberKey, Email */',
                'SET @rows = LookupRows("Customers", "Country", "DE", "Tier", "Gold")',
                'SET @rowCount = RowCount(@rows)',
                'FOR @i = 1 TO @rowCount DO',
                '    SET @row = Row(@rows, @i)',
                '    SET @SubscriberKey = Field(@row, "SubscriberKey")',
                '    SET @Email = Field(@row, "Email")',
                'NEXT @i',
                ']%%',
            ].join('\n'),
        );
        assert.deepEqual(
            result.messages.map((message) => message.code),
            ['TOP_DROPPED', 'ORDER_BY_DROPPED'],
        );
    });

    it('AMPscript LookupRows with * lists the configured columns or a hint', () => {
        const star = ast(`SELECT * FROM X WHERE B = '1'`);
        assert.match(emitAmpscriptLookupRows(star).code, /add one Field\(@row, 'ColumnName'\)/);
        assert.match(
            emitAmpscriptLookupRows(star, { columns: ['Row', 'i', '1st col'] }).code,
            /SET @RowValue = Field\(@row, "Row"\)\n {4}SET @iValue = Field\(@row, "i"\)\n {4}SET @_1st_col = Field\(@row, "1st col"\)/,
        );
    });

    it('AMPscript LookupOrderedRows', () => {
        const result = emitAmpscriptLookupOrderedRows(tree);
        assert.match(
            result.code,
            /SET @rows = LookupOrderedRows\("Customers", 10, "Points DESC, Email ASC", "Country", "DE", "Tier", "Gold"\)/,
        );
    });

    it('AMPscript Lookup: one column, first match info, TOP 1 kept, other TOP dropped', () => {
        const one = ast(`SELECT TOP 1 Email FROM Customers WHERE Country = 'DE' AND Tier = 'G"x'`);
        const result = emitAmpscriptLookup(one);
        assert.equal(
            result.code,
            '%%[\nSET @Email = Lookup("Customers", "Email", "Country", "DE", "Tier", "G""x")\n]%%',
        );
        assert.deepEqual(
            result.messages.map((message) => [message.severity, message.code]),
            [['info', 'LOOKUP_FIRST_ROW_ONLY']],
        );
        assert.ok(result.spans.some((span) => span.clauseId === 'top'));
        const five = emitAmpscriptLookup(ast(`SELECT TOP 5 Email FROM C WHERE A = '1' ORDER BY A`));
        assert.deepEqual(
            five.messages.map((message) => message.code),
            ['TOP_DROPPED', 'ORDER_BY_DROPPED', 'LOOKUP_FIRST_ROW_ONLY'],
        );
    });

    it('AMPscript Lookup needs exactly one column', () => {
        assert.match(emitAmpscriptLookup(tree).unavailable, /single column/);
        const star = ast(`SELECT * FROM C WHERE A = '1'`);
        assert.match(emitAmpscriptLookup(star).unavailable, /single column/);
        assert.match(
            emitAmpscriptLookup(star, { columns: ['Email'] }).code,
            /Lookup\("C", "Email", "A", "1"\)/,
        );
    });

    it('unavailable reasons name the problem and the alternative', () => {
        const cases = [
            ['SELECT A FROM X', /needs at least one condition/],
            [`SELECT A FROM X WHERE B = '1' OR C = '2'`, /uses OR/],
            [`SELECT A FROM X WHERE B > 1`, /uses the operator >/],
            [`SELECT A FROM X WHERE B LIKE 'a%'`, /uses LIKE/],
            [`SELECT A FROM X WHERE B IN ('1')`, /uses IN/],
            [`SELECT A FROM X WHERE B NOT IN ('1')`, /uses NOT IN/],
            [`SELECT A FROM X WHERE B BETWEEN 1 AND 2`, /uses BETWEEN/],
            [`SELECT A FROM X WHERE B IS NULL`, /uses IS NULL/],
            [`SELECT A FROM X WHERE B IS NOT NULL`, /uses IS NOT NULL/],
        ];
        for (const [query, pattern] of cases) {
            const tree2 = ast(`${query} ORDER BY A`);
            for (const emit of [
                emitSsjsLookupRows,
                emitSsjsLookupOrderedRows,
                emitAmpscriptLookupRows,
                emitAmpscriptLookupOrderedRows,
                emitAmpscriptLookup,
            ]) {
                assert.match(emit(tree2).unavailable, pattern, `${emit.name}: ${query}`);
            }
        }
        assert.match(
            emitSsjsLookupRows(ast('SELECT A FROM X')).unavailable,
            /WSProxy or Rows\.Retrieve/,
        );
        assert.match(emitAmpscriptLookupRows(ast('SELECT A FROM X')).unavailable, /SSJS WSProxy/);
        assert.match(
            emitSsjsLookupOrderedRows(ast(`SELECT A FROM X WHERE B = '1'`)).unavailable,
            /ORDER BY/,
        );
    });
});

describe('target registry', () => {
    it('lists the seven Engagement targets in tab order', () => {
        assert.deepEqual(
            MCE_TARGETS.map((target) => [target.id, target.language, target.label]),
            [
                ['ssjs-wsproxy', 'ssjs', 'WSProxy'],
                ['ssjs-rows-retrieve', 'ssjs', 'Rows.Retrieve'],
                ['ssjs-lookuprows', 'ssjs', 'LookupRows'],
                ['ssjs-lookuporderedrows', 'ssjs', 'LookupOrderedRows'],
                ['ampscript-lookuprows', 'ampscript', 'LookupRows'],
                ['ampscript-lookuporderedrows', 'ampscript', 'LookupOrderedRows'],
                ['ampscript-lookup', 'ampscript', 'Lookup'],
            ],
        );
        assert.ok(Object.isFrozen(MCE_TARGETS));
    });
});
