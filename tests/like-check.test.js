import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { convert, parseSql, parseSsjs, printSql } from '../src/index.js';
import { SQL_LIKE_HELPER, emitSsjsRowsRetrieve, emitSsjsWsproxy } from '../src/emit-mce.js';
import { evaluate, likeToRegExp } from './helpers/evaluate.js';

const groundTruth = JSON.parse(
    readFileSync(new URL('fixtures/ground-truth.json', import.meta.url), 'utf8'),
);
const { fixture } = groundTruth;
const TEXT_COLUMNS = ['SubscriberKey', 'Email', 'FirstName', 'Country', 'Tier', 'Zip', 'Notes'];
const PATTERNS = [
    'a%',
    '%a',
    'a',
    'a_b',
    '%[%]%',
    '[a-c]%',
    '%x%',
    '',
    '%',
    '%example.com',
    '%EXAMPLE.COM',
    'gold',
    '[^a-c]%',
    '%[_]%',
    '_____',
    '%.com',
    'a%@%.com',
    '[]%',
];
const SSJS_TARGETS = ['ssjs-wsproxy', 'ssjs-rows-retrieve'];

/**
 * Compiles the emitted helper (tests only; generated code is never run by the library).
 *
 * @returns {(value: unknown, pattern: string) => boolean} sqlLike
 */
function compileHelper() {
    // eslint-disable-next-line no-new-func -- runs the emitted SSJS helper text in a test only
    return new Function(`${SQL_LIKE_HELPER}\nreturn sqlLike;`)();
}

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
 * Formats text as a SQL string literal.
 *
 * @param {string} text text
 * @returns {string} literal
 */
function sqlString(text) {
    return `'${text.replaceAll("'", "''")}'`;
}

/**
 * Rows of the fixture a contains-style `like` filter returns (the live WSProxy / Rows.Retrieve
 * behaviour: the value is always wrapped in %…%). Only single-part filters are simulated.
 *
 * @param {object} filter SimpleFilterPart
 * @returns {object[]} rows
 */
function likeFilterRows(filter) {
    assert.equal(filter.SimpleOperator, 'like', 'simulation supports a single like part');
    const pattern = likeToRegExp(`%${filter.Value}%`);
    return fixture.rows.filter((row) => {
        const value = row[filter.Property];
        return value !== undefined && value !== null && pattern.test(String(value));
    });
}

/**
 * Runs emitted SSJS against stubs (tests only) and returns its variables.
 *
 * @param {string} code emitted code
 * @param {object} stubs `DataExtension` / `Script` stubs
 * @returns {{rows: object[], retrieveError?: string}} result
 */
function runSsjs(code, stubs) {
    const body = code.replace(/^<script runat="server">/, '').replace(/<\/script>$/, '');
    // eslint-disable-next-line no-new-func -- runs generated code against stubs in a test only
    const run = new Function(
        'Platform',
        'DataExtension',
        'Script',
        `${body}\nreturn { rows: rows, retrieveError: typeof retrieveError === 'undefined' ? undefined : retrieveError };`,
    );
    return run(
        {
            /**
             *
             */
            Load() {},
        },
        stubs.DataExtension,
        stubs.Script,
    );
}

/**
 * Builds a WSProxy stub that answers with the given batches.
 *
 * @param {(filter: object) => object[]} batches returns the batches (each a result object)
 * @returns {object} Script stub
 */
function wsproxyStub(batches) {
    let queue = [];
    return {
        Util: {
            /**
             * WSProxy stub.
             */
            WSProxy: class {
                /**
                 * First batch, or the next one when `props.ContinueRequest` is set.
                 *
                 * @param {string} type object type
                 * @param {string[]} cols columns
                 * @param {object} filter filter
                 * @param {object} [options] retrieve options (unused)
                 * @param {object} [props] retrieve properties
                 * @returns {object} result
                 */
                retrieve(type, cols, filter, options, props) {
                    if (props?.ContinueRequest) {
                        return queue.shift();
                    }
                    queue = batches(filter, cols);
                    return queue.shift();
                }
            },
        },
    };
}

/**
 * Turns a fixture row into a WSProxy result item with the requested columns.
 *
 * @param {object} row fixture row
 * @param {string[]} cols columns
 * @returns {object} item
 */
function toItem(row, cols) {
    return { Properties: cols.map((name) => ({ Name: name, Value: row[name] ?? '' })) };
}

/**
 * Rows the SQL evaluator returns for `Column LIKE 'pattern'`.
 *
 * @param {string} column column
 * @param {string} pattern LIKE pattern
 * @returns {Set.<object>} fixture rows
 */
function sqlLikeRows(column, pattern) {
    const tree = ast(`SELECT SubscriberKey FROM X WHERE ${column} LIKE ${sqlString(pattern)}`);
    return new Set(evaluate(tree, fixture));
}

/**
 * Reads the like filter Value WSProxy code sends for a pattern.
 *
 * @param {string} pattern LIKE pattern
 * @returns {string} Value literal
 */
function likeValueOf(pattern) {
    const { code } = emitSsjsWsproxy(ast(`SELECT A FROM X WHERE B LIKE ${sqlString(pattern)}`));
    return /SimpleOperator: "like",\n\s+Value: (".*")/.exec(code)[1];
}

/**
 * Builds a WSProxy like filter object as code.
 *
 * @param {string} value filter value
 * @returns {string} code
 */
function emailLikeFilter(value) {
    return `{ Property: "Email", SimpleOperator: "like", Value: "${value}" }`;
}

/**
 * A successful first batch with more rows to come.
 *
 * @param {string[]} cols columns
 * @returns {object} result
 */
function firstBatch(cols) {
    return {
        Status: 'MoreDataAvailable',
        HasMoreRows: true,
        RequestID: 'r1',
        Results: [toItem(fixture.rows[0], cols)],
    };
}

/**
 * Sorts keys by text.
 *
 * @param {string[]} keys keys
 * @returns {string[]} sorted copy
 */
function sorted(keys) {
    return keys.toSorted((left, right) => left.localeCompare(right));
}

const SINGLE_LIKE_VARIATIONS = groundTruth.variations.filter((item) =>
    /WHERE \w+ LIKE '[^']*'$/.test(item.sql),
);

describe('sqlLike helper (emitted SSJS) matches the SQL evaluator', () => {
    const sqlLike = compileHelper();

    it('is ES3-style code: var only, no arrow functions, no regex literals', () => {
        assert.doesNotMatch(SQL_LIKE_HELPER, /\b(?:let|const)\b|=>|\(\?<|`/);
        assert.doesNotMatch(SQL_LIKE_HELPER, /[(=,]\s*\/[^/*]/, 'no regex literal');
        assert.match(SQL_LIKE_HELPER, /^function sqlLike\(value, pattern\) \{\n/);
    });

    for (const pattern of PATTERNS) {
        it(`pattern ${sqlString(pattern)} on every fixture row and text column`, () => {
            for (const column of TEXT_COLUMNS) {
                const expected = sqlLikeRows(column, pattern);
                for (const row of fixture.rows) {
                    assert.equal(
                        sqlLike(row[column], pattern),
                        expected.has(row),
                        `${column} = ${JSON.stringify(row[column])}`,
                    );
                }
            }
        });
    }

    it('NULL never matches; trailing spaces of the value are ignored; case is ignored', () => {
        assert.equal(sqlLike(null, '%'), false);
        assert.equal(sqlLike(undefined, '%'), false);
        assert.equal(sqlLike('Gold  ', 'gold'), true);
        assert.equal(sqlLike('Gold', 'gold '), false);
        assert.equal(sqlLike('a(b)$', 'A(B)$'), true);
        assert.equal(sqlLike('a\nb', 'a%b'), true);
        assert.equal(sqlLike(5, '5'), true);
    });
});

describe('anchored LIKE: wider like filter plus exact check', () => {
    const likeVariations = groundTruth.variations.filter((variation) =>
        / LIKE /.test(variation.sql),
    );

    for (const variation of likeVariations) {
        for (const id of SSJS_TARGETS) {
            it(`${variation.id} ${id}: round trip returns the original SQL`, () => {
                const result = convert(variation.sql, { deKey: 'SqlConvFixture' });
                const output = result.outputs.find((item) => item.id === id);
                assert.equal(output.unavailable, undefined, output.unavailable);
                assert.equal(output.roundTrip.ok, true, output.roundTrip.note);
                const pattern = /LIKE '([^']*)'/.exec(variation.sql)[1];
                const isContains = /^%[^%].*[^%]%$|^%[^%]%$/.test(pattern);
                assert.equal(output.code.includes('sqlLike('), !isContains);
                assert.equal(
                    output.messages.some((message) => message.code === 'LIKE_CHECKED_IN_SCRIPT'),
                    !isContains,
                );
            });
        }
    }

    for (const pattern of PATTERNS) {
        const sql = `SELECT SubscriberKey, Email FROM [X] WHERE Notes LIKE ${sqlString(pattern)} AND Country = 'DE'`;
        for (const id of SSJS_TARGETS) {
            it(`${id}: ${sqlString(pattern)} round trip`, () => {
                const output = convert(sql, { deKey: 'X' }).outputs.find((item) => item.id === id);
                assert.equal(output.roundTrip.ok, true, output.roundTrip.note);
                assert.equal(output.roundTrip.sql, printSql(ast(sql)));
            });
        }
        for (const options of [{ paging: true }, { rowsAsObjects: false }]) {
            it(`ssjs-wsproxy ${JSON.stringify(options)}: ${sqlString(pattern)} round trip`, () => {
                const output = convert(sql, { deKey: 'X', output: options }).outputs[0];
                assert.equal(output.roundTrip.ok, true, output.roundTrip.note);
            });
        }
    }

    it('sends the pattern without leading/trailing % as the filter value (% when empty)', () => {
        const value = likeValueOf;
        assert.equal(value('a%'), '"a"');
        assert.equal(value('%a'), '"a"');
        assert.equal(value('a_b'), '"a_b"');
        assert.equal(value('[a-c]%'), '"[a-c]"');
        assert.equal(value('%%a%%'), '"a"');
        assert.equal(value(''), '"%"');
        assert.equal(value('%x%'), '"%x%"');
        assert.equal(value('%[%]%'), '"%[%]%"');
    });

    it('a %x% pattern stays a plain filter without helper', () => {
        const { code, messages } = emitSsjsWsproxy(ast("SELECT A FROM X WHERE B LIKE '%x%'"), {
            output: { paging: true },
        });
        assert.doesNotMatch(code, /sqlLike/);
        assert.deepEqual(messages, []);
    });

    it('emits the helper once for several checks and marks each pattern', () => {
        const sql = "SELECT A FROM X WHERE B LIKE 'a%' AND C LIKE '%z' AND D = '1'";
        const result = emitSsjsRowsRetrieve(ast(sql), { sourceText: sql });
        assert.equal(result.code.match(/function sqlLike/g).length, 1);
        assert.match(
            result.code,
            /if \(sqlLike\(row\["B"\], "a%"\) && sqlLike\(row\["C"\], "%z"\)\)/,
        );
        const texts = result.spans.map((span) => result.code.slice(span.start, span.end));
        assert.ok(texts.includes('"a%"'));
        assert.ok(texts.includes('"%z"'));
        assert.match(
            result.code,
            /var rows = \[\];\nfor \(var i = 0; i < retrieved.length; i\+\+\)/,
        );
    });

    it('WSProxy reads the LIKE column too and keeps the SELECT list in the header', () => {
        const sql = "SELECT SubscriberKey FROM [X] WHERE Email LIKE 'a%' AND Country = 'DE'";
        const { code } = emitSsjsWsproxy(ast(sql), { deKey: 'X' });
        assert.match(code, /\/\/ SQL: SELECT SubscriberKey\n/);
        assert.match(code, /var cols = \["SubscriberKey", "Email"\];/);
        const back = parseSsjs(code);
        assert.deepEqual(
            back.ast.columns.map((column) => column.name),
            ['SubscriberKey'],
        );
        assert.equal(printSql(back.ast), printSql(ast(sql)));
    });

    it('WSProxy with a selected LIKE column adds no header', () => {
        const { code } = emitSsjsWsproxy(ast("SELECT email FROM X WHERE Email LIKE 'a%'"));
        assert.doesNotMatch(code, /SQL: SELECT/);
        assert.match(code, /var cols = \["email"\];/);
    });

    it('SELECT * with known columns keeps * in the header when a column is added', () => {
        const { code } = emitSsjsWsproxy(ast("SELECT * FROM X WHERE Email LIKE 'a%'"), {
            columns: ['A'],
        });
        assert.match(code, /\/\/ SQL: SELECT \*\n/);
        assert.match(code, /var cols = \["A", "Email"\];/);
        assert.equal(parseSsjs(code).ast.columns, '*');
    });

    for (const variation of SINGLE_LIKE_VARIATIONS) {
        it(`${variation.id}: running the generated code (contains-like stubs) gives the SQL rows`, () => {
            const tree = ast(variation.sql);
            const expected = sorted(variation.expected);
            const rowsRetrieve = runSsjs(emitSsjsRowsRetrieve(tree).code, {
                DataExtension: { Init: () => ({ Rows: { Retrieve: likeFilterRows } }) },
            });
            assert.deepEqual(sorted(rowsRetrieve.rows.map((row) => row.SubscriberKey)), expected);
            for (const output of [{}, { paging: true }, { rowsAsObjects: false }]) {
                const ws = runSsjs(emitSsjsWsproxy(tree, { output }).code, {
                    Script: wsproxyStub((filter, cols) => [
                        {
                            Status: 'OK',
                            HasMoreRows: false,
                            Results: likeFilterRows(filter).map((row) => toItem(row, cols)),
                        },
                    ]),
                });
                const keys = ws.rows.map((row) =>
                    output.rowsAsObjects === false ? row.Properties[0].Value : row.SubscriberKey,
                );
                assert.deepEqual(sorted(keys), expected, JSON.stringify(output));
                assert.equal(ws.retrieveError, '');
            }
        });
    }
});

describe('anchored LIKE inside OR is unavailable', () => {
    for (const where of [
        "Email LIKE 'a%' OR Country = 'DE'",
        "Country = 'DE' AND (Notes LIKE 'a_b' OR Tier = 'Gold')",
        "(Email LIKE '%.com' AND Tier = 'Gold') OR Country = 'US'",
    ]) {
        it(where, () => {
            const result = convert(`SELECT A FROM X WHERE ${where}`, { deKey: 'X' });
            for (const id of SSJS_TARGETS) {
                const output = result.outputs.find((item) => item.id === id);
                assert.match(output.unavailable, /LIKE inside OR can't be checked exactly/);
                assert.match(output.unavailable, /like filter always matches "contains"/);
            }
        });
    }

    it('a %x% pattern inside OR stays available', () => {
        const result = convert("SELECT A FROM X WHERE Email LIKE '%a%' OR Country = 'DE'", {
            deKey: 'X',
        });
        for (const id of SSJS_TARGETS) {
            const output = result.outputs.find((item) => item.id === id);
            assert.equal(output.unavailable, undefined);
            assert.equal(output.roundTrip.ok, true);
        }
    });
});

describe('parseSsjs reads sqlLike checks', () => {
    const filter = emailLikeFilter;

    it('replaces the matching like value with the exact pattern', () => {
        const code = `var r = p.retrieve("DataExtensionObject[K]", ["Email"], ${filter('a')});\nif (sqlLike(row["email"], "a%")) { rows.push(row); }`;
        assert.equal(
            printSql(parseSsjs(code).ast),
            printSql(ast("SELECT Email FROM K WHERE Email LIKE 'a%'")),
        );
    });

    it('ignores a check whose pattern does not fit the filter value', () => {
        const code = `var r = p.retrieve("DataExtensionObject[K]", ["Email"], ${filter('a')});\nif (sqlLike(row["Email"], "b%")) { rows.push(row); }`;
        assert.equal(parseSsjs(code).ast.where.pattern.value, '%a%');
    });

    it('a like filter without a check matches anywhere: LIKE %value% with an info', () => {
        const cases = [
            ['a', '%a%'],
            ['a%', '%a%'],
            ['%a', '%a%'],
            ['%%a_b%%', '%a_b%'],
            ['%', '%'],
            ['%%', '%'],
        ];
        for (const [value, pattern] of cases) {
            const result = parseSsjs(
                `var r = p.retrieve("DataExtensionObject[K]", ["Email"], ${filter(value)});`,
            );
            assert.equal(result.ast.where.pattern.value, pattern, value);
            const infos = result.messages.filter(
                (message) => message.code === 'LIKE_MATCHES_ANYWHERE',
            );
            assert.equal(infos.length, value === pattern ? 0 : 1, value);
            if (infos.length) {
                assert.equal(infos[0].severity, 'info');
                assert.match(infos[0].message, /anywhere/);
            }
        }
        const rows = parseSsjs(`var rows = DataExtension.Init("K").Rows.Retrieve(${filter('x')});`);
        assert.equal(printSql(rows.ast), "SELECT *\nFROM K\nWHERE Email LIKE '%x%'");
        const contains = parseSsjs(
            `var r = p.retrieve("DataExtensionObject[K]", ["Email"], ${filter('%x%')});`,
        );
        assert.equal(contains.ast.where.pattern.value, '%x%');
        assert.ok(contains.messages.every((message) => message.code !== 'LIKE_MATCHES_ANYWHERE'));
    });

    it('the SELECT header wins over the WSProxy cols array', () => {
        const code = `// SQL: SELECT A\nvar r = p.retrieve("DataExtensionObject[K]", ["A", "B"]);`;
        assert.deepEqual(
            parseSsjs(code).ast.columns.map((column) => column.name),
            ['A'],
        );
    });
});

describe('empty string values are sent as a single space', () => {
    for (const where of [
        "Notes = ''",
        "Notes <> ''",
        "Notes IN ('', 'vip')",
        "Notes NOT IN ('', 'vip')",
        "Notes NOT IN ('')",
    ]) {
        it(where, () => {
            const sql = `SELECT SubscriberKey FROM [X] WHERE ${where}`;
            const result = convert(sql, { deKey: 'X' });
            for (const id of SSJS_TARGETS) {
                const output = result.outputs.find((item) => item.id === id);
                assert.doesNotMatch(output.code, /Value: ""/);
                assert.match(output.code, /" "/);
                assert.ok(
                    output.messages.some((message) => message.code === 'EMPTY_STRING_AS_SPACE'),
                );
                assert.equal(output.roundTrip.ok, true, output.roundTrip.note);
            }
        });
    }

    it('reads a Value of exactly " " back as empty text', () => {
        const back = parseSsjs(
            'var r = p.retrieve("DataExtensionObject[K]", ["A"], { Property: "A", SimpleOperator: "equals", Value: " " });',
        );
        assert.equal(printSql(back.ast), printSql(ast("SELECT A FROM K WHERE A = ''")));
    });

    it('IS NULL keeps its empty Value and no message', () => {
        const { code, messages } = emitSsjsWsproxy(ast('SELECT A FROM X WHERE A IS NULL'), {
            output: { paging: true },
        });
        assert.match(code, /Value: ""/);
        assert.deepEqual(messages, []);
    });
});

describe('WSProxy status check', () => {
    const sql = "SELECT SubscriberKey FROM X WHERE Country = 'DE'";
    const error = 'Error: Invalid argument for the equals operator.';
    const ok = firstBatch;

    it('keeps rows empty and the status in retrieveError when the retrieve fails', () => {
        const ws = runSsjs(emitSsjsWsproxy(ast(sql)).code, {
            Script: wsproxyStub(() => [{ Status: error, Results: [] }]),
        });
        assert.deepEqual(ws.rows, []);
        assert.equal(ws.retrieveError, error);
    });

    it('paging: a failing later batch empties rows', () => {
        const ws = runSsjs(emitSsjsWsproxy(ast(sql), { output: { paging: true } }).code, {
            Script: wsproxyStub((filter, cols) => [ok(cols), { Status: error, Results: [] }]),
        });
        assert.deepEqual(ws.rows, []);
        assert.equal(ws.retrieveError, error);
    });

    it('paging: reads every batch when all succeed', () => {
        const ws = runSsjs(emitSsjsWsproxy(ast(sql), { output: { paging: true } }).code, {
            Script: wsproxyStub((filter, cols) => [
                ok(cols),
                { Status: 'OK', HasMoreRows: false, Results: [toItem(fixture.rows[3], cols)] },
            ]),
        });
        assert.deepEqual(
            ws.rows.map((row) => row.SubscriberKey),
            ['R01', 'R04'],
        );
        assert.equal(ws.retrieveError, '');
    });
});
