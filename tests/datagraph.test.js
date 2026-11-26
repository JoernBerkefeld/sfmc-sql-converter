import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MESSAGE_CODES, convert, parseHandlebars } from '../src/index.js';

const DG = 'handlebars-datagraph';
const DMO = 'UnifiedLinkssotIndividualMkt__dlm';
const GRAPH = `(get (get @root "$dataGraph") "${DMO}")`;

/**
 * Converts SQL to the data graph output.
 *
 * @param {string} sql query
 * @returns {object} output
 */
function output(sql) {
    const result = convert(sql, { platform: 'mcn', dataSource: 'DG' });
    assert.deepEqual(
        result.outputs.map((item) => item.id),
        [DG],
    );
    return result.outputs[0];
}

/**
 * Returns the code of an output that must be available and must round-trip.
 *
 * @param {string} sql query
 * @returns {string} code
 */
function code(sql) {
    const item = output(sql);
    assert.equal(item.unavailable, undefined, item.unavailable);
    assert.equal(item.roundTrip.ok, true, item.roundTrip.note);
    return item.code;
}

/**
 * Returns the reason of an output that must be unavailable.
 *
 * @param {string} sql query
 * @returns {string} reason
 */
function unavailable(sql) {
    const item = output(sql);
    assert.ok(item.unavailable, `should be unavailable, got:\n${item.code}`);
    return item.unavailable;
}

/**
 * Reads code back to SQL with convert().
 *
 * @param {string} text code
 * @returns {object} convert result
 */
function toSql(text) {
    return convert(text, { platform: 'mcn', direction: 'toSql' });
}

describe('data graph output (DG)', () => {
    it('emits the loop with one line of fields', () => {
        assert.equal(
            code(`SELECT A__c, B__c FROM ${DMO}`),
            `{{#each ${GRAPH}}}\n    {{A__c}} {{B__c}}\n{{/each}}`,
        );
    });

    it('emits WHERE as an #if with compare, and, or', () => {
        assert.equal(
            code(`SELECT A__c, B__c FROM ${DMO} WHERE A__c = 'x' AND B__c <> 'y'`),
            [
                `{{#each ${GRAPH}}}`,
                '    {{#if (and (compare A__c "==" "x") (compare B__c "!=" "y"))}}',
                '        {{A__c}} {{B__c}}',
                '    {{/if}}',
                '{{/each}}',
            ].join('\n'),
        );
        assert.match(
            code(
                `SELECT A__c FROM ${DMO} WHERE (A__c < 1 OR A__c <= 2) AND (B__c > 3 OR B__c >= 4)`,
            ),
            /\{\{#if \(and \(or \(compare A__c "<" 1\) \(compare A__c "<=" 2\)\) \(or \(compare B__c ">" 3\) \(compare B__c ">=" 4\)\)\)\}\}/,
        );
    });

    it('keeps the value type: text quoted, numbers bare', () => {
        assert.match(
            code(`SELECT A__c FROM ${DMO} WHERE A__c = '5' AND B__c = -2.5`),
            /\(compare A__c "==" "5"\) \(compare B__c "==" -2\.5\)/,
        );
    });

    it('writes IN as an or chain of == and NOT IN as an and chain of !=', () => {
        assert.match(
            code(`SELECT A__c FROM ${DMO} WHERE A__c IN ('a', 'b', 'c')`),
            /\{\{#if \(or \(or \(compare A__c "==" "a"\) \(compare A__c "==" "b"\)\) \(compare A__c "==" "c"\)\)\}\}/,
        );
        assert.match(
            code(`SELECT A__c FROM ${DMO} WHERE A__c NOT IN (1, 2)`),
            /\{\{#if \(and \(compare A__c "!=" 1\) \(compare A__c "!=" 2\)\)\}\}/,
        );
        assert.match(
            code(`SELECT A__c FROM ${DMO} WHERE A__c IN ('a')`),
            /\{\{#if \(compare A__c "==" "a"\)\}\}/,
        );
    });

    it('emits ORDER BY as sort "string" and TOP as slice 0 N', () => {
        assert.equal(
            code(`SELECT TOP 5 A__c FROM ${DMO} ORDER BY B__c DESC`),
            `{{#each (slice (sort ${GRAPH} "B__c" "desc" "string") 0 5)}}\n    {{A__c}}\n{{/each}}`,
        );
        assert.match(code(`SELECT A__c FROM ${DMO} ORDER BY B__c`), /"B__c" "asc" "string"\)\}\}/);
    });

    it('leaves TOP out with a warning when WHERE is present', () => {
        const item = output(`SELECT TOP 3 A__c FROM ${DMO} WHERE A__c = 'x' ORDER BY A__c`);
        assert.deepEqual(item.dropped, ['top']);
        assert.doesNotMatch(item.code, /slice/);
        assert.match(item.code, /^\{\{#each \(sort /);
        const warning = item.messages.find((message) => message.code === MESSAGE_CODES.TOP_DROPPED);
        assert.equal(warning.severity, 'warning');
        assert.equal(item.roundTrip.ok, true);
        assert.match(item.roundTrip.note, /without TOP/);
    });

    it('adds the scope info to every output', () => {
        for (const sql of [`SELECT A__c FROM ${DMO}`, `SELECT A__c FROM ${DMO} WHERE A__c = 'x'`]) {
            const info = output(sql).messages.find(
                (message) => message.code === MESSAGE_CODES.DATA_GRAPH_SCOPE,
            );
            assert.equal(info.severity, 'info');
            assert.match(info.message, /recipient's own/);
            assert.match(info.message, /directly under the graph's root/);
            assert.match(info.message, /Email Builder preview only/);
            assert.match(info.message, /case-sensitive/);
        }
    });

    it('records clause spans', () => {
        const item = output(`SELECT TOP 2 A__c FROM ${DMO} WHERE A__c IN ('a', 'b') ORDER BY A__c`);
        const text = (clauseId) =>
            item.spans
                .filter((span) => span.clauseId === clauseId)
                .map((span) => item.code.slice(span.start, span.end));
        assert.deepEqual(text('from'), [`"${DMO}"`]);
        assert.deepEqual(text('order-0'), ['"A__c" "asc"']);
        assert.deepEqual(text('where-0'), ['(or (compare A__c "==" "a") (compare A__c "==" "b"))']);
        assert.deepEqual(text('column-0'), ['{{A__c}}']);
        assert.deepEqual(text('top'), []);
    });

    it('is unavailable with a plain reason for what it cannot express', () => {
        assert.match(unavailable(`SELECT * FROM ${DMO}`), /list the columns/);
        assert.match(unavailable(`SELECT A__c FROM ${DMO} WHERE A__c LIKE '%x%'`), /LIKE/);
        assert.match(unavailable(`SELECT A__c FROM ${DMO} WHERE A__c BETWEEN 1 AND 5`), /BETWEEN/);
        assert.match(unavailable(`SELECT A__c FROM ${DMO} WHERE A__c IS NULL`), /empty values/);
        assert.match(unavailable(`SELECT A__c FROM ${DMO} WHERE A__c IS NOT NULL`), /empty values/);
        assert.match(unavailable(`SELECT A__c FROM ${DMO} ORDER BY A__c, B__c`), /one field/);
        // bare names inside the loop would read the row or call a helper
        assert.match(unavailable(`SELECT this FROM ${DMO}`), /"this" could read the whole row/);
        assert.match(unavailable(`SELECT A__c FROM ${DMO} WHERE length = 2`), /"length"/);
        assert.equal(output(`SELECT A__c FROM ${DMO} ORDER BY length`).unavailable, undefined);
        assert.match(unavailable('SELECT [A B] FROM X__dlm'), /API name/);
        assert.match(
            unavailable(String.raw`SELECT A__c FROM X__dlm WHERE A__c = 'a\'`),
            /backslash/,
        );
    });
});

describe('data graph round trip (SQL → code → SQL)', () => {
    const queries = [
        `SELECT A__c, B__c FROM ${DMO}`,
        `SELECT TOP 5 A__c FROM ${DMO}`,
        `SELECT TOP 1 A__c FROM ${DMO} ORDER BY A__c DESC`,
        `SELECT A__c FROM ${DMO} WHERE A__c = 'x' OR B__c = 'y' AND C__c > 3`,
        `SELECT A__c FROM ${DMO} WHERE (A__c = 'x' OR B__c = 'y') AND C__c >= 3 ORDER BY C__c`,
        `SELECT A__c FROM ${DMO} WHERE A__c IN ('a', 'b', 'c') OR B__c NOT IN (1, 2)`,
        `SELECT A__c FROM ${DMO} WHERE A__c = 'O"Brien' AND B__c = '5'`,
    ];
    for (const sql of queries) {
        it(sql, () => {
            const generated = code(sql);
            const back = toSql(generated);
            assert.equal(back.roundTrip.ok, true, back.roundTrip.note);
            assert.equal(back.messages.length, 0);
        });
    }

    it('reads the data graph form back to SQL', () => {
        const back = toSql(
            [
                `{{#each (sort ${GRAPH} "A__c" "desc" "string")}}`,
                '{{#if (and (compare A__c "==" "x") (or (compare B__c "!=" 5) (compare C__c "<" "z")))}}',
                '{{A__c}}, {{B__c}}',
                '{{/if}}',
                '{{/each}}',
            ].join('\n'),
        );
        assert.equal(
            back.outputs[0].code,
            `SELECT A__c, B__c\nFROM ${DMO}\nWHERE A__c = 'x' AND (B__c <> 5 OR C__c < 'z')\nORDER BY A__c DESC`,
        );
        const parsed = parseHandlebars(`{{#each ${GRAPH}}}{{A__c}}{{/each}}`);
        assert.equal(parsed.meta.target, DG);
        assert.equal(parsed.meta.dataSource, 'DG');
        assert.equal(parsed.meta.deName, DMO);
    });

    it('reads and / or with more than two conditions', () => {
        const back = toSql(
            `{{#each ${GRAPH}}}{{#if (or (compare A__c "==" 1) (compare A__c "==" 2) (compare A__c "==" 3))}}{{A__c}}{{/if}}{{/each}}`,
        );
        assert.equal(
            back.outputs[0].code,
            `SELECT A__c\nFROM ${DMO}\nWHERE A__c = 1 OR A__c = 2 OR A__c = 3`,
        );
    });
});

describe('parseHandlebars — data graph errors', () => {
    const cases = [
        [
            'a get that is not the graph root',
            `{{#each (get (get @root "other") "${DMO}")}}{{A__c}}{{/each}} "$dataGraph"`,
            MESSAGE_CODES.INVALID_ARGUMENT,
        ],
        [
            'an unknown helper as the source',
            `{{#each (filter ${GRAPH} "A__c" "==" "x")}}{{A__c}}{{/each}}`,
            MESSAGE_CODES.INVALID_ARGUMENT,
        ],
        [
            'slice that does not start at 0',
            `{{#each (slice ${GRAPH} 1 5)}}{{A__c}}{{/each}}`,
            MESSAGE_CODES.INVALID_COUNT,
        ],
        [
            'slice with a row check (TOP before WHERE)',
            `{{#each (slice ${GRAPH} 0 5)}}{{#if (compare A__c "==" "x")}}{{A__c}}{{/if}}{{/each}}`,
            MESSAGE_CODES.INVALID_COUNT,
        ],
        [
            'a sort direction other than asc / desc',
            `{{#each (sort ${GRAPH} "A__c" "up" "string")}}{{A__c}}{{/each}}`,
            MESSAGE_CODES.INVALID_ORDER_BY,
        ],
        [
            'a sort type other than "string"',
            `{{#each (sort ${GRAPH} "A__c" "asc" "number")}}{{A__c}}{{/each}}`,
            MESSAGE_CODES.INVALID_ORDER_BY,
        ],
        [
            'sort without its type',
            `{{#each (sort ${GRAPH} "A__c" "asc")}}{{A__c}}{{/each}}`,
            MESSAGE_CODES.ARGUMENT_COUNT,
        ],
        [
            'an unknown compare operator',
            `{{#each ${GRAPH}}}{{#if (compare A__c "=" "x")}}{{A__c}}{{/if}}{{/each}}`,
            MESSAGE_CODES.UNKNOWN_FILTER_OPERATOR,
        ],
        [
            'a row check other than compare / and / or',
            `{{#each ${GRAPH}}}{{#if (equals A__c "x")}}{{A__c}}{{/if}}{{/each}}`,
            MESSAGE_CODES.INVALID_FILTER,
        ],
        [
            'a field compared with a field',
            `{{#each ${GRAPH}}}{{#if (compare A__c "==" B__c)}}{{A__c}}{{/if}}{{/each}}`,
            MESSAGE_CODES.INVALID_FILTER_VALUE,
        ],
        [
            'and with one condition',
            `{{#each ${GRAPH}}}{{#if (and (compare A__c "==" "x"))}}{{A__c}}{{/if}}{{/each}}`,
            MESSAGE_CODES.ARGUMENT_COUNT,
        ],
        ['a loop without fields', `{{#each ${GRAPH}}}text{{/each}}`, MESSAGE_CODES.SYNTAX_ERROR],
        [
            'another tag in the loop',
            `{{#each ${GRAPH}}}{{A__c}}{{upper B__c}}{{/each}}`,
            MESSAGE_CODES.SYNTAX_ERROR,
        ],
        [
            'content after the #if block',
            `{{#each ${GRAPH}}}{{#if (compare A__c "==" "x")}}{{A__c}}{{/if}}{{B__c}}{{/each}}`,
            MESSAGE_CODES.SYNTAX_ERROR,
        ],
        [
            'a loop that is never closed',
            `{{#each ${GRAPH}}}{{A__c}}`,
            MESSAGE_CODES.MISSING_CLOSING_PAREN,
        ],
        [
            'an #if that is never closed',
            `{{#each ${GRAPH}}}{{#if (compare A__c "==" "x")}}{{A__c}}{{/each}}`,
            MESSAGE_CODES.MISSING_CLOSING_PAREN,
        ],
        [
            'a bracket that is never closed',
            `{{#each (get (get @root "$dataGraph") "${DMO}"}}{{A__c}}{{/each}}`,
            MESSAGE_CODES.MISSING_CLOSING_PAREN,
        ],
    ];
    for (const [name, text, expected] of cases) {
        it(name, () => {
            const result = parseHandlebars(text);
            assert.equal(result.ast, null);
            const [error] = result.messages;
            assert.equal(error.severity, 'error');
            assert.equal(error.code, expected, error.message);
            assert.ok(error.line >= 1 && error.column >= 1);
        });
    }

    it('locates the error at the offending part', () => {
        const text = `{{#each ${GRAPH}}}{{#if (compare A__c "=" "x")}}{{A__c}}{{/if}}{{/each}}`;
        const [error] = parseHandlebars(text).messages;
        assert.equal(text.slice(error.column - 1, error.endColumn - 1), '"="');
    });
});
