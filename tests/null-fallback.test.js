import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MESSAGE_CODES, convert, parseSql, printSql } from '../src/index.js';
import { evaluate } from './helpers/evaluate.js';

/**
 * Parses a query that must succeed and returns AST, printed SQL and messages.
 *
 * @param {string} text query
 * @returns {{ast: object, sql: string, messages: object[]}} result
 */
function ok(text) {
    const result = parseSql(text);
    const errors = result.messages.filter((message) => message.severity === 'error');
    assert.deepEqual(errors, [], `unexpected errors for: ${text}`);
    return { ast: result.ast, sql: printSql(result.ast), messages: result.messages };
}

/**
 * Parses a query that must fail with the given code.
 *
 * @param {string} text query
 * @param {string} code expected message code
 * @returns {object} the error message
 */
function fails(text, code) {
    const result = parseSql(text);
    assert.equal(result.ast, null, `expected an error for: ${text}`);
    const error = result.messages.find((message) => message.severity === 'error');
    assert.equal(error.code, code, `${text}: ${error.message}`);
    return error;
}

/**
 * Returns the WHERE line of a printed query.
 *
 * @param {string} sql printed SQL
 * @returns {string} text after "WHERE "
 */
function whereOf(sql) {
    return sql
        .split('\n')
        .find((line) => line.startsWith('WHERE '))
        .slice(6);
}

describe('ISNULL / COALESCE rewrite', () => {
    const cases = [
        ["ISNULL(Country, 'DE') = 'DE'", "Country = 'DE' OR Country IS NULL"],
        ["ISNULL(Country, 'DE') = 'FR'", "Country = 'FR'"],
        ["ISNULL(Country, 'DE') <> 'FR'", "Country <> 'FR' OR Country IS NULL"],
        ["ISNULL(Country, 'DE') != 'DE'", "Country <> 'DE'"],
        ['COALESCE(Age, 0) > 5', 'Age > 5'],
        ['COALESCE(Age, 10) > 5', 'Age > 5 OR Age IS NULL'],
        ['ISNULL(Age, 5) >= 5', 'Age >= 5 OR Age IS NULL'],
        ['ISNULL(Age, 5) < 5', 'Age < 5'],
        ['ISNULL(Age, -1) <= 0', 'Age <= 0 OR Age IS NULL'],
        ["ISNULL(Age, '10') > 9", 'Age > 9 OR Age IS NULL'],
        ["ISNULL(Name, 'b') > 'a'", "Name > 'a' OR Name IS NULL"],
        ["ISNULL(Name, 'de  ') = 'DE'", "Name = 'DE' OR Name IS NULL"],
        ["ISNULL(Day, '2026-01-01') < '2026-02-01'", "Day < '2026-02-01' OR Day IS NULL"],
        ["ISNULL(Day, '2026-03-01') < '2026-02-01'", "Day < '2026-02-01'"],
        [
            "ISNULL(Day, '2020-01-01') = '2020-01-01 00:00'",
            "Day = '2020-01-01 00:00' OR Day IS NULL",
        ],
        [
            "ISNULL(Day, '2020-01-01T00:00:00') >= '2020-01-01'",
            "Day >= '2020-01-01' OR Day IS NULL",
        ],
        ["ISNULL(Day, '2020-01-01 00:00:01') > '2020-01-01'", "Day > '2020-01-01' OR Day IS NULL"],
        ["ISNULL(Email, 'none') LIKE '%non%'", "Email LIKE '%non%' OR Email IS NULL"],
        ["ISNULL(Email, 'none') LIKE 'x%'", "Email LIKE 'x%'"],
        ["ISNULL(Email, NULL) = 'x'", "Email = 'x'"],
        ["isnull([First Name], 'n/a') = 'N/A'", "[First Name] = 'N/A' OR [First Name] IS NULL"],
    ];
    for (const [where, expected] of cases) {
        it(`${where} → ${expected}`, () => {
            const result = ok(`SELECT A FROM D WHERE ${where}`);
            assert.equal(whereOf(result.sql), expected);
            const info = result.messages.find(
                (message) => message.code === MESSAGE_CODES.NULL_FALLBACK_REWRITTEN,
            );
            assert.ok(info, 'info message');
            assert.equal(info.severity, 'info');
            assert.match(info.message, /assumes the fallback value fits the type/);
        });
    }

    it('keeps the OR group in brackets inside AND', () => {
        const { sql } = ok("SELECT A FROM D WHERE ISNULL(B, 'x') = 'x' AND C = 1");
        assert.equal(whereOf(sql), "(B = 'x' OR B IS NULL) AND C = 1");
    });

    it('marks the call and the value in the info message', () => {
        const text = "SELECT A FROM D WHERE ISNULL(B, 'x') = 'x'";
        const info = parseSql(text).messages[0];
        assert.equal(info.column, text.indexOf('ISNULL') + 1);
        assert.equal(info.endColumn, text.length + 1);
    });

    it('returns the same rows as the function would (evaluated on a fixture)', () => {
        const fixture = {
            fields: [{ Name: 'N', FieldType: 'Number' }],
            rows: [{ N: null }, { N: -3 }, { N: 0 }, { N: 4 }, { N: 7 }],
        };
        for (const op of ['=', '<>', '<', '<=', '>', '>=']) {
            for (const fallback of [-3, 0, 4, 9]) {
                for (const value of [0, 4]) {
                    const { ast } = ok(
                        `SELECT N FROM D WHERE ISNULL(N, ${fallback}) ${op} ${value}`,
                    );
                    const expected = ok(`SELECT N FROM D WHERE N ${op} ${value}`).ast;
                    const filled = {
                        ...fixture,
                        rows: fixture.rows.map((row) => ({ N: row.N ?? fallback })),
                    };
                    const want = evaluate(expected, filled).map((row) => row.N);
                    const got = evaluate(ast, fixture).map((row) => row.N ?? fallback);
                    assert.deepEqual(got, want, `ISNULL(N, ${fallback}) ${op} ${value}`);
                }
            }
        }
    });
});

describe('ISNULL / COALESCE errors', () => {
    const cases = [
        ["ISNULL(LOWER(B), 'x') = 'x'", MESSAGE_CODES.UNSUPPORTED_FUNCTION],
        ["ISNULL(B, C) = 'x'", MESSAGE_CODES.UNSUPPORTED_FUNCTION],
        ["ISNULL(B, LOWER('x')) = 'x'", MESSAGE_CODES.UNSUPPORTED_FUNCTION],
        ["COALESCE(B, 'x', 'y') = 'x'", MESSAGE_CODES.UNSUPPORTED_FUNCTION],
        ['ISNULL(B) = 1', MESSAGE_CODES.UNSUPPORTED_FUNCTION],
        ["ISNULL('x', B) = 'x'", MESSAGE_CODES.UNSUPPORTED_FUNCTION],
        ["ISNULL(B, 'x') = 5", MESSAGE_CODES.UNSUPPORTED_FUNCTION],
        ["ISNULL(B, 'x') IN ('x')", MESSAGE_CODES.UNSUPPORTED_FUNCTION],
        ["ISNULL(B, 'x') IS NULL", MESSAGE_CODES.UNSUPPORTED_FUNCTION],
        ["ISNULL(B, 'x') BETWEEN 'a' AND 'z'", MESSAGE_CODES.UNSUPPORTED_FUNCTION],
        ["ISNULL(B, 'x') = C", MESSAGE_CODES.UNSUPPORTED_COLUMN_COMPARISON],
        ["ISNULL(B, 'x') = NULL", MESSAGE_CODES.NULL_COMPARISON],
        ["ISNULL(B, 'x') NOT LIKE 'x'", MESSAGE_CODES.UNSUPPORTED_NOT_LIKE],
        ["NOT ISNULL(B, 'x') = 'x'", MESSAGE_CODES.UNSUPPORTED_NOT_CONDITION],
        ["ISNULL(B, 'x') LIKE 5", MESSAGE_CODES.EXPECTED_STRING],
        ["ISNULL(B, 'x'", MESSAGE_CODES.MISSING_CLOSING_PAREN],
        ["NULLIF(B, 'x') = 'x'", MESSAGE_CODES.UNSUPPORTED_FUNCTION],
    ];
    for (const [where, code] of cases) {
        it(`${where} → ${code}`, () => {
            fails(`SELECT A FROM D WHERE ${where}`, code);
        });
    }

    it('stays unsupported in the column list and in ORDER BY', () => {
        fails("SELECT ISNULL(A, 'x') FROM D", MESSAGE_CODES.UNSUPPORTED_FUNCTION);
        fails("SELECT A FROM D ORDER BY ISNULL(A, 'x')", MESSAGE_CODES.UNSUPPORTED_FUNCTION);
    });

    it('explains the supported form', () => {
        const error = fails(
            "SELECT A FROM D WHERE COALESCE(B, 'x', 'y') = 'x'",
            MESSAGE_CODES.UNSUPPORTED_FUNCTION,
        );
        assert.match(error.message, /COALESCE\(Column, value\)/);
        assert.match(error.message, /More than two arguments/);
    });
});

describe('ISNULL / COALESCE in convert()', () => {
    const sql = "SELECT A FROM D WHERE ISNULL(B, 'x') = 'x'";

    it('WSProxy and Rows.Retrieve express the IS NULL branch and round-trip', () => {
        const result = convert(sql, { deKey: 'D' });
        for (const id of ['ssjs-wsproxy', 'ssjs-rows-retrieve']) {
            const output = result.outputs.find((item) => item.id === id);
            assert.ok(output.code, id);
            assert.equal(output.roundTrip.ok, true, id);
            assert.match(output.roundTrip.sql, /B = 'x' OR B IS NULL/);
        }
    });

    it('the lookup functions (SSJS and AMPscript) are unavailable for the OR + IS NULL form', () => {
        const result = convert(sql, { deKey: 'D' });
        const lookups = result.outputs.filter((item) => /lookup/.test(item.id));
        assert.equal(lookups.length, 5);
        for (const output of lookups) {
            assert.ok(output.unavailable, output.id);
        }
    });

    it('a rewrite without OR keeps the lookup functions available', () => {
        const result = convert("SELECT A FROM D WHERE ISNULL(B, 'x') = 'y'", { deKey: 'D' });
        const lookup = result.outputs.find((item) => item.id === 'ampscript-lookuprows');
        assert.ok(lookup.code);
        assert.equal(lookup.roundTrip.ok, true);
    });

    it('toSql prints the expanded form (no ISNULL)', () => {
        const code = convert(sql, { deKey: 'D' }).outputs[0].code;
        const back = convert(code, { direction: 'toSql' });
        assert.doesNotMatch(back.outputs[0].code, /ISNULL/i);
        assert.match(back.outputs[0].code, /B = 'x' OR B IS NULL/);
    });
});

describe('OFFSET … FETCH', () => {
    it('is rejected with a clear message pointing at the whole clause', () => {
        const text = 'SELECT A FROM D ORDER BY A OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY;';
        const error = fails(text, MESSAGE_CODES.UNSUPPORTED_OFFSET_FETCH);
        assert.match(error.message, /Use TOP/);
        assert.equal(error.column, text.indexOf('OFFSET') + 1);
        assert.equal(error.endColumn, text.length);
    });

    it('is rejected after WHERE without ORDER BY, and for FETCH after ORDER BY', () => {
        fails('SELECT A FROM D WHERE B = 1 OFFSET 5 ROWS', MESSAGE_CODES.UNSUPPORTED_OFFSET_FETCH);
        fails(
            'SELECT A FROM D ORDER BY A FETCH NEXT 5 ROWS ONLY',
            MESSAGE_CODES.UNSUPPORTED_OFFSET_FETCH,
        );
    });
});
