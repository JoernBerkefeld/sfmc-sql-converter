import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    MESSAGE_CODES,
    ampVariableNames,
    convert,
    emitAmpscriptLookupRows,
    emitSsjsWsproxy,
    parseAmpscript,
    parseSql,
    parseSsjs,
} from '../src/index.js';
import { SQL_LIKE_HELPER, commentText } from '../src/emit-mce.js';
import { decodeCommentText, findAmpscriptRegions } from '../src/reverse-common.js';

// the six characters backslash, u, 0, 0, 5, C
const U005C = ['\\', 'u005C'].join('');
const LOOKUP_FAMILY = [
    'ssjs-lookuprows',
    'ssjs-lookuporderedrows',
    'ampscript-lookuprows',
    'ampscript-lookuporderedrows',
];

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
 * Quotes text as a SQL string literal.
 *
 * @param {string} text text
 * @returns {string} literal
 */
function sqlString(text) {
    return `'${text.replaceAll("'", "''")}'`;
}

/**
 * Syntax-checks emitted SSJS (never runs it).
 *
 * @param {string} code emitted SSJS
 */
function assertValidSsjs(code) {
    const body = code.replace(/^<script runat="server">/, '').replace(/<\/script>$/, '');
    // eslint-disable-next-line no-new-func -- syntax check only; the function is never called
    assert.doesNotThrow(() => new Function(body), `invalid SSJS:\n${code}`);
}

/**
 * Asserts that every available output reads back as the same query.
 *
 * @param {object} result convert() result
 */
function assertRoundTrips(result) {
    for (const output of result.outputs) {
        if (output.code) {
            assert.equal(
                output.roundTrip.ok,
                true,
                `${output.id}: ${output.roundTrip.note}\n${output.code}\n→ ${output.roundTrip.sql}`,
            );
        }
    }
}

describe('no escaped backslash in emitted SSJS string literals', () => {
    const texts = [
        '\\',
        'a\\',
        String.raw`\\`,
        String.raw`x\"`,
        String.raw`a\b`,
        String.raw`'\'`,
        String.raw`end\\`,
        'q"\\',
    ];
    const queries = [];
    for (const text of texts) {
        queries.push(
            `SELECT A FROM [D] WHERE B = ${sqlString(text)}`,
            `SELECT A FROM [D] WHERE B IN (${sqlString(text)}, 'x') ORDER BY A`,
            `SELECT A FROM [D] WHERE B NOT IN (${sqlString(text)}, 'y')`,
            `SELECT [C${text.replaceAll(']', ']]')}] FROM [D${text.replaceAll(']', ']]')}] WHERE [W${text.replaceAll(']', ']]')}] = 'v' ORDER BY A`,
            `SELECT A FROM [D] WHERE B LIKE ${sqlString(`%${text}%`)}`,
            `SELECT A FROM [D] WHERE B LIKE ${sqlString(`${text}%`)}`,
            `SELECT A FROM [D] WHERE B BETWEEN ${sqlString(text)} AND 'z'`,
        );
    }
    for (const sql of queries) {
        it(sql, () => {
            const result = convert(sql, { deKey: `K\\${sql.length}` });
            const ssjs = result.outputs.filter(
                (output) => output.language === 'ssjs' && output.code,
            );
            assert.ok(ssjs.length > 0);
            for (const output of ssjs) {
                // the sqlLike helper is fixed text (proven live); everything else is generated
                const generated = output.code.replace(SQL_LIKE_HELPER, '');
                assert.doesNotMatch(output.code, /\\\\["']/, output.id);
                assert.ok(!generated.includes('\\\\'), `${output.id}:\n${output.code}`);
                assertValidSsjs(output.code);
            }
            assertRoundTrips(result);
        });
    }

    it('writes the unicode escape and reads it back as a backslash', () => {
        const result = convert(String.raw`SELECT A FROM [D\x] WHERE B = 'a\'`, {
            deKey: String.raw`K\y`,
        });
        const wsproxy = result.outputs.find((output) => output.id === 'ssjs-wsproxy');
        assert.ok(wsproxy.code.includes(`Value: "a${U005C}"`));
        assert.ok(wsproxy.code.includes(`"DataExtensionObject[K${U005C}y]"`));
        assert.ok(wsproxy.code.includes('// SQL: FROM [D~bx] (external key K~by)'));
        const back = parseSsjs(wsproxy.code);
        assert.equal(back.ast.where.value.value, 'a\\');
        assert.equal(back.ast.from.name, String.raw`D\x`);
        assert.equal(back.meta.deKey, String.raw`K\y`);
        const sql = convert(wsproxy.code, { direction: 'toSql' });
        assert.equal(
            sql.outputs[0].code,
            String.raw`SELECT A
FROM [D\x]
WHERE B = 'a\'`,
        );
    });
});

describe('AMPscript variable names', () => {
    it('ignore case, get numbers and never clash with the loop variables', () => {
        assert.deepEqual(
            ampVariableNames([
                'a b',
                'A_B',
                'a-b',
                'rows',
                'rowsValue',
                'RowCount',
                'i',
                '1x',
                'Row',
            ]),
            [
                '@a_b',
                '@A_B2',
                '@a_b3',
                '@rowsValue',
                '@rowsValue2',
                '@RowCountValue',
                '@iValue',
                '@_1x',
                '@RowValue',
            ],
        );
    });

    it('the LookupRows loop sets one distinct variable per column', () => {
        const { code } = emitAmpscriptLookupRows(
            ast("SELECT [a b], [A-B], a_b FROM D WHERE X = '1'"),
        );
        const variables = code
            .matchAll(/SET (@\w+) = Field/g)
            .map((match) => match[1].toLowerCase())
            .toArray();
        assert.deepEqual(variables, ['@a_b', '@a_b2', '@a_b3']);
    });
});

describe('TOP limits', () => {
    for (const sql of ['SELECT TOP 0 A FROM D', 'SELECT TOP (0) A FROM D']) {
        it(`${sql} is an error`, () => {
            const result = parseSql(sql);
            assert.equal(result.ast, null);
            assert.equal(result.messages[0].code, MESSAGE_CODES.INVALID_TOP);
            assert.match(result.messages[0].message, /TOP 0 returns no rows/);
        });
    }

    it('TOP above 2000 warns on the lookup targets only', () => {
        const sql = "SELECT TOP 2001 A FROM D WHERE B = '1' ORDER BY A";
        const result = convert(sql, { deKey: 'D' });
        for (const output of result.outputs) {
            const codes = (output.messages ?? []).map((message) => message.code);
            assert.equal(
                codes.includes(MESSAGE_CODES.TOP_ABOVE_LOOKUP_LIMIT),
                LOOKUP_FAMILY.includes(output.id),
                output.id,
            );
        }
        const warning = result.outputs[2].messages.find(
            (message) => message.code === MESSAGE_CODES.TOP_ABOVE_LOOKUP_LIMIT,
        );
        assert.equal(warning.severity, 'warning');
        assert.match(warning.message, /2,000/);
        assert.equal(sql.slice(warning.column - 1, warning.endColumn - 1), 'SELECT TOP 2001');
    });

    it('TOP 2000 has no limit warning', () => {
        const result = convert("SELECT TOP 2000 A FROM D WHERE B = '1' ORDER BY A", {
            deKey: 'D',
        });
        for (const output of result.outputs) {
            assert.ok(
                (output.messages ?? []).every(
                    (message) => message.code !== MESSAGE_CODES.TOP_ABOVE_LOOKUP_LIMIT,
                ),
            );
        }
    });
});

// names that must survive a header comment unchanged (the first three read back changed
// with the earlier space-based encoding)
const COMMENT_NAMES = [
    'c* /d',
    'D< /x',
    'x] %%',
    'D</script>x',
    '</script>',
    'a]%%b',
    'a*/b',
    String.raw`x\y`,
    '\\',
    'q"x',
    '"',
    '~',
    '~~',
    '~q',
    '~b',
    '~/',
    '~%',
    'a~',
    '</',
    '*</',
    ']]%%',
    '%%[',
    '%%=',
    '=%%',
    ']%%[',
    '%%=%%',
    '%%%[',
    'plain',
];
const COMMENT_UNSAFE = ['\\', '"', '</', '*/', ']%%', '%%[', '=%%', '%%='];

/**
 * Returns every comment line the generator wrote (`// …` and `/* … *\/`).
 *
 * @param {string} code emitted code
 * @returns {string[]} comment lines
 */
function commentLines(code) {
    return code
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('//') || line.startsWith('/*'));
}

describe('header comments cannot end their block', () => {
    it('encodes and decodes every name exactly', () => {
        for (const text of COMMENT_NAMES) {
            const safe = commentText(text);
            for (const unsafe of COMMENT_UNSAFE) {
                assert.ok(!safe.includes(unsafe), `${text} → ${safe} contains ${unsafe}`);
            }
            assert.equal(decodeCommentText(safe), text, `${text} → ${safe}`);
        }
    });

    it('escapes with ~ and never with a backslash or a double quote', () => {
        assert.equal(commentText('a~"\\'), 'a~~~q~b');
        assert.equal(commentText('</ */ ]%% %%[ =%% %%='), '<~/ *~/ ]~%% %~%[ =~%% %~%=');
    });

    for (const sql of [
        "SELECT [c* /d] FROM D WHERE c = 'v'",
        "SELECT a FROM [D< /x] WHERE c = 'v'",
        "SELECT [x]] %%] FROM D WHERE c = 'v'",
    ]) {
        it(`reads back unchanged: ${sql}`, () => {
            const result = convert(sql, { deKey: 'K' });
            assert.ok(result.outputs.some((output) => output.code));
            assertRoundTrips(result);
            const back = parseSql(sql).ast;
            const wsproxy = parseSsjs(result.outputs[0].code);
            assert.equal(wsproxy.ast.from.name, back.from.name);
        });
    }

    for (const name of COMMENT_NAMES) {
        it(`round trip and safe comments for the name ${JSON.stringify(name)}`, () => {
            const bracketed = `[${name.replaceAll(']', ']]')}]`;
            const sql = `SELECT ${bracketed.replace('[', '[C')}, B FROM ${bracketed.replace('[', '[D')} WHERE c = 'v'`;
            const result = convert(sql, { deKey: `K${name}` });
            const available = result.outputs.filter((output) => output.code);
            assert.ok(available.length > 0, sql);
            assertRoundTrips(result);
            for (const output of available) {
                for (const line of commentLines(output.code)) {
                    assert.ok(!/["\\]/.test(line), `${output.id}: ${line}`);
                }
                if (output.language === 'ssjs') {
                    assertValidSsjs(output.code);
                }
            }
            const back = parseSsjs(result.outputs[0].code);
            assert.equal(back.ast.from.name, `D${name}`);
            assert.equal(back.meta.deKey, `K${name}`);
        });
    }

    it('FROM [D</script>x] and a column a]%%b in SSJS', () => {
        const sql = "SELECT [a]]%%b], [c*/d] FROM [D</script>x] WHERE B = '1'";
        const result = convert(sql, { deKey: 'K' });
        const ssjs = result.outputs.filter((item) => item.language === 'ssjs' && item.code);
        assert.equal(ssjs.length, 3);
        for (const output of ssjs) {
            const closers = output.code.match(/<\/script/gi) ?? [];
            assert.equal(closers.length, 1, output.id);
            const comments = output.code.split('\n').filter((line) => line.startsWith('// SQL:'));
            assert.ok(
                comments.every((line) => !line.includes(']%%')),
                output.id,
            );
            assertValidSsjs(output.code);
        }
        const wsproxy = result.outputs[0];
        assert.match(wsproxy.code, /\/\/ SQL: FROM \[D<~\/script>x\]/);
        const back = parseSsjs(wsproxy.code);
        assert.equal(back.ast.from.name, 'D</script>x');
        assertRoundTrips(result);
        // the only AMPscript target that fits this query otherwise (two columns, no ORDER BY)
        const ampscript = result.outputs.find((item) => item.id === 'ampscript-lookuprows');
        assert.match(ampscript.unavailable, /"%%"/);
    });

    it('a column a*/b in an AMPscript comment', () => {
        const sql = "SELECT [a*/b], C FROM D WHERE B = '1'";
        const { code } = emitAmpscriptLookupRows(ast(sql));
        assert.match(code, /\/\* SQL: SELECT \[a\*~\/b\], C \*\/\n/);
        const back = parseAmpscript(code);
        assert.deepEqual(
            back.ast.columns.map((column) => column.name),
            ['a*/b', 'C'],
        );
        assertRoundTrips(convert(sql, { deKey: 'D' }));
    });
});

describe('AMPscript blocks and %%', () => {
    it('a ]%% inside a string does not end the block', () => {
        for (const code of [
            '%%[ SET @x = "a]%%b" SET @rows = LookupRows("D", "A", "1") ]%%',
            '%%[ SET @x = \'it\'\'s ]%%\' SET @rows = LookupRows("D", "A", "1") ]%%',
            '%%[ /* don\'t */ SET @x = "q""]%%" SET @rows = LookupRows("D", "A", "1") ]%%',
        ]) {
            const regions = findAmpscriptRegions(code);
            assert.equal(regions.length, 1, code);
            assert.equal(regions[0][1], code.length - 3, code);
            const back = parseAmpscript(code);
            assert.ok(back.ast, code);
            assert.equal(back.ast.from.name, 'D');
        }
    });

    it('%% in a value or name makes the AMPscript targets unavailable', () => {
        for (const sql of [
            "SELECT A FROM D WHERE B = '50%%' ORDER BY A",
            "SELECT A FROM [D%%] WHERE B = '1' ORDER BY A",
            "SELECT [A%%] FROM D WHERE B = '1' ORDER BY A",
            "SELECT A FROM D WHERE [B]]%%] = '1' ORDER BY A",
        ]) {
            const result = convert(sql, { deKey: 'D' });
            for (const output of result.outputs) {
                if (output.language === 'ampscript') {
                    assert.match(output.unavailable, /"%%"/, `${sql} ${output.id}`);
                } else if (output.id.startsWith('ssjs-lookup') || output.id === 'ssjs-wsproxy') {
                    assert.ok(output.code, `${sql} ${output.id}`);
                }
            }
            assertRoundTrips(result);
        }
    });
});

describe('WSProxy paging forms read back', () => {
    const sql = "SELECT A, B FROM D WHERE B = '1'";

    it('ContinueRequest paging reads back as one lookup', () => {
        const { code } = emitSsjsWsproxy(ast(sql), { output: { paging: true } });
        const back = parseSsjs(code);
        assert.ok(back.ast);
        assert.deepEqual(back.messages, []);
        assert.equal(convert(sql, { deKey: 'D', output: { paging: true } }).roundTrip.ok, true);
    });

    it('the older getNextBatch form still reads back', () => {
        const code = `var api = new Script.Util.WSProxy();
var objectType = "DataExtensionObject[D]";
var cols = ["A", "B"];
var filter = { Property: "B", SimpleOperator: "equals", Value: "1" };
var result = api.retrieve(objectType, cols, filter);
while (result) {
    result = result.HasMoreRows ? api.getNextBatch(objectType, result.RequestID) : null;
}`;
        const back = parseSsjs(code);
        assert.ok(back.ast);
        assert.ok(back.messages.every((message) => message.severity !== 'warning'));
        assert.equal(
            convert(code, { direction: 'toSql' }).outputs[0].code,
            'SELECT A, B\nFROM D\nWHERE B = 1',
        );
    });
});

describe('filter-only reverse', () => {
    const filter = '{ Property: "Country", SimpleOperator: "equals", Value: "DE" }';

    it('uses options.deName when given', () => {
        const back = convert(filter, { direction: 'toSql', deName: 'Customers' });
        assert.equal(back.outputs[0].code, "SELECT *\nFROM Customers\nWHERE Country = 'DE'");
        assert.equal(back.roundTrip.ok, true);
        assert.equal(back.roundTrip.skipped, undefined);
    });

    it('skips the round trip with a note without a name', () => {
        const back = convert(filter, { direction: 'toSql' });
        assert.equal(back.roundTrip.ok, true);
        assert.equal(back.roundTrip.skipped, true);
        assert.match(back.roundTrip.note, /skipped/);
        assert.ok(back.messages.some((message) => message.code === MESSAGE_CODES.FROM_UNKNOWN));
    });
});
