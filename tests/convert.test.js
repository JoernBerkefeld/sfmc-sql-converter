import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MCE_TARGETS, MCN_TARGETS, MESSAGE_CODES, convert, parseSql } from '../src/index.js';
import { evaluate, likeToRegExp } from './helpers/evaluate.js';

const groundTruth = JSON.parse(
    readFileSync(new URL('fixtures/ground-truth.json', import.meta.url), 'utf8'),
);

const MCE_IDS = MCE_TARGETS.map((target) => target.id);

describe('convert() contract — toCode, Engagement', () => {
    const sql = `SELECT TOP 5 SubscriberKey, Email FROM [Customers] WHERE Country = 'DE' AND Tier = 'Gold' ORDER BY Points DESC`;
    const result = convert(sql, { platform: 'mce', direction: 'toCode', deKey: 'CUST' });

    it('returns one output per Engagement target, in order', () => {
        assert.deepEqual(
            result.outputs.map((output) => output.id),
            MCE_IDS,
        );
        for (const output of result.outputs) {
            assert.ok(['ssjs', 'ampscript'].includes(output.language));
            assert.equal(typeof output.label, 'string');
            assert.ok(Array.isArray(output.spans));
            assert.ok(
                (typeof output.code === 'string') !== (typeof output.unavailable === 'string'),
                'either code or unavailable',
            );
        }
        const lookup = result.outputs.find((output) => output.id === 'ampscript-lookup');
        assert.match(lookup.unavailable, /single column/);
    });

    it('defaults to platform mce and direction toCode', () => {
        assert.deepEqual(convert(sql, { deKey: 'CUST' }), result);
    });

    it('keeps target messages on the output and parse messages on top', () => {
        assert.deepEqual(result.messages, []);
        const wsproxy = result.outputs[0];
        assert.deepEqual(wsproxy.messages, []);
        assert.deepEqual(wsproxy.dropped, []);
        const ordered = result.outputs.find((output) => output.id === 'ssjs-lookuporderedrows');
        assert.deepEqual(ordered.messages, []);
    });

    it('builds a clause map per available output', () => {
        const forWsproxy = result.clauseMap.filter((entry) => entry.outputId === 'ssjs-wsproxy');
        assert.deepEqual(
            forWsproxy.map((entry) => [entry.clauseId, entry.sql, entry.dropped]),
            [
                ['top', 'SELECT TOP 5', false],
                ['column-0', 'SubscriberKey', false],
                ['column-1', 'Email', false],
                ['from', '[Customers]', false],
                ['where-0', "Country = 'DE'", false],
                ['where-1', "Tier = 'Gold'", false],
                ['order-0', 'Points DESC', false],
            ],
        );
        assert.equal(forWsproxy.find((entry) => entry.clauseId === 'top').code, '5');
        assert.equal(
            forWsproxy.find((entry) => entry.clauseId === 'order-0').code,
            '["Points", "DESC"]',
        );
        const where0 = forWsproxy.find((entry) => entry.clauseId === 'where-0');
        assert.match(where0.code, /Property: "Country"/);
        assert.equal(where0.loc.line, 1);
        assert.equal(sql.slice(where0.loc.start, where0.loc.end), "Country = 'DE'");
        const ordered = result.clauseMap.filter(
            (entry) => entry.outputId === 'ssjs-lookuporderedrows',
        );
        assert.equal(ordered.find((entry) => entry.clauseId === 'top').code, '5');
        assert.ok(result.clauseMap.every((entry) => entry.outputId !== 'ampscript-lookup'));
        for (const entry of result.clauseMap) {
            assert.deepEqual(
                Object.keys(entry).toSorted((x, y) => x.localeCompare(y)),
                ['clauseId', 'code', 'dropped', 'loc', 'outputId', 'sql'],
            );
        }
    });

    it('adds DE_KEY_ASSUMED when no external key is given', () => {
        const withoutKey = convert('SELECT A FROM [My DE]');
        assert.deepEqual(
            withoutKey.messages.map((message) => [message.severity, message.code]),
            [['info', MESSAGE_CODES.DE_KEY_ASSUMED]],
        );
        assert.equal(withoutKey.messages[0].column, 15);
        assert.equal(withoutKey.messages[0].endColumn, 22);
    });

    it('passes columns / schema / output options to the emitters', () => {
        const star = convert("SELECT * FROM X WHERE A = '1'", {
            deKey: 'X',
            columns: ['A', 'B'],
            output: { rowsAsObjects: false },
        });
        assert.match(star.outputs[0].code, /var cols = \["A", "B"\];/);
        assert.doesNotMatch(star.outputs[0].code, /toObject/);
        const schema = convert('SELECT * FROM X', { schema: { fields: [{ name: 'Z' }] } });
        assert.match(schema.outputs[0].code, /var cols = \["Z"\];/);
        const bare = convert('SELECT  * FROM X', { deKey: 'X' });
        assert.match(bare.outputs[0].unavailable, /list of columns/);
        const [warning] = bare.messages;
        assert.equal(warning.code, MESSAGE_CODES.SELECT_STAR_NEEDS_COLUMNS);
        assert.deepEqual([warning.column, warning.endColumn], [9, 10]);
    });

    it('returns every output unavailable when the query has errors', () => {
        const broken = convert('SELECT A FROM X WHERE');
        assert.equal(broken.messages[0].severity, 'error');
        assert.ok(
            broken.outputs.every(
                (output) => output.unavailable === 'Fix the errors in the query first.',
            ),
        );
        assert.deepEqual(broken.clauseMap, []);
        assert.equal(broken.roundTrip.ok, false);
    });

    it('rejects unknown platform / direction', () => {
        assert.throws(() => convert('SELECT A FROM X', { platform: 'xyz' }), TypeError);
        assert.throws(() => convert('SELECT A FROM X', { direction: 'sideways' }), TypeError);
    });
});

describe('convert() — Next basics', () => {
    it('toCode returns the targets of the chosen data source (CRM by default)', () => {
        const crm = convert("SELECT A FROM X WHERE B = '1'", { platform: 'mcn' });
        assert.deepEqual(
            crm.outputs.map((output) => [output.id, output.language]),
            MCN_TARGETS.filter((target) => target.dataSource === 'CRM').map((target) => [
                target.id,
                target.language,
            ]),
        );
        const mo = convert("SELECT A FROM X WHERE B = '1'", { platform: 'mcn', dataSource: 'MO' });
        assert.deepEqual(
            mo.outputs.map((output) => output.id),
            ['handlebars-query-mo', 'ampscript-lookuprows-mo'],
        );
        const dg = convert('SELECT A FROM X__dlm', { platform: 'mcn', dataSource: 'DG' });
        assert.deepEqual(
            dg.outputs.map((output) => output.id),
            ['handlebars-datagraph'],
        );
    });

    it('rejects an unknown data source', () => {
        assert.throws(
            () => convert('SELECT A FROM X', { platform: 'mcn', dataSource: 'DMO' }),
            TypeError,
        );
    });

    it('still reports parse errors and returns every output unavailable', () => {
        const result = convert('SELECT FROM', { platform: 'mcn' });
        assert.equal(result.messages[0].severity, 'error');
        assert.ok(result.outputs.every((output) => output.unavailable));
    });

    it('toSql on Next adds no Query Activity note for sortBy without limit', () => {
        const result = convert(
            '{{#each (query type="CRM" object="Contact" fields="LastName" sortBy="LastName ASC")}}{{LastName}}{{/each}}',
            { platform: 'mcn', direction: 'toSql' },
        );
        assert.match(result.outputs[0].code, /ORDER BY LastName ASC/);
        assert.ok(
            result.messages.every((message) => message.code !== MESSAGE_CODES.ORDER_BY_NEEDS_TOP),
        );
    });

    it('toSql reports code it cannot read', () => {
        const result = convert('var x = 1;', { platform: 'mcn', direction: 'toSql' });
        assert.equal(result.outputs[0].id, 'sql');
        assert.ok(result.outputs[0].unavailable);
        assert.equal(result.messages[0].code, MESSAGE_CODES.NO_LOOKUP_FOUND);
    });
});

describe('convert() round trip (SQL → code → SQL)', () => {
    const options = { deKey: 'SqlConvFixture_Key', columns: ['SubscriberKey', 'Email'] };
    const queries = [
        ...groundTruth.variations.map((variation) => variation.sql),
        "SELECT TOP 3 SubscriberKey, [First Name] FROM [My DE] WHERE Country = 'DE' AND [First Name] = 'O''Neil' ORDER BY [First Name] DESC, Points",
        "SELECT * FROM [SqlConvFixture] WHERE Country = 'DE' ORDER BY Points",
        'SELECT TOP 1 Email FROM SqlConvFixture WHERE SubscriberKey = 42',
        'SELECT SubscriberKey FROM SqlConvFixture',
    ];
    for (const sql of queries) {
        it(sql, () => {
            const result = convert(sql, options);
            for (const output of result.outputs) {
                if (output.unavailable) {
                    continue;
                }
                assert.equal(
                    output.roundTrip.ok,
                    true,
                    `${output.id}: ${output.roundTrip.note}\n${output.code}\n→ ${output.roundTrip.sql}`,
                );
                const isDropsSomething = output.dropped.length > 0;
                assert.equal(Boolean(output.roundTrip.note), isDropsSomething, output.id);
            }
            assert.equal(result.roundTrip.ok, true);
        });
    }

    it('NOT IN survives as NOT IN through WSProxy and Rows.Retrieve', () => {
        const result = convert("SELECT A FROM X WHERE B NOT IN ('1', 'x') AND C = 'y'", {
            deKey: 'X',
        });
        for (const output of result.outputs.slice(0, 2)) {
            assert.match(output.code, /\/\/ SQL: NOT IN\n/);
            assert.match(output.roundTrip.sql, /B NOT IN \(1, 'x'\)/, output.id);
        }
    });

    it('the status note names the dropped clauses (AMPscript LookupRows)', () => {
        const result = convert("SELECT TOP 2 A FROM X WHERE B = 'c' ORDER BY A", { deKey: 'X' });
        const lookupRows = result.outputs.find((output) => output.id === 'ampscript-lookuprows');
        assert.equal(
            lookupRows.roundTrip.note,
            'Same query without TOP and ORDER BY, which LookupRows leaves out.',
        );
    });

    it('SSJS outputs keep TOP and ORDER BY through the round trip', () => {
        const result = convert("SELECT TOP 2 A FROM X WHERE B = 'c' ORDER BY A DESC, C", {
            deKey: 'X',
        });
        for (const id of ['ssjs-wsproxy', 'ssjs-rows-retrieve', 'ssjs-lookuprows']) {
            const output = result.outputs.find((item) => item.id === id);
            assert.deepEqual(output.dropped, [], id);
            assert.equal(output.roundTrip.ok, true, id);
            assert.match(output.roundTrip.sql, /SELECT TOP 2 A/, id);
            assert.match(output.roundTrip.sql, /ORDER BY A DESC, C ASC/, id);
            assert.ok(
                output.messages.every(
                    (message) => !['TOP_DROPPED', 'ORDER_BY_DROPPED'].includes(message.code),
                ),
                id,
            );
        }
    });

    it('SSJS: ORDER BY without TOP and TOP without ORDER BY', () => {
        const sorted = convert("SELECT A FROM X WHERE B = 'c' ORDER BY A", { deKey: 'X' });
        const cut = convert("SELECT TOP 3 A FROM X WHERE B = 'c'", { deKey: 'X' });
        for (const id of ['ssjs-wsproxy', 'ssjs-rows-retrieve', 'ssjs-lookuprows']) {
            const sortedOut = sorted.outputs.find((item) => item.id === id);
            assert.match(sortedOut.code, /rows = orderRows\(rows, \[\["A", "ASC"\]\], 0\);/, id);
            assert.equal(sortedOut.roundTrip.ok, true, id);
            const cutOut = cut.outputs.find((item) => item.id === id);
            assert.match(cutOut.code, /rows = orderRows\(rows, \[\], 3\);/, id);
            assert.equal(cutOut.roundTrip.ok, true, id);
        }
    });

    it('SSJS: no orderRows helper without ORDER BY and TOP', () => {
        const result = convert("SELECT A FROM X WHERE B = 'c'", { deKey: 'X' });
        for (const output of result.outputs) {
            if (output.code) {
                assert.doesNotMatch(output.code, /orderRows/, output.id);
            }
        }
    });
});

describe('convert() toSql', () => {
    it('reads generated code of every target back to the SQL', () => {
        const sql =
            "SELECT Email FROM [Customers] WHERE Country = 'DE' AND Tier = 'Gold' ORDER BY Points DESC";
        const generated = convert(sql, { deKey: 'CUST' });
        assert.ok(generated.outputs.every((item) => item.code));
        for (const output of generated.outputs) {
            const back = convert(output.code, { direction: 'toSql' });
            assert.equal(back.outputs.length, 1);
            const [sqlOutput] = back.outputs;
            assert.equal(sqlOutput.id, 'sql');
            assert.equal(sqlOutput.language, 'sql');
            assert.match(
                sqlOutput.code,
                /^SELECT Email\nFROM Customers\nWHERE Country = 'DE' AND Tier = 'Gold'/,
                output.id,
            );
            assert.equal(back.roundTrip.ok, true);
            assert.equal(back.roundTrip.sql, sqlOutput.code);
            const where0 = back.clauseMap.find((entry) => entry.clauseId === 'where-0');
            assert.equal(where0.sql, "Country = 'DE'");
            assert.ok(where0.code.includes('Country'), `${output.id}: ${where0.code}`);
            for (const span of sqlOutput.spans) {
                assert.ok(span.end <= sqlOutput.code.length);
            }
        }
    });

    it('uses options.deName when the code carries only the key', () => {
        const code = `var api = new Script.Util.WSProxy();\nvar r = api.retrieve("DataExtensionObject[CUST-1]", ["A"], { Property: "B", SimpleOperator: "equals", Value: "x" });`;
        const back = convert(code, { direction: 'toSql', deName: 'Customers' });
        assert.match(back.outputs[0].code, /^SELECT A\nFROM Customers\nWHERE B = 'x'$/);
    });

    it('returns the parser errors when the code cannot be read', () => {
        const back = convert('hello world', { direction: 'toSql' });
        assert.equal(back.outputs[0].unavailable, 'Fix the errors in the code first.');
        assert.ok(back.messages.some((message) => message.severity === 'error'));
        assert.equal(back.roundTrip.ok, false);
    });
});

describe('ground truth (real SFMC query-activity results)', () => {
    it('has 40 variations with expected row sets', () => {
        assert.equal(groundTruth.variations.length, 40);
        assert.equal(groundTruth.fixture.rows.length, 10);
    });

    for (const variation of groundTruth.variations) {
        it(`${variation.id}: ${variation.sql.replace(/^.*WHERE /, 'WHERE ')}`, () => {
            const { ast, messages } = parseSql(variation.sql);
            assert.ok(ast, JSON.stringify(messages));
            const keys = evaluate(ast, groundTruth.fixture)
                .map((row) => row.SubscriberKey)
                .toSorted((x, y) => x.localeCompare(y));
            assert.deepEqual(
                keys,
                variation.expected.toSorted((x, y) => x.localeCompare(y)),
            );
        });
    }

    it('LIKE translation: wildcards, sets and escapes', () => {
        assert.ok(likeToRegExp('a_b').test('AxB'));
        assert.ok(!likeToRegExp('a_b').test('ab'));
        assert.ok(likeToRegExp('%[%]%').test('50%_off'));
        assert.ok(!likeToRegExp('%[%]%').test('50 off'));
        assert.ok(likeToRegExp('[a-c]x').test('bx'));
        assert.ok(!likeToRegExp('[^a-c]x').test('bx'));
        assert.ok(likeToRegExp('%.com').test('x.COM'));
        assert.ok(!likeToRegExp('%.com').test('xxcom'));
    });
});

/**
 * SSJS LookupOrderedRows code with the given row count (0 = every row).
 *
 * @param {number} count rows to read
 * @returns {string} code
 */
function sorted(count) {
    return `<script runat="server">\nvar rows = Platform.Function.LookupOrderedRows("SqlConvFixture", ${count}, "Points ASC", ["Country"], ["DE"]);\n</script>`;
}

describe('convert() toSql: ORDER BY without TOP (query activity, DB mce:sql.query-activity.where-semantics)', () => {
    it('adds an info message when the printed SQL sorts every row', () => {
        const result = convert(sorted(0), { direction: 'toSql' });
        assert.match(result.outputs[0].code, /ORDER BY Points ASC/);
        assert.doesNotMatch(result.outputs[0].code, /TOP/);
        const note = result.messages.find(
            (message) => message.code === MESSAGE_CODES.ORDER_BY_NEEDS_TOP,
        );
        assert.equal(note?.severity, 'info');
        assert.equal(result.roundTrip.ok, true);
    });

    it('adds nothing when the code limits the rows (TOP)', () => {
        const result = convert(sorted(5), { direction: 'toSql' });
        assert.match(result.outputs[0].code, /TOP 5/);
        assert.deepEqual(result.messages, []);
    });

    it('adds nothing without ORDER BY', () => {
        const result = convert(
            '<script runat="server">\nvar rows = Platform.Function.LookupRows("SqlConvFixture", "Country", "DE");\n</script>',
            { direction: 'toSql' },
        );
        assert.ok(
            result.messages.every((message) => message.code !== MESSAGE_CODES.ORDER_BY_NEEDS_TOP),
        );
    });
});
