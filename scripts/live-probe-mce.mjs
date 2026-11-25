/**
 * Live probe harness for the Engagement targets (not published; see package.json "files").
 *
 * Builds a CloudPage that runs the converter's generated code VERBATIM for every ground-truth
 * variation and every available target, each followed by a small reporting block, and compares
 * the reported keys with the real query-activity results in tests/fixtures/ground-truth.json.
 *
 * Usage:
 *   node scripts/live-probe-mce.mjs build <from> <to> <assetPath>   writes the CloudPage HTML
 *   node scripts/live-probe-mce.mjs check <outputFile>             compares a fetched page body
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ampVariableNames, convert } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const groundTruth = JSON.parse(
    readFileSync(path.join(here, '..', 'tests', 'fixtures', 'ground-truth.json'), 'utf8'),
);
const DE = groundTruth.fixture.name;

/**
 * Ordered / single-value cases; expected results derived from ground-truth sets sorted by tie-free keys.
 *
 * @type {{id: string, sql: string, expected: string, ordered: boolean}[]}
 */
const EXTRA = [
    {
        id: 'o1',
        sql: `SELECT TOP 2 SubscriberKey FROM [${DE}] WHERE Country = 'DE' ORDER BY SubscriberKey DESC`,
        expected: 'R09,R08',
        ordered: true,
    },
    {
        id: 'o2',
        sql: `SELECT SubscriberKey FROM [${DE}] WHERE IsActive = 1 ORDER BY SubscriberKey ASC`,
        expected: 'R01,R02,R04,R05,R08,R10',
        ordered: true,
    },
    {
        id: 'o3',
        sql: `SELECT SubscriberKey, Email FROM [${DE}] WHERE Tier = 'Gold' ORDER BY Email DESC`,
        expected: 'R08,R05,R03,R01',
        ordered: true,
    },
    {
        id: 'o4',
        sql: `SELECT SubscriberKey FROM [${DE}] WHERE Country = 'DE' ORDER BY Tier ASC, SubscriberKey DESC`,
        expected: 'R04,R08,R05,R01,R09',
        ordered: true,
    },
    {
        id: 'o5',
        sql: `SELECT FirstName FROM [${DE}] WHERE SubscriberKey = 'R03'`,
        expected: 'Carla',
        ordered: false,
    },
    {
        id: 'o6',
        sql: `SELECT SubscriberKey FROM [${DE}] WHERE Notes LIKE '%'`,
        expected: 'R01,R02,R04,R05,R06,R07,R08,R09,R10',
        ordered: false,
    },
    {
        id: 'o7',
        sql: `SELECT SubscriberKey FROM [${DE}] WHERE Notes <> ''`,
        expected: 'R01,R02,R04,R05,R07,R08,R09,R10',
        ordered: false,
    },
    {
        id: 'o8',
        // A value ending in a backslash: the emitted SSJS must not contain the literal "\\",
        // which makes the CloudPage fail with HTTP 422.
        sql: `SELECT SubscriberKey FROM [${DE}] WHERE Notes = 'x${String.fromCodePoint(92)}' OR Notes = 'vip'`,
        expected: 'R01',
        ordered: false,
    },
];

/**
 * Sort strings by code unit order without mutating the input.
 *
 * @param {string[]} list values
 * @returns {string[]} sorted copy
 */
function sortText(list) {
    return list.toSorted((a, b) => a.localeCompare(b, 'en'));
}

/**
 * Write one line to stdout.
 *
 * @param {string} line text
 */
function print(line) {
    process.stdout.write(`${line}
`);
}

/**
 * All cases: ground-truth variations plus the extra ordered cases.
 *
 * @returns {{id: string, sql: string, expected: string, ordered: boolean}[]} cases
 */
function cases() {
    const base = groundTruth.variations.map((variation) => ({
        id: variation.id,
        sql: variation.sql,
        expected: sortText(variation.expected).join(','),
        ordered: false,
    }));
    return [...base, ...EXTRA];
}

/**
 * Expected values of a case as a list.
 *
 * @param {{expected: string}} testCase case
 * @returns {string[]} expected values
 */
function expectedValues(testCase) {
    return testCase.expected.split(',');
}

/**
 * Reporting block after a target's code.
 *
 * @param {string} id case id
 * @param {string} target output id
 * @param {string} column column to report (SubscriberKey, or the Lookup column)
 * @returns {string} HTML/script snippet
 */
function reporter(id, target, column) {
    const label = `RES ${id} ${target}=`;
    if (target === 'ampscript-lookup') {
        // the same variable name the Lookup output sets
        const [variable] = ampVariableNames([column]);
        return `%%[ SET @rk = ${variable} ]%%${label}%%=v(@rk)=%%\n%%[ SET ${variable} = "" ]%%\n`;
    }
    if (target.startsWith('ampscript-')) {
        return (
            `%%[ SET @rk = "" SET @rc = RowCount(@rows) FOR @j = 1 TO @rc DO SET @rk = Concat(@rk, Field(Row(@rows, @j), "${column}"), ",") NEXT @j SET @rows = "" ]%%` +
            `${label}%%=v(@rk)=%%\n`
        );
    }
    return (
        `<script runat="server">\n` +
        `(function () { var k = []; var r = (typeof rows === "undefined" || rows === null) ? [] : rows;\n` +
        `for (var j = 0; j < r.length; j++) { k.push("" + r[j]["${column}"]); }\n` +
        `Platform.Response.Write("${label}" + k.join(",") + "\\n"); })();\n` +
        `rows = null;\n</script>\n`
    );
}

/**
 * Build the CloudPage for cases[from..to).
 *
 * @param {number} from start index
 * @param {number} to end index (exclusive)
 * @param {string} assetPath file to write
 */
function build(from, to, assetPath) {
    let body = '';
    const plan = [];
    for (const testCase of cases().slice(from, to)) {
        const result = convert(testCase.sql, {
            platform: 'mce',
            direction: 'toCode',
            deName: DE,
            deKey: DE,
        });
        const usable = result.outputs.filter((item) => typeof item.code === 'string');
        for (const output of usable) {
            // Report SubscriberKey when it is selected, otherwise the first selected column.
            const firstColumn = /^SELECT\s+(?:TOP\s+\d+\s+)?\[?([\w ]+?)\]?\s*(?:,|FROM)/iu.exec(
                testCase.sql,
            )[1];
            const column =
                /\bSubscriberKey\b/u.test(testCase.sql.split(/\bFROM\b/iu, 1)[0]) &&
                output.id !== 'ampscript-lookup'
                    ? 'SubscriberKey'
                    : firstColumn;
            body += `\n<!-- ${testCase.id} ${output.id} -->\n${output.code}\n${reporter(testCase.id, output.id, column)}`;
            plan.push(`${testCase.id} ${output.id}`);
        }
    }
    const html = `<!DOCTYPE html>\n<html>\n<body>\n<pre>${body}</pre>\n</body>\n</html>\n`;
    writeFileSync(assetPath, html, 'utf8');
    writeFileSync(path.join(here, '.last-plan.json'), JSON.stringify(plan));
    print(`written ${plan.length} target runs for cases ${from}..${to - 1}`);
}

/**
 * Compare a fetched page body with the expected rows.
 *
 * @param {string} outputFile fetched page body
 */
function check(outputFile) {
    const text = readFileSync(outputFile, 'utf8');
    const byId = new Map(cases().map((testCase) => [testCase.id, testCase]));
    const plan = JSON.parse(readFileSync(path.join(here, '.last-plan.json'), 'utf8'));
    const seen = new Set();
    let pass = 0;
    let fail = 0;
    for (const match of text.matchAll(/^RES (\S+) (\S+)=(.*)$/gmu)) {
        const [, id, target, raw] = match;
        seen.add(`${id} ${target}`);
        const testCase = byId.get(id);
        const keys = raw
            .split(',')
            .map((key) => key.trim())
            .filter(Boolean);
        const orderedTarget = target.includes('ordered');
        const actual =
            orderedTarget && testCase.ordered ? keys.join(',') : sortText(keys).join(',');
        const expected =
            !orderedTarget && testCase.ordered
                ? sortText(testCase.expected.split(',')).join(',')
                : testCase.expected;
        const isTopCase = /\bTOP\b/u.test(testCase.sql) && !orderedTarget;
        // Lookup returns the first match only: its value must be one of the expected values.
        const isLookupCase = target === 'ampscript-lookup';
        const ok =
            isTopCase ||
            (isLookupCase
                ? keys.length === 1 && expectedValues(testCase).includes(keys[0])
                : actual === expected);
        if (ok) {
            pass += 1;
        } else {
            fail += 1;
        }
        print(
            `${ok ? 'PASS' : 'FAIL'} ${id} ${target} -> [${actual}]${ok ? '' : ` expected [${expected}]`}${isTopCase ? ' (TOP dropped: not compared)' : ''}`,
        );
    }
    const missing = plan.filter((entry) => !seen.has(entry));
    print(
        `pass=${pass} fail=${fail} missing=${missing.length}${missing.length ? ` [${missing.join('; ')}]` : ''}`,
    );
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'build') {
    build(Number(rest[0]), Number(rest[1]), rest[2]);
} else if (mode === 'check') {
    check(rest[0]);
} else {
    print('usage: build <from> <to> <assetPath> | check <outputFile>');
}
