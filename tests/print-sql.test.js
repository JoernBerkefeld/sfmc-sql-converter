import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeSql, parseSql, printSql, printSqlWithSpans } from '../src/index.js';
import { formatName, formatValue, isPlainNumber } from '../src/print-sql.js';

const groundTruth = JSON.parse(
    readFileSync(new URL('fixtures/ground-truth.json', import.meta.url), 'utf8'),
);

/**
 * Parses SQL and fails the test when it does not parse.
 *
 * @param {string} sql query
 * @returns {object} AST
 */
function ast(sql) {
    const result = parseSql(sql);
    assert.ok(result.ast, `query should parse: ${sql}`);
    return result.ast;
}

describe('printSql', () => {
    it('prints canonical text: upper-case keywords, one clause per line', () => {
        assert.equal(
            printSql(
                ast(
                    "select top (3) subscriberkey,[Email] from [Customers] where country='DE' and points>=5 order by points desc, email",
                ),
            ),
            "SELECT TOP 3 subscriberkey, Email\nFROM Customers\nWHERE country = 'DE' AND points >= 5\nORDER BY points DESC, email ASC",
        );
    });

    it('brackets names only when needed', () => {
        assert.equal(formatName('Email'), 'Email');
        assert.equal(formatName('_x1'), '_x1');
        assert.equal(formatName('Über'), 'Über');
        assert.equal(formatName('First Name'), '[First Name]');
        assert.equal(formatName('Order'), '[Order]');
        assert.equal(formatName('select'), '[select]');
        assert.equal(formatName('1st'), '[1st]');
        assert.equal(formatName('a]b'), '[a]]b]');
        assert.equal(formatName('a-b'), '[a-b]');
    });

    it("quotes text with '' escaping and keeps numbers unquoted", () => {
        assert.equal(formatValue({ kind: 'string', value: "O'Brien" }), "'O''Brien'");
        assert.equal(formatValue({ kind: 'number', value: '7.25' }), '7.25');
        assert.equal(formatValue({ kind: 'number', value: '-3' }), '-3');
    });

    it('prints plain-number text unquoted, leading-zero text quoted', () => {
        assert.equal(formatValue({ kind: 'string', value: '500' }), '500');
        assert.equal(formatValue({ kind: 'string', value: '-2.5' }), '-2.5');
        assert.equal(formatValue({ kind: 'string', value: '01067' }), "'01067'");
        assert.equal(formatValue({ kind: 'string', value: '1e3' }), "'1e3'");
        assert.equal(formatValue({ kind: 'string', value: '' }), "''");
        assert.ok(isPlainNumber('0'));
        assert.ok(isPlainNumber('0.5'));
        assert.ok(!isPlainNumber('00'));
        assert.ok(!isPlainNumber('1.'));
        assert.ok(!isPlainNumber(' 1'));
    });

    it('prints every condition type', () => {
        const sql =
            "SELECT * FROM X WHERE A <> 'x' OR B LIKE 'it''s%' OR C IN ('a', 2) OR D NOT IN (1) OR E BETWEEN '2024-01-01' AND '2024-12-31' OR F IS NULL OR G IS NOT NULL";
        assert.equal(
            printSql(ast(sql)),
            "SELECT *\nFROM X\nWHERE A <> 'x' OR B LIKE 'it''s%' OR C IN ('a', 2) OR D NOT IN (1) OR E BETWEEN '2024-01-01' AND '2024-12-31' OR F IS NULL OR G IS NOT NULL",
        );
    });

    it('keeps LIKE patterns quoted even when they look like numbers', () => {
        assert.match(printSql(ast("SELECT A FROM X WHERE A LIKE '500'")), /LIKE '500'/);
    });

    it('adds brackets around OR inside AND only', () => {
        assert.equal(
            printSql(
                ast(
                    "SELECT A FROM X WHERE (A = 'a' OR B = 'b') AND (C = 'c' OR (D = 'd' AND E = 'e'))",
                ),
            ).split('\n', 3)[2],
            "WHERE (A = 'a' OR B = 'b') AND (C = 'c' OR D = 'd' AND E = 'e')",
        );
        assert.equal(
            printSql(ast("SELECT A FROM X WHERE (A = 'a' AND B = 'b') OR C = 'c'")).split(
                '\n',
                3,
            )[2],
            "WHERE A = 'a' AND B = 'b' OR C = 'c'",
        );
    });

    it('records a span per clause', () => {
        const { sql, spans } = printSqlWithSpans(
            ast("SELECT TOP 2 A, [B C] FROM [D] WHERE A = 'a' AND [B C] IN (1, 2) ORDER BY A DESC"),
        );
        const texts = Object.fromEntries(
            spans.map((span) => [span.clauseId, sql.slice(span.start, span.end)]),
        );
        assert.deepEqual(texts, {
            top: 'TOP 2',
            'column-0': 'A',
            'column-1': '[B C]',
            from: 'D',
            'where-0': "A = 'a'",
            'where-1': '[B C] IN (1, 2)',
            'order-0': 'A DESC',
        });
    });

    it('parses back to the same query (all ground-truth variations and extras)', () => {
        const queries = [
            ...groundTruth.variations.map((variation) => variation.sql),
            "SELECT TOP 5 [First Name], [Order] FROM [My DE] WHERE [Order] = 'x' ORDER BY [First Name] DESC",
            "SELECT * FROM X WHERE A = '' OR B = 'a''b' OR C = -1.5",
        ];
        for (const sql of queries) {
            const tree = ast(sql);
            const printed = printSql(tree);
            const again = parseSql(printed);
            assert.ok(again.ast, `printed SQL parses: ${printed}`);
            assert.equal(normalizeSql(again.ast), normalizeSql(tree), printed);
            assert.equal(printSql(again.ast), printed, 'printing is stable');
        }
    });
});

/**
 * Asserts that two queries normalize to the same form.
 *
 * @param {string} a first query
 * @param {string} b second query
 * @param {object} [options] normalizeSql options
 */
function same(a, b, options) {
    assert.equal(normalizeSql(ast(a), options), normalizeSql(ast(b), options), `${a} ≡ ${b}`);
}

/**
 * Asserts that two queries normalize to different forms.
 *
 * @param {string} a first query
 * @param {string} b second query
 * @param {object} [options] normalizeSql options
 */
function different(a, b, options) {
    assert.notEqual(normalizeSql(ast(a), options), normalizeSql(ast(b), options), `${a} ≢ ${b}`);
}

describe('normalizeSql', () => {
    it('ignores keyword case, brackets, whitespace and name case', () => {
        same("select a from [x] where [B]='1'", "SELECT A\nFROM X\nWHERE b = '1'");
    });

    it('compares plain numbers by value, quoted or not', () => {
        same("SELECT A FROM X WHERE B = '500'", 'SELECT A FROM X WHERE B = 500');
        same('SELECT A FROM X WHERE B = 1.50', "SELECT A FROM X WHERE B = '1.5'");
        different("SELECT A FROM X WHERE B = '01067'", 'SELECT A FROM X WHERE B = 1067');
        different("SELECT A FROM X WHERE B = 'de'", "SELECT A FROM X WHERE B = 'DE'");
    });

    it('flattens AND / OR grouping of the same operator', () => {
        same(
            "SELECT A FROM X WHERE (A = 'a' AND B = 'b') AND C = 'c'",
            "SELECT A FROM X WHERE A = 'a' AND (B = 'b' AND C = 'c')",
        );
        different(
            "SELECT A FROM X WHERE (A = 'a' OR B = 'b') AND C = 'c'",
            "SELECT A FROM X WHERE A = 'a' OR B = 'b' AND C = 'c'",
        );
    });

    it('IN ↔ OR chain only with expandIn', () => {
        const a = "SELECT A FROM X WHERE C IN ('DE', 'ES') AND P = 1";
        const b = "SELECT A FROM X WHERE (C = 'DE' OR C = 'ES') AND P = 1";
        different(a, b);
        same(a, b, { expandIn: true });
        same("SELECT A FROM X WHERE C IN ('DE')", "SELECT A FROM X WHERE C = 'DE'", {
            expandIn: true,
        });
    });

    it('NOT IN ↔ AND chain of <> only with expandNotIn', () => {
        const a = "SELECT A FROM X WHERE C NOT IN ('DE', 'ES')";
        const b = "SELECT A FROM X WHERE C <> 'DE' AND C <> 'ES'";
        different(a, b);
        same(a, b, { expandNotIn: true });
        different(a, b, { expandIn: true });
    });

    it('BETWEEN ↔ >= AND <= only with expandBetween', () => {
        const a = 'SELECT A FROM X WHERE P BETWEEN 1 AND 5';
        const b = 'SELECT A FROM X WHERE P >= 1 AND P <= 5';
        different(a, b);
        same(a, b, { expandBetween: true });
    });

    it('* ↔ explicit list via columns', () => {
        different('SELECT * FROM X', 'SELECT A, B FROM X');
        same('SELECT * FROM X', 'SELECT a, b FROM X', { columns: ['A', 'B'] });
    });

    it('ignores dropped TOP / ORDER BY only when flagged', () => {
        const full = "SELECT TOP 3 A FROM X WHERE B = '1' ORDER BY A DESC";
        const bare = "SELECT A FROM X WHERE B = '1'";
        different(full, bare);
        same(full, bare, { dropTop: true, dropOrderBy: true });
        different(full, bare, { dropTop: true });
        different('SELECT A FROM X ORDER BY A DESC', 'SELECT A FROM X ORDER BY A');
    });
});
