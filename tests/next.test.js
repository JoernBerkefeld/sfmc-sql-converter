import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    MCN_TARGETS,
    MESSAGE_CODES,
    NEXT_RULES,
    convert,
    hbString,
    parseAmpscript,
    parseHandlebars,
    normalizeSql,
    printSql,
} from '../src/index.js';

const MO = { dataSource: 'MO' };
const NUMKEY = 'zzprobenumkey__mo';
const COUPONS = 'zzprobecoupons__mo';

/**
 * Converts SQL for Next and returns one output.
 *
 * @param {string} sql query
 * @param {string} id output id
 * @param {object} [options] convert options
 * @returns {object} output
 */
function output(sql, id, options = {}) {
    const result = convert(sql, { platform: 'mcn', ...options });
    const found = result.outputs.find((item) => item.id === id);
    assert.ok(found, `no output ${id}`);
    return found;
}

/**
 * Returns the code of an output that must be available and must round-trip.
 *
 * @param {string} sql query
 * @param {string} id output id
 * @param {object} [options] convert options
 * @returns {string} code
 */
function code(sql, id, options) {
    const item = output(sql, id, options);
    assert.equal(item.unavailable, undefined, `${id}: ${item.unavailable}`);
    assert.equal(item.roundTrip.ok, true, `${id} round trip: ${item.roundTrip.note}`);
    return item.code;
}

/**
 * Returns the reason of an output that must be unavailable.
 *
 * @param {string} sql query
 * @param {string} id output id
 * @param {object} [options] convert options
 * @returns {string} reason
 */
function unavailable(sql, id, options) {
    const item = output(sql, id, options);
    assert.ok(item.unavailable, `${id} should be unavailable, got:\n${item.code}`);
    return item.unavailable;
}

/**
 * Reads Next code back to SQL with convert().
 *
 * @param {string} text code
 * @returns {object} convert result
 */
function toSql(text) {
    return convert(text, { platform: 'mcn', direction: 'toSql' });
}

const CONTACT = 'SELECT LastName, pi__score__c FROM Contact';
const q = 'handlebars-query';
const qf = 'handlebars-queryfirst';
const rso = 'ampscript-rso';
const qmo = 'handlebars-query-mo';
const lrmo = 'ampscript-lookuprows-mo';

const QUERY = 'entries/mcn/mcn-handlebars-email-query.json';
const QUERY_FIRST = 'entries/mcn/mcn-handlebars-email-queryfirst.json';
const RSO = 'entries/mcn/mcn-ampscript-email-retrievesalesforceobjects.json';
const LOOKUP_ROWS = 'entries/mcn/mcn-ampscript-email-lookuprows.json';
const LOOKUP_ORDERED_ROWS = 'entries/mcn/mcn-ampscript-email-lookuporderedrows.json';
const CONCAT = 'entries/mcn/mcn-handlebars-email-concat.json';
const DATA_GRAPH = 'entries/mcn/mcn-handlebars-email-datagraph.json';
const DG = { dataSource: 'DG' };
const dg = 'handlebars-datagraph';
const LINKS = 'UnifiedLinkssotIndividualMkt__dlm';
const DG_EACH = `{{#each (get (get @root "$dataGraph") "${LINKS}")}}`;
const SOURCE_ID = `SELECT SourceRecordId__c FROM ${LINKS}`;

/**
 * Returns the data graph code of a query (must be available and round-trip).
 *
 * @param {string} sql query
 * @returns {string} code
 */
function dgCode(sql) {
    return code(sql, dg, DG);
}

/**
 * Checks that a text contains a part.
 *
 * @param {string} text text
 * @param {string} part expected part
 */
function assertHas(text, part) {
    assert.ok(
        text.includes(part),
        `expected
${part}
in
${text}`,
    );
}

/**
 * One check per proven / disproven verification DB row that `NEXT_RULES` cites.
 */
const DB_ROW_TESTS = {
    [`${QUERY}#checklist[2]`]: () =>
        assert.match(
            code('SELECT TOP 1 Id FROM Contact', q),
            /query type="CRM" object="Contact" fields="Id" limit=1\)/,
        ),
    [`${QUERY}#checklist[3]`]: () =>
        assert.match(
            code(`SELECT CouponCode__c FROM ${COUPONS} WHERE CouponCode__c = 'PROBE0001'`, qmo, MO),
            /\(query type="MO" object="zzprobecoupons__mo" CouponCode__c="PROBE0001"\)/,
        ),
    [`${QUERY}#checklist[4]`]: () =>
        assert.match(
            unavailable(`SELECT CouponCode__c FROM ${COUPONS}`, qmo, MO),
            /needs at least one filter/,
        ),
    [`${QUERY}#checklist[5]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE pi__score__c = 82`, q),
            /where="pi__score__c = :p1" params=\(hash p1=82\)/,
        ),
    [`${QUERY}#checklist[6]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE LastName = 'Blau'`, q),
            /where="LastName = :p1" params=\(hash p1="Blau"\)/,
        ),
    [`${QUERY}#checklist[7]`]: () =>
        assert.match(code(`${CONTACT} WHERE LastName = 'blau'`, q), /p1="blau"/),
    [`${QUERY}#checklist[8]`]: () =>
        assert.match(code(`${CONTACT} WHERE pi__score__c = '82'`, q), /p1="82"/),
    [`${QUERY}#checklist[9]`]: () =>
        assert.match(code(`${CONTACT} WHERE pi__score__c > 300`, q), /where="pi__score__c > :p1"/),
    [`${QUERY}#checklist[10]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE pi__score__c >= 301`, q),
            /where="pi__score__c >= :p1"/,
        ),
    [`${QUERY}#checklist[11]`]: () =>
        assert.match(code(`${CONTACT} WHERE pi__score__c < 35`, q), /where="pi__score__c < :p1"/),
    [`${QUERY}#checklist[12]`]: () =>
        assert.match(code(`${CONTACT} WHERE pi__score__c <= 34`, q), /where="pi__score__c <= :p1"/),
    [`${QUERY}#checklist[13]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE LastName <> 'Adelson' AND pi__score__c > 290`, q),
            /where="LastName != :p1 AND pi__score__c > :p2" params=\(hash p1="Adelson" p2=290\)/,
        ),
    [`${QUERY}#checklist[14]`]: () =>
        assert.match(unavailable(`${CONTACT} WHERE LastName LIKE 'Ro%'`, q), /"contains"/),
    [`${QUERY}#checklist[15]`]: () =>
        assert.match(unavailable(`${CONTACT} WHERE LastName LIKE '%son'`, q), /"contains"/),
    [`${QUERY}#checklist[16]`]: () =>
        assert.match(unavailable(`${CONTACT} WHERE LastName LIKE 'Bl'`, q), /"contains"/),
    [`${QUERY}#checklist[17]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE LastName LIKE '%ennam%'`, q),
            /LastName LIKE :p1" params=\(hash p1="%ennam%"\)/,
        ),
    [`${QUERY}#checklist[18]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE LastName LIKE '%b%' AND pi__score__c > 150`, q),
            /LIKE :p1 AND pi__score__c > :p2/,
        ),
    [`${QUERY}#checklist[19]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE pi__score__c = 27 OR pi__score__c = 345`, q),
            /pi__score__c = :p1 OR pi__score__c = :p2/,
        ),
    [`${QUERY}#checklist[20]`]: () =>
        assert.match(
            code(
                `${CONTACT} WHERE LastName LIKE '%b%' AND (pi__score__c < 50 OR pi__score__c > 200)`,
                q,
            ),
            /LastName LIKE :p1 AND \(pi__score__c < :p2 OR pi__score__c > :p3\)/,
        ),
    [`${QUERY}#checklist[21]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE Birthdate = '1965-07-26'`, q),
            /Birthdate = :p1" params=\(hash p1="1965-07-26"\)/,
        ),
    [`${QUERY}#checklist[22]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE Birthdate > '1988-01-01' AND pi__score__c > 0`, q),
            /params=\(hash p1="1988-01-01" p2=0\)/,
        ),
    [`${QUERY}#checklist[23]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE LastName LIKE '%b%' AND Birthdate < '1963-01-01'`, q),
            /Birthdate < :p2/,
        ),
    [`${QUERY}#checklist[24]`]: () => assertNoLiteralInWhere(`${CONTACT} WHERE LastName = 'Blau'`),
    [`${QUERY}#checklist[25]`]: () => assertNoLiteralInWhere(`${CONTACT} WHERE pi__score__c = 82`),
    [`${QUERY}#checklist[26]`]: () =>
        assertNoLiteralInWhere(`${CONTACT} WHERE LastName = 'Blau' AND pi__score__c = 82`),
    [`${QUERY}#checklist[27]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE pi__score__c > 200 ORDER BY pi__score__c`, q),
            /sortBy="pi__score__c ASC"/,
        ),
    [`${QUERY}#checklist[28]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE pi__score__c > 200 ORDER BY pi__score__c DESC`, q),
            /sortBy="pi__score__c DESC"/,
        ),
    [`${QUERY}#checklist[29]`]: () =>
        assert.match(
            code(
                `SELECT TOP 2 LastName FROM Contact WHERE pi__score__c > 200 ORDER BY pi__score__c`,
                q,
            ),
            /sortBy="pi__score__c ASC" limit=2\)/,
        ),
    [`${QUERY}#checklist[30]`]: () =>
        assert.match(
            code('SELECT LastName FROM Contact WHERE pi__score__c = 82', q),
            /fields="LastName" where=/,
        ),
    [`${QUERY}#checklist[31]`]: () =>
        assert.match(
            unavailable('SELECT * FROM Contact WHERE pi__score__c = 82', q),
            /list the columns/,
        ),
    [`${QUERY}#checklist[32]`]: () =>
        assert.doesNotMatch(
            code(`SELECT CouponCode__c FROM ${COUPONS} WHERE CouponCode__c = 'PROBE0001'`, qmo, MO),
            /where=|params=/,
        ),
    [`${QUERY}#checklist[33]`]: () =>
        assert.doesNotMatch(
            code(
                `SELECT CouponCode__c FROM ${COUPONS} WHERE CouponCode__c = 'PROBE0001' AND IsClaimed__c = 'false'`,
                qmo,
                MO,
            ),
            /where=/,
        ),
    [`${QUERY}#checklist[34]`]: () =>
        unavailable(
            `SELECT CouponCode__c FROM ${COUPONS} WHERE CouponCode__c LIKE '%PROBE%'`,
            qmo,
            MO,
        ),
    [`${QUERY_FIRST}#checklist[2]`]: () =>
        assert.match(
            code('SELECT TOP 1 Id FROM Contact', qf),
            /^\{\{get \(queryFirst type="CRM" object="Contact" fields="Id"\) "Id"\}\}$/,
        ),
    [`${QUERY_FIRST}#checklist[3]`]: () => {
        const back = toSql(
            `{{get (queryFirst type="MO" object="${COUPONS}" CouponCode__c="PROBE0001") "IsClaimed__c"}}`,
        );
        assert.equal(
            back.outputs[0].code,
            `SELECT TOP 1 IsClaimed__c\nFROM ${COUPONS}\nWHERE CouponCode__c = 'PROBE0001'`,
        );
    },
    [`${QUERY_FIRST}#checklist[4]`]: () => {
        const back = parseHandlebars(
            `{{get (queryFirst object="${COUPONS}" type="MO") "CouponCode__c"}}`,
        );
        assert.equal(back.ast, null);
        assert.equal(back.messages[0].code, MESSAGE_CODES.INVALID_FILTER);
    },
    [`${QUERY_FIRST}#checklist[5]`]: () =>
        assert.match(
            code('SELECT TOP 1 LastName FROM Contact WHERE pi__score__c = 82', qf),
            /where="pi__score__c = :p1" params=\(hash p1=82\)\) "LastName"\}\}/,
        ),
    [`${QUERY_FIRST}#checklist[6]`]: () =>
        assert.match(
            code(
                'SELECT TOP 1 LastName FROM Contact WHERE pi__score__c > 200 ORDER BY pi__score__c DESC',
                qf,
            ),
            /sortBy="pi__score__c DESC"\) "LastName"/,
        ),
    [`${QUERY_FIRST}#checklist[7]`]: () =>
        assert.match(
            code(
                'SELECT TOP 1 LastName FROM Contact WHERE pi__score__c > 200 ORDER BY pi__score__c',
                qf,
            ),
            /sortBy="pi__score__c ASC"\) "LastName"/,
        ),
    [`${QUERY_FIRST}#checklist[8]`]: () => {
        const item = output('SELECT TOP 1 LastName FROM Contact WHERE pi__score__c = 1', qf);
        assert.ok(
            item.messages.some((message) => message.code === MESSAGE_CODES.LOOKUP_FIRST_ROW_ONLY),
        );
    },
    [`${RSO}#checklist[2]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE Id = '000000000000000AAA'`, rso),
            /SET @rowCount = RowCount\(@rows\)/,
        ),
    [`${RSO}#checklist[3]`]: () =>
        assert.doesNotMatch(code(`${CONTACT} WHERE Id = '000000000000000AAA'`, rso), /Empty\(/),
    [`${RSO}#checklist[4]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE IsDeleted = 'false'`, rso),
            /Row\(@rows, @i\)[\s\S]*Field\(@row, "LastName"\)/,
        ),
    [`${RSO}#checklist[6]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE pi__score__c = 82`, rso),
            /"pi__score__c", "=", "82"\)/,
        ),
    [`${RSO}#checklist[7]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE pi__score__c > 300`, rso),
            /"pi__score__c", ">", "300"/,
        ),
    [`${RSO}#checklist[8]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE pi__score__c >= 301`, rso),
            /"pi__score__c", ">=", "301"/,
        ),
    [`${RSO}#checklist[9]`]: () => {
        assert.doesNotMatch(code(`${CONTACT} WHERE pi__score__c < 35`, rso), /Char\(|Concat\(/);
        const back = parseAmpscript(
            'SET @r = RetrieveSalesforceObjects("Contact","LastName","pi__score__c",Char(60),"35")',
            { platform: 'mcn' },
        );
        assert.equal(back.messages[0].code, MESSAGE_CODES.UNSUPPORTED_EXPRESSION);
    },
    [`${RSO}#checklist[11]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE pi__score__c > 290 AND LastName <> 'Adelson'`, rso),
            /"pi__score__c", ">", "290", "LastName", "!=", "Adelson"\)/,
        ),
    [`${RSO}#checklist[12]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE LastName = 'Blau' AND pi__score__c = 94`, rso),
            /"LastName", "=", "Blau", "pi__score__c", "=", "94"\)/,
        ),
    [`${RSO}#checklist[13]`]: () =>
        assert.match(unavailable(`${CONTACT} WHERE LastName LIKE 'Ro%'`, rso), /"contains"/),
    [`${RSO}#checklist[14]`]: () =>
        assert.match(unavailable(`${CONTACT} WHERE LastName LIKE 'Bl'`, rso), /"contains"/),
    [`${RSO}#checklist[15]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE LastName LIKE '%Bl%'`, rso),
            /"LastName", "LIKE", "%Bl%"\)/,
        ),
    [`${RSO}#checklist[16]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE Birthdate = '1965-07-26'`, rso),
            /"Birthdate", "=", "1965-07-26"\)/,
        ),
    [`${RSO}#checklist[17]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE pi__score__c < 35`, rso),
            /"pi__score__c", "<", "35"\)/,
        ),
    [`${RSO}#checklist[18]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE pi__score__c <= 34`, rso),
            /"pi__score__c", "<=", "34"\)/,
        ),
    [`${LOOKUP_ROWS}#checklist[0]`]: () =>
        code(`SELECT CouponCode__c FROM ${COUPONS} WHERE CouponCode__c = 'v'`, lrmo, MO),
    [`${LOOKUP_ROWS}#checklist[2]`]: () =>
        assert.match(
            code(
                `SELECT CouponCode__c FROM ${COUPONS} WHERE CouponCode__c = 'PROBE0001'`,
                lrmo,
                MO,
            ),
            /LookupRows\("zzprobecoupons__mo", "CouponCode__c", "PROBE0001"\)[\s\S]*Field\(@row, "CouponCode__c"\)/,
        ),
    [`${LOOKUP_ROWS}#checklist[3]`]: () =>
        assert.match(
            code(`SELECT CouponCode__c FROM ${COUPONS} WHERE CouponCode__c = 'NOPE0000'`, lrmo, MO),
            /RowCount\(@rows\)/,
        ),
    [`${LOOKUP_ROWS}#checklist[4]`]: () =>
        assert.match(
            code(`SELECT CouponCode__c FROM ${COUPONS} WHERE IsClaimed__c = 'false'`, lrmo, MO),
            /"IsClaimed__c", "false"\)/,
        ),
    [`${LOOKUP_ORDERED_ROWS}#checklist[2]`]: () =>
        unavailable(
            `SELECT TOP 5 CouponCode__c FROM ${COUPONS} WHERE CouponCode__c = 'PROBE0001' ORDER BY CouponCode__c DESC`,
            lrmo,
            MO,
        ),
    [`${LOOKUP_ORDERED_ROWS}#checklist[3]`]: () =>
        unavailable(
            `SELECT CouponCode__c FROM ${COUPONS} WHERE CouponCode__c = 'PROBE0001' ORDER BY CouponCode__c`,
            lrmo,
            MO,
        ),
    [`${LOOKUP_ORDERED_ROWS}#checklist[4]`]: () =>
        unavailable(
            `SELECT TOP 1 CouponCode__c FROM ${COUPONS} WHERE IsClaimed__c = 'false' ORDER BY CouponCode__c DESC`,
            lrmo,
            MO,
        ),
    [`${LOOKUP_ORDERED_ROWS}#checklist[5]`]: () => {
        const back = toSql(
            `%%[ SET @r = LookupOrderedRows("${COUPONS}",1,"CouponCode__c","CouponCode__c","PROBE0001") ]%%`,
        );
        assert.equal(back.messages[0].code, MESSAGE_CODES.UNSUPPORTED_EXPRESSION);
    },
    [`${LOOKUP_ORDERED_ROWS}#checklist[6]`]: () => {
        const back = toSql(
            `%%[ SET @r = LookupOrderedRows("${COUPONS}",1,"IsClaimed__c desc","CouponCode__c","PROBE0001") ]%%`,
        );
        assert.match(back.messages[0].message, /fails in Marketing Cloud Next/);
    },
    // it5 (2026-11-26): converter output rendered live
    [`${QUERY}#checklist[41]`]: () =>
        assert.equal(
            code(
                `SELECT TOP 2 ${CONTACT.slice(7)} WHERE LastName LIKE '%b%' AND (pi__score__c < 50 OR pi__score__c > 200) ORDER BY LastName DESC`,
                q,
            ),
            '{{#each (query type="CRM" object="Contact" fields="LastName,pi__score__c" where="LastName LIKE :p1 AND (pi__score__c < :p2 OR pi__score__c > :p3)" params=(hash p1="%b%" p2=50 p3=200) sortBy="LastName DESC" limit=2)}}\n    {{LastName}}\n    {{pi__score__c}}\n{{/each}}',
        ),
    [`${QUERY}#checklist[42]`]: () =>
        assert.equal(
            code('SELECT TOP 3 FirstName, LastName FROM Contact ORDER BY LastName DESC', q),
            '{{#each (query type="CRM" object="Contact" fields="FirstName,LastName" sortBy="LastName DESC" limit=3)}}\n    {{FirstName}}\n    {{LastName}}\n{{/each}}',
        ),
    [`${QUERY}#checklist[43]`]: () =>
        assert.match(
            code("SELECT LastName FROM Contact WHERE LastName = 'O''Brien Jr'", q),
            /params=\(hash p1="O'Brien Jr"\)/,
        ),
    [`${QUERY}#checklist[44]`]: () =>
        assert.match(
            code(
                `SELECT LastName FROM Contact WHERE LastName <> 'O"Brien' AND LastName LIKE '%Brien%'`,
                q,
            ),
            /params=\(hash p1="O\\"Brien" p2="%Brien%"\)/,
        ),
    [`${QUERY}#checklist[45]`]: () =>
        assert.match(
            code(String.raw`SELECT LastName FROM Contact WHERE LastName = 'back\slash'`, q),
            /params=\(hash p1="back\\slash"\)/,
        ),
    [`${QUERY}#checklist[46]`]: () =>
        assert.match(
            code(`${CONTACT} WHERE pi__score__c > -2.5 AND pi__score__c < 34.5`, q),
            /params=\(hash p1=-2\.5 p2=34\.5\)/,
        ),
    [`${QUERY}#checklist[49]`]: () =>
        assert.equal(
            code(
                `SELECT CouponCode__c, IsClaimed__c FROM ${COUPONS} WHERE CouponCode__c = 'PROBE0001'`,
                qmo,
                MO,
            ),
            '{{#each (query type="MO" object="zzprobecoupons__mo" CouponCode__c="PROBE0001")}}\n    {{CouponCode__c}}\n    {{IsClaimed__c}}\n{{/each}}',
        ),
    [`${QUERY_FIRST}#checklist[20]`]: () =>
        assert.equal(
            code(
                "SELECT TOP 1 LastName FROM Contact WHERE LastName LIKE '%b%' AND pi__score__c > 100 ORDER BY pi__score__c DESC",
                qf,
            ),
            '{{get (queryFirst type="CRM" object="Contact" fields="LastName" where="LastName LIKE :p1 AND pi__score__c > :p2" params=(hash p1="%b%" p2=100) sortBy="pi__score__c DESC") "LastName"}}',
        ),
    [`${RSO}#checklist[21]`]: () =>
        assert.match(
            code("SELECT LastName FROM Contact WHERE LastName LIKE '%ro%'", rso),
            /RetrieveSalesforceObjects\("Contact", "LastName", "LastName", "LIKE", "%ro%"\)\nSET @rowCount = RowCount\(@rows\)\nFOR @i = 1 TO @rowCount DO\n/,
        ),
    [`${RSO}#checklist[22]`]: () =>
        assert.match(
            unavailable(
                "SELECT LastName FROM Contact WHERE LastName <> 'Phillips' AND pi__score__c < 60 AND pi__score__c > 30",
                rso,
            ),
            /same field is used in two conditions \(pi__score__c\)/,
        ),
    [`${RSO}#checklist[23]`]: () =>
        assert.match(
            code(
                "SELECT LastName FROM Contact WHERE LastName <> 'Phillips' AND pi__score__c < 60",
                rso,
            ),
            /"LastName", "!=", "Phillips", "pi__score__c", "<", "60"\)/,
        ),
    [`${RSO}#checklist[24]`]: () =>
        assert.match(
            unavailable(
                'SELECT LastName FROM Contact WHERE pi__score__c < 60 AND PI__SCORE__C > 30',
                rso,
            ),
            /same field is used in two conditions/,
        ),
    [`${RSO}#checklist[25]`]: () =>
        assert.match(
            code(
                "SELECT LastName FROM Contact WHERE LastName <> 'Phillips' AND pi__score__c < 60 AND FirstName LIKE '%a%'",
                rso,
            ),
            /"LastName", "!=", "Phillips", "pi__score__c", "<", "60", "FirstName", "LIKE", "%a%"\)/,
        ),
    [`${RSO}#checklist[26]`]: () =>
        assert.match(
            code(
                "SELECT LastName FROM Contact WHERE LastName = 'Brennaman' AND pi__score__c = 40 AND FirstName = 'Jason'",
                rso,
            ),
            /"LastName", "=", "Brennaman", "pi__score__c", "=", "40", "FirstName", "=", "Jason"\)/,
        ),
    [`${LOOKUP_ROWS}#checklist[7]`]: () =>
        assert.match(
            code(
                `SELECT CouponCode__c, IsClaimed__c FROM ${COUPONS} WHERE CouponCode__c = 'PROBE0001' AND IsClaimed__c = 'false'`,
                lrmo,
                MO,
            ),
            /LookupRows\("zzprobecoupons__mo", "CouponCode__c", "PROBE0001", "IsClaimed__c", "false"\)/,
        ),
    [`${LOOKUP_ROWS}#checklist[8]`]: () =>
        assert.match(
            code(
                `SELECT CouponCode__c FROM ${COUPONS} WHERE CouponCode__c = 'PROBE0001' AND IsClaimed__c = 'true'`,
                lrmo,
                MO,
            ),
            /"CouponCode__c", "PROBE0001", "IsClaimed__c", "true"\)/,
        ),
    [`${LOOKUP_ROWS}#checklist[9]`]: () =>
        assert.match(
            code(
                `SELECT CouponCode__c, IsClaimed__c FROM ${COUPONS} WHERE CouponCode__c = 'PROBE0001'`,
                lrmo,
                MO,
            ),
            /^%%\[\n\/\* SQL: SELECT CouponCode__c, IsClaimed__c \*\/\nSET @rows = LookupRows\([^\n]*\)\nSET @rowCount = RowCount\(@rows\)\nFOR @i = 1 TO @rowCount DO\n {4}SET @row = Row\(@rows, @i\)\n {4}SET @CouponCode__c = Field\(@row, "CouponCode__c"\)\n {4}SET @IsClaimed__c = Field\(@row, "IsClaimed__c"\)\nNEXT @i\n\]%%$/,
        ),
    [`${CONCAT}#checklist[1]`]: () => {
        assert.equal(hbString('O"Brien'), String.raw`"O\"Brien"`);
        assert.equal(hbString("O'Brien"), `"O'Brien"`);
        assert.equal(hbString(String.raw`back\slash`), String.raw`"back\slash"`);
    },
    [`${QUERY}#checklist[50]`]: () =>
        assert.match(
            code(`SELECT CouponNo__c, Label__c FROM ${NUMKEY} WHERE CouponNo__c = 7`, qmo, MO),
            /\(query type="MO" object="zzprobenumkey__mo" CouponNo__c=7\)/,
        ),
    [`${QUERY}#checklist[51]`]: () =>
        assert.match(
            code(`SELECT Label__c FROM ${NUMKEY} WHERE CouponNo__c = '7'`, qmo, MO),
            /CouponNo__c="7"\)/,
        ),
    [`${QUERY}#checklist[52]`]: () =>
        assert.match(
            code(`SELECT Label__c FROM ${NUMKEY} WHERE CouponNo__c = 99`, qmo, MO),
            /\{\{#each \(query/,
        ),
    [`${QUERY}#checklist[53]`]: () =>
        assert.match(
            code(`SELECT Label__c FROM ${NUMKEY} WHERE Points__c = 7`, qmo, MO),
            /object="zzprobenumkey__mo" Points__c=7\)/,
        ),
    [`${QUERY}#checklist[54]`]: () =>
        assert.match(
            code(
                `SELECT Label__c FROM ${NUMKEY} WHERE CouponNo__c = 7 AND Points__c = 70`,
                qmo,
                MO,
            ),
            /CouponNo__c=7 Points__c=70\)/,
        ),
    [`${QUERY}#checklist[55]`]: () =>
        assert.match(
            code(`SELECT CouponNo__c FROM ${NUMKEY} WHERE Label__c = 'twelve'`, qmo, MO),
            /Label__c="twelve"\)/,
        ),
    [`${QUERY}#checklist[57]`]: () =>
        assert.match(
            code(`SELECT CouponNo__c FROM ${NUMKEY} WHERE Points__c = 80.0`, qmo, MO),
            /Points__c=80\.0\)/,
        ),
    [`${QUERY}#checklist[60]`]: () =>
        assert.match(
            code(`SELECT TOP 1 Label__c FROM ${NUMKEY} WHERE Label__c = 'group'`, qmo, MO),
            /Label__c="group" limit=1\)/,
        ),
    [`${QUERY}#checklist[61]`]: () =>
        assert.match(
            unavailable(
                `SELECT CouponNo__c FROM ${NUMKEY} WHERE Label__c = 'group' ORDER BY Points__c DESC`,
                qmo,
                MO,
            ),
            /can't sort/,
        ),
    [`${QUERY}#checklist[62]`]: () =>
        assert.ok(
            output(
                `SELECT CouponNo__c FROM ${NUMKEY} WHERE Label__c = 'group'`,
                qmo,
                MO,
            ).messages.some((message) => message.code === MESSAGE_CODES.MO_ONE_MATCH),
        ),
    [`${QUERY}#checklist[64]`]: () =>
        assert.match(code(`${CONTACT} WHERE LastName <> 'Chopra'`, q), /LastName != :p1/),
    [`${QUERY}#checklist[66]`]: () =>
        assert.ok(output(`${CONTACT} ORDER BY LastName, FirstName`, q).unavailable),
    [`${QUERY}#checklist[69]`]: () =>
        assert.match(
            unavailable(`${CONTACT} WHERE LastName IN ('Brown', 'Blau')`, q),
            /IN is not supported/,
        ),
    [`${QUERY}#checklist[70]`]: () =>
        assert.match(
            unavailable(`${CONTACT} WHERE LastName NOT IN ('Brown', 'Blau')`, q),
            /NOT IN is not supported/,
        ),
    [`${QUERY}#checklist[71]`]: () =>
        assert.ok(
            convert(`${CONTACT} WHERE NOT (LastName = 'Chopra')`, {
                platform: 'mcn',
            }).outputs.every((item) => item.unavailable !== undefined),
        ),
    [`${QUERY_FIRST}#checklist[21]`]: () => {
        const back = toSql(
            `{{get (queryFirst type="MO" object="${NUMKEY}" CouponNo__c=12) "Label__c"}}`,
        );
        assert.equal(
            back.outputs[0].code,
            `SELECT TOP 1 Label__c\nFROM ${NUMKEY}\nWHERE CouponNo__c = 12`,
        );
    },
    [`${QUERY_FIRST}#checklist[22]`]: () => {
        const back = toSql(
            `{{get (queryFirst type="MO" object="${NUMKEY}" Label__c="seventy") "CouponNo__c"}}`,
        );
        assert.equal(
            back.outputs[0].code,
            `SELECT TOP 1 CouponNo__c\nFROM ${NUMKEY}\nWHERE Label__c = 'seventy'`,
        );
    },
    [`${QUERY_FIRST}#checklist[23]`]: () => {
        const back = parseHandlebars(
            `{{get (queryFirst type="MO" object="${NUMKEY}" Label__c="group" sortBy="Points__c DESC") "CouponNo__c"}}`,
        );
        assert.equal(back.ast, null);
        assert.equal(back.messages[0].code, MESSAGE_CODES.INVALID_ARGUMENT);
    },
    [`${LOOKUP_ROWS}#checklist[15]`]: () =>
        assert.ok(
            output(
                `SELECT CouponNo__c FROM ${NUMKEY} WHERE Label__c = 'group'`,
                lrmo,
                MO,
            ).messages.some((message) => message.code === MESSAGE_CODES.MO_ONE_MATCH),
        ),
    [`${LOOKUP_ROWS}#checklist[16]`]: () => {
        assert.match(
            unavailable(
                `SELECT Label__c FROM ${NUMKEY} WHERE CouponNo__c = 8 AND CouponNo__c = 9`,
                lrmo,
                MO,
            ),
            /only the last pair/,
        );
        const back = parseAmpscript(
            `%%[ SET @r = LookupRows("${NUMKEY}", "CouponNo__c", "8", "CouponNo__c", "9") ]%%`,
            { platform: 'mcn' },
        );
        assert.equal(back.ast, null);
        assert.equal(back.messages[0].code, MESSAGE_CODES.INVALID_FILTER);
    },
    // it2 (2026-11-26): data graph, Email Builder preview
    [`${DATA_GRAPH}#checklist[3]`]: () =>
        assert.ok(dgCode(`SELECT SourceRecordId__c FROM ${LINKS}`).startsWith(DG_EACH)),
    [`${DATA_GRAPH}#checklist[19]`]: () =>
        assertHas(
            dgCode('SELECT ssot__EmailAddress__c FROM ssot__ContactPointEmail__dlm'),
            '"$dataGraph") "ssot__ContactPointEmail__dlm")}}\n    {{ssot__EmailAddress__c}}',
        ),
    [`${DATA_GRAPH}#checklist[4]`]: () =>
        assertHas(
            dgCode(`${SOURCE_ID} WHERE ssot__DataSourceObjectId__c = 'Contact'`),
            '{{#if (compare ssot__DataSourceObjectId__c "==" "Contact")}}',
        ),
    [`${DATA_GRAPH}#checklist[5]`]: () =>
        assertHas(
            dgCode(`${SOURCE_ID} WHERE ssot__DataSourceObjectId__c <> 'Contact'`),
            '(compare ssot__DataSourceObjectId__c "!=" "Contact")',
        ),
    [`${DATA_GRAPH}#checklist[6]`]: () =>
        assertHas(
            dgCode(
                `${SOURCE_ID} WHERE ssot__DataSourceObjectId__c = 'Contact' AND SourceRecordId__c = '003aj0000257xPlAAI'`,
            ),
            '{{#if (and (compare ssot__DataSourceObjectId__c "==" "Contact") (compare SourceRecordId__c "==" "003aj0000257xPlAAI"))}}',
        ),
    [`${DATA_GRAPH}#checklist[7]`]: () =>
        assertHas(
            dgCode(
                `${SOURCE_ID} WHERE ssot__DataSourceObjectId__c = 'Contact' OR ssot__DataSourceObjectId__c = 'Lead'`,
            ),
            '{{#if (or (compare ssot__DataSourceObjectId__c "==" "Contact") (compare ssot__DataSourceObjectId__c "==" "Lead"))}}',
        ),
    [`${DATA_GRAPH}#checklist[10]`]: () =>
        assertHas(
            dgCode(`${SOURCE_ID} WHERE ssot__DataSourceObjectId__c > 'D'`),
            '(compare ssot__DataSourceObjectId__c ">" "D")',
        ),
    [`${DATA_GRAPH}#checklist[9]`]: () => {
        const item = output(`${SOURCE_ID} WHERE ssot__DataSourceObjectId__c = 'contact'`, dg, DG);
        const scope = item.messages.find(
            (message) => message.code === MESSAGE_CODES.DATA_GRAPH_SCOPE,
        );
        assert.match(scope.message, /case-sensitive/);
    },
    [`${DATA_GRAPH}#checklist[11]`]: () =>
        assertHas(
            dgCode(`${SOURCE_ID} ORDER BY SourceRecordId__c`),
            `(sort (get (get @root "$dataGraph") "${LINKS}") "SourceRecordId__c" "asc" "string")`,
        ),
    [`${DATA_GRAPH}#checklist[12]`]: () =>
        assertHas(
            dgCode(`${SOURCE_ID} ORDER BY SourceRecordId__c DESC`),
            '"SourceRecordId__c" "desc" "string")',
        ),
    [`${DATA_GRAPH}#checklist[13]`]: () =>
        assert.ok(
            dgCode(`SELECT TOP 1 SourceRecordId__c FROM ${LINKS}`).startsWith(
                `{{#each (slice (get (get @root "$dataGraph") "${LINKS}") 0 1)}}`,
            ),
        ),
    [`${DATA_GRAPH}#checklist[14]`]: () =>
        assert.ok(
            dgCode(
                `SELECT TOP 1 SourceRecordId__c FROM ${LINKS} ORDER BY SourceRecordId__c`,
            ).startsWith(
                `{{#each (slice (sort (get (get @root "$dataGraph") "${LINKS}") "SourceRecordId__c" "asc" "string") 0 1)}}`,
            ),
        ),
    [`${DATA_GRAPH}#checklist[17]`]: () =>
        assert.ok(
            !dgCode(`${SOURCE_ID} WHERE ssot__DataSourceObjectId__c = 'Contact'`).includes(
                '(filter ',
            ),
        ),
    [`${DATA_GRAPH}#checklist[18]`]: () => {
        const back = toSql(
            `{{#each (filter (get (get @root "$dataGraph") "${LINKS}") "ssot__DataSourceObjectId__c" "==" "Contact")}}{{SourceRecordId__c}}{{/each}}`,
        );
        assert.equal(back.messages[0].code, MESSAGE_CODES.INVALID_ARGUMENT);
    },
};

/**
 * Checks that the where of the Handlebars query holds placeholders only, no literal values.
 *
 * @param {string} sql query
 */
function assertNoLiteralInWhere(sql) {
    const where = /where="([^"]*)"/.exec(code(sql, q))[1];
    assert.doesNotMatch(where, /'|(?<![\w:])\d/);
}

describe('NEXT_RULES ↔ verification DB', () => {
    const cited = new Set(Object.values(NEXT_RULES).flatMap((rule) => rule.db));

    it('every cited DB row has a test, and every test cites a row', () => {
        assert.deepEqual(
            [...cited].toSorted((a, b) => a.localeCompare(b)),
            Object.keys(DB_ROW_TESTS).toSorted((a, b) => a.localeCompare(b)),
        );
    });

    it('every rule has a value and a db list', () => {
        for (const [name, rule] of Object.entries(NEXT_RULES)) {
            assert.ok('value' in rule && Array.isArray(rule.db), name);
        }
    });

    for (const [reference, check] of Object.entries(DB_ROW_TESTS)) {
        it(reference.replace('entries/mcn/', ''), check);
    }
});

describe('Next targets', () => {
    it('MCN_TARGETS has one entry per emitter with a data source', () => {
        assert.deepEqual(
            MCN_TARGETS.map((target) => [target.id, target.dataSource]),
            [
                ['handlebars-query', 'CRM'],
                ['handlebars-queryfirst', 'CRM'],
                ['ampscript-rso', 'CRM'],
                ['handlebars-query-mo', 'MO'],
                ['ampscript-lookuprows-mo', 'MO'],
                ['handlebars-datagraph', 'DG'],
            ],
        );
        for (const target of MCN_TARGETS) {
            assert.equal(typeof target.emit, 'function');
        }
    });

    it('emits the exact CRM query shape', () => {
        assert.equal(
            code(`${CONTACT} WHERE pi__score__c > 300 ORDER BY pi__score__c`, q),
            '{{#each (query type="CRM" object="Contact" fields="LastName,pi__score__c" where="pi__score__c > :p1" params=(hash p1=300) sortBy="pi__score__c ASC")}}\n    {{LastName}}\n    {{pi__score__c}}\n{{/each}}',
        );
    });

    it('emits the exact RetrieveSalesforceObjects shape', () => {
        assert.equal(
            code(`${CONTACT} WHERE pi__score__c > 290`, rso),
            [
                '%%[',
                'SET @rows = RetrieveSalesforceObjects("Contact", "LastName,pi__score__c", "pi__score__c", ">", "290")',
                'SET @rowCount = RowCount(@rows)',
                'FOR @i = 1 TO @rowCount DO',
                '    SET @row = Row(@rows, @i)',
                '    SET @LastName = Field(@row, "LastName")',
                '    SET @pi__score__c = Field(@row, "pi__score__c")',
                'NEXT @i',
                ']%%',
            ].join('\n'),
        );
    });

    it('a CRM query without WHERE has no where / params', () => {
        assert.equal(
            code('SELECT LastName FROM Contact', q),
            '{{#each (query type="CRM" object="Contact" fields="LastName")}}\n    {{LastName}}\n{{/each}}',
        );
        assert.match(unavailable('SELECT LastName FROM Contact', rso), /at least one condition/);
    });

    it('records clause spans in the generated code', () => {
        const item = output(`${CONTACT} WHERE pi__score__c > 300`, q);
        const text = (clauseId) =>
            item.spans
                .filter((span) => span.clauseId === clauseId)
                .map((span) => item.code.slice(span.start, span.end));
        assert.deepEqual(text('from'), ['"Contact"']);
        assert.deepEqual(text('column-1'), ['pi__score__c']);
        assert.deepEqual(text('where-0'), ['pi__score__c > :p1', 'p1=300']);
    });

    it('IN, NOT IN and BETWEEN are unavailable with a rewrite hint', () => {
        assert.match(unavailable(`${CONTACT} WHERE LastName IN ('a', 'b')`, q), /OR/);
        assert.match(unavailable(`${CONTACT} WHERE LastName NOT IN ('a', 'b')`, q), /AND/);
        assert.match(unavailable(`${CONTACT} WHERE pi__score__c BETWEEN 1 AND 5`, q), />= low AND/);
    });

    it('IS NULL / IS NOT NULL are unavailable on every target', () => {
        for (const id of [q, qf, rso]) {
            unavailable(`SELECT LastName FROM Contact WHERE Email IS NULL`, id);
            unavailable(`SELECT LastName FROM Contact WHERE Email IS NOT NULL`, id);
        }
    });

    it('the ISNULL rewrite with OR + IS NULL is unavailable on every Next target', () => {
        const sql = "SELECT LastName FROM Contact WHERE ISNULL(LastName, 'x') = 'x'";
        for (const id of [q, qf, rso]) {
            unavailable(sql, id);
        }
        const moSql = `SELECT CouponCode__c FROM ${COUPONS} WHERE ISNULL(CouponCode__c, 'x') = 'x'`;
        for (const id of [qmo, lrmo]) {
            unavailable(moSql, id, MO);
        }
    });

    it('an ISNULL rewrite without OR stays available', () => {
        code("SELECT LastName FROM Contact WHERE ISNULL(LastName, 'x') = 'y'", q);
    });

    it('LIKE patterns with _ or [ ] inside are unavailable', () => {
        unavailable(`${CONTACT} WHERE LastName LIKE '%a_b%'`, q);
        unavailable(`${CONTACT} WHERE LastName LIKE '%[ab]%'`, q);
        unavailable(`${CONTACT} WHERE LastName LIKE '%a%b%'`, q);
    });

    it('sorts by one field only', () => {
        assert.match(
            unavailable(
                `${CONTACT} WHERE pi__score__c > 1 ORDER BY LastName, pi__score__c DESC`,
                q,
            ),
            /one field/,
        );
    });

    it('rejects names that are not API names', () => {
        assert.match(unavailable('SELECT [Last Name] FROM Contact', q), /API name/);
        assert.match(unavailable("SELECT A FROM [My Object] WHERE B = 'x'", rso), /API name/);
    });

    it('queryFirst needs one column; another TOP is dropped with a warning', () => {
        assert.match(unavailable(`${CONTACT} WHERE pi__score__c = 82`, qf), /single field/);
        const item = output('SELECT TOP 5 LastName FROM Contact WHERE pi__score__c = 82', qf);
        assert.deepEqual(item.dropped, ['top']);
        assert.ok(item.messages.some((message) => message.code === MESSAGE_CODES.TOP_DROPPED));
        assert.equal(item.roundTrip.ok, true);
        assert.equal(
            code('SELECT LastName FROM Contact WHERE pi__score__c = 82', qf).includes('queryFirst'),
            true,
        );
    });

    it('a marketing object query filters on any fields with AND, limit, no OR / ORDER BY', () => {
        assert.match(
            code(`SELECT TOP 3 CouponCode__c FROM ${COUPONS} WHERE CouponCode__c = 'x'`, qmo, MO),
            /CouponCode__c="x" limit=3\)/,
        );
        unavailable(`SELECT CouponCode__c FROM ${COUPONS} WHERE A = 1 OR B = 2`, qmo, MO);
        unavailable(`SELECT CouponCode__c FROM ${COUPONS} WHERE A > 1`, qmo, MO);
        assert.match(
            unavailable(`SELECT CouponCode__c FROM ${COUPONS} WHERE A = 1 AND A = 2`, qmo, MO),
            /each field once/,
        );
        assert.match(
            code(`SELECT CouponCode__c FROM ${COUPONS} WHERE CouponCode__c = 7`, qmo, MO),
            /CouponCode__c=7\)/,
        );
    });

    it('LookupRows on a marketing object takes equals + AND only and SELECT *', () => {
        unavailable(`SELECT * FROM ${COUPONS} WHERE A > 1`, lrmo, MO);
        unavailable(`SELECT * FROM ${COUPONS} WHERE A = 1 OR B = 2`, lrmo, MO);
        code(`SELECT * FROM ${COUPONS} WHERE A = 1 AND B = 'x'`, lrmo, MO);
    });

    it('AMPscript targets refuse %% in a value', () => {
        assert.match(unavailable(`${CONTACT} WHERE LastName = 'a%%b'`, rso), /%%/);
    });
});

describe('Handlebars strings', () => {
    it('escapes double quotes only', () => {
        assert.equal(hbString(String.raw`a"b'c\d`), String.raw`"a\"b'c\d"`);
    });

    for (const value of [`O"Brien`, "O'Brien", String.raw`back\slash`, String.raw`quote\"mix`]) {
        it(`round-trips ${value}`, () => {
            const sql = `SELECT LastName FROM Contact WHERE LastName = '${value.replaceAll("'", "''")}'`;
            const generated = code(sql, q);
            const back = toSql(generated);
            assert.equal(back.roundTrip.ok, true);
            assert.match(
                back.outputs[0].code,
                new RegExp(`LastName = '${value.replaceAll("'", "''").replaceAll('\\', '\\\\')}'`),
            );
        });
    }

    it('a value ending with a backslash is unavailable', () => {
        assert.match(
            unavailable(String.raw`SELECT LastName FROM Contact WHERE LastName = 'a\'`, q),
            /backslash/,
        );
    });
});

describe('Next round trip (SQL → code → SQL)', () => {
    const crm = [
        `${CONTACT} WHERE pi__score__c = 82`,
        `${CONTACT} WHERE LastName = 'Blau' AND pi__score__c > -2.5`,
        `${CONTACT} WHERE (LastName = 'a' OR LastName = 'b') AND pi__score__c <= 10`,
        `${CONTACT} WHERE LastName = 'a' OR LastName = 'b' AND pi__score__c >= 1`,
        `SELECT TOP 3 LastName FROM Contact WHERE LastName LIKE '%x%' ORDER BY LastName DESC`,
        "SELECT TOP 1 LastName FROM Contact WHERE Birthdate < '2000-01-01' ORDER BY Birthdate",
    ];
    for (const sql of crm) {
        it(sql, () => {
            const result = convert(sql, { platform: 'mcn' });
            const available = result.outputs.filter((item) => item.code);
            assert.ok(available.length > 0);
            for (const item of available) {
                assert.equal(item.roundTrip.ok, true, `${item.id}: ${item.roundTrip.note}`);
                const back = toSql(item.code);
                assert.equal(back.roundTrip.ok, true, item.id);
            }
        });
    }
});

describe('parseHandlebars — errors', () => {
    const cases = [
        ['', MESSAGE_CODES.EMPTY_INPUT],
        ['<p>hello</p>', MESSAGE_CODES.NO_LOOKUP_FOUND],
        [
            `{{#each (query type="CRM" object="Contact" fields="LastName" where="LastName = 'Blau'")}}{{/each}}`,
            MESSAGE_CODES.INVALID_FILTER_VALUE,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="LastName" where="pi__score__c = 82")}}{{/each}}',
            MESSAGE_CODES.INVALID_FILTER_VALUE,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="LastName" where="LastName = :n")}}{{/each}}',
            MESSAGE_CODES.INVALID_FILTER,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="LastName" where="LastName = :n" params=(hash m="x"))}}{{/each}}',
            MESSAGE_CODES.INVALID_FILTER,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="LastName" where="LastName = :n OR FirstName = :n" params=(hash n="x"))}}{{/each}}',
            MESSAGE_CODES.INVALID_FILTER,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="LastName" where="LastName = :n" params=(hash n="x" m="y"))}}{{/each}}',
            MESSAGE_CODES.INVALID_FILTER,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="LastName" params=(hash n="x"))}}{{/each}}',
            MESSAGE_CODES.INVALID_FILTER,
        ],
        ['{{#each (query type="CRM" object="Contact")}}{{/each}}', MESSAGE_CODES.INVALID_ARGUMENT],
        [
            '{{#each (query type="DG" object="Contact" fields="A")}}{{/each}}',
            MESSAGE_CODES.INVALID_ARGUMENT,
        ],
        ['{{#each (query "Contact")}}{{/each}}', MESSAGE_CODES.INVALID_ARGUMENT],
        [
            '{{#each (query type="CRM" object="Contact" fields="A" limit=0)}}{{/each}}',
            MESSAGE_CODES.INVALID_COUNT,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="A" foo="x")}}{{/each}}',
            MESSAGE_CODES.INVALID_ARGUMENT,
        ],
        [
            '{{get (queryFirst type="CRM" object="Contact" fields="A" limit=2) "A"}}',
            MESSAGE_CODES.INVALID_ARGUMENT,
        ],
        [
            `{{#each (query type="MO" object="${COUPONS}" CouponCode__c="x" where="A = :a" params=(hash a=1))}}{{/each}}`,
            MESSAGE_CODES.INVALID_ARGUMENT,
        ],
        [
            `{{#each (query type="MO" object="${COUPONS}" CouponCode__c="x" sortBy="A ASC")}}{{/each}}`,
            MESSAGE_CODES.INVALID_ARGUMENT,
        ],
        [
            `{{#each (query type="MO" object="${COUPONS}" CouponCode__c="x" limit="many")}}{{/each}}`,
            MESSAGE_CODES.INVALID_COUNT,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="A" where="A ~ :a" params=(hash a=1))}}{{/each}}',
            MESSAGE_CODES.UNKNOWN_FILTER_OPERATOR,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="A"',
            MESSAGE_CODES.MISSING_CLOSING_PAREN,
        ],
        [
            '{{#each (query type="CRM" object="Contact fields="A")}}',
            MESSAGE_CODES.UNTERMINATED_STRING,
        ],
        // DB query.json#checklist[30]: a field missing from fields renders empty
        [
            '{{get (queryFirst type="CRM" object="Contact" fields="LastName" where="Id = :p1" params=(hash p1="x")) "FirstName"}}',
            MESSAGE_CODES.INVALID_ARGUMENT,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="A" sortBy="A ASC, B DESC")}}{{/each}}',
            MESSAGE_CODES.INVALID_ORDER_BY,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="A" where="A LIKE :p1" params=(hash p1="R_o"))}}{{/each}}',
            MESSAGE_CODES.INVALID_FILTER_VALUE,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="A" where="A LIKE :p1" params=(hash p1="%a[b]%"))}}{{/each}}',
            MESSAGE_CODES.INVALID_FILTER_VALUE,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="A" where="A LIKE :p1" params=(hash p1="%a%b%"))}}{{/each}}',
            MESSAGE_CODES.INVALID_FILTER_VALUE,
        ],
        [
            '{{#each (query type="CRM" object="Contact" fields="A" where="A LIKE :p1" params=(hash p1="%%x%%"))}}{{/each}}',
            MESSAGE_CODES.INVALID_FILTER_VALUE,
        ],
    ];
    for (const [text, expected] of cases) {
        it(`${text || '(empty)'} → ${expected}`, () => {
            const result = parseHandlebars(text);
            assert.equal(result.ast, null);
            const error = result.messages.find((message) => message.severity === 'error');
            assert.equal(error.code, expected, error.message);
        });
    }

    it('reads a non-contains LIKE as contains with a warning', () => {
        const result = parseHandlebars(
            '{{#each (query type="CRM" object="Contact" fields="LastName" where="LastName LIKE :n" params=(hash n="Ro%"))}}{{/each}}',
        );
        assert.equal(printSql(result.ast).split('\n', 3)[2], "WHERE LastName LIKE '%Ro%'");
        assert.equal(result.messages[0].code, MESSAGE_CODES.LIKE_MATCHES_ANYWHERE);
    });

    it('reads the get field of queryFirst without regard to case', () => {
        const result = parseHandlebars(
            '{{get (queryFirst type="CRM" object="Contact" fields="LastName" where="Id = :p1" params=(hash p1="x")) "lastname"}}',
        );
        assert.ok(result.ast, result.messages[0]?.message);
        assert.deepEqual(
            result.ast.columns.map((column) => column.name),
            ['lastname'],
        );
    });

    it('keeps text and number params apart ("5" vs 5)', () => {
        const call =
            '{{#each (query type="CRM" object="Contact" fields="A" where="Code = :p1" params=(hash p1=VALUE))}}{{/each}}';
        const text = toSql(call.replace('VALUE', '"5"'));
        assert.match(text.outputs[0].code, /WHERE Code = '5'$/);
        assert.equal(text.roundTrip.ok, true, text.roundTrip.note);
        const number = toSql(call.replace('VALUE', '5'));
        assert.match(number.outputs[0].code, /WHERE Code = 5$/);
        assert.equal(number.roundTrip.ok, true, number.roundTrip.note);
        const mo = toSql(
            `{{#each (query type="MO" object="${COUPONS}" CouponCode__c="0042")}}{{/each}}`,
        );
        assert.match(mo.outputs[0].code, /WHERE CouponCode__c = '0042'$/);
        const moText = toSql(
            `{{#each (query type="MO" object="${COUPONS}" CouponCode__c="42")}}{{/each}}`,
        );
        assert.match(moText.outputs[0].code, /WHERE CouponCode__c = '42'$/);
    });

    it('round-trips text and number values with their type (SQL → Handlebars → SQL)', () => {
        const textCode = code("SELECT A FROM Contact WHERE Code = '5'", q);
        assert.match(textCode, /p1="5"/);
        const numberCode = code('SELECT A FROM Contact WHERE Code = 5', q);
        assert.match(numberCode, /p1=5\)/);
        const moCode = code(
            `SELECT CouponCode__c FROM ${COUPONS} WHERE CouponCode__c = '42'`,
            qmo,
            MO,
        );
        assert.match(moCode, /CouponCode__c="42"/);
        const typed = { isTyped: true };
        const text = parseHandlebars(textCode).ast;
        const number = parseHandlebars(numberCode).ast;
        assert.notEqual(normalizeSql(text, typed), normalizeSql(number, typed));
        assert.equal(normalizeSql(text), normalizeSql(number));
    });

    it('warns about a second query', () => {
        const one = '{{#each (query type="CRM" object="Contact" fields="A")}}{{/each}}';
        const result = parseHandlebars(`${one}\n${one}`);
        assert.ok(result.ast);
        assert.equal(result.messages[0].code, MESSAGE_CODES.MULTIPLE_LOOKUPS);
    });

    it('reads the MO body fields and reports the target', () => {
        const result = parseHandlebars(
            `{{#each (query type="MO" object="${COUPONS}" CouponCode__c="PROBE0001")}}{{CouponCode__c}};{{IsClaimed__c}}{{/each}}`,
        );
        assert.deepEqual(result.meta, {
            target: 'handlebars-query-mo',
            dataSource: 'MO',
            deName: COUPONS,
        });
        assert.equal(
            printSql(result.ast),
            `SELECT CouponCode__c, IsClaimed__c\nFROM ${COUPONS}\nWHERE CouponCode__c = 'PROBE0001'`,
        );
    });
});

describe('parseAmpscript — Next', () => {
    it('reads RetrieveSalesforceObjects with every operator', () => {
        const result = parseAmpscript(
            '%%[ SET @r = RetrieveSalesforceObjects("Contact", "LastName, pi__score__c", "a", "=", "1", "b", "!=", "x", "c", "<>", "y", "d", "<", "2", "e", "<=", "3", "f", ">", "4", "g", ">=", "5", "h", "like", "%z%") ]%%',
            { platform: 'mcn' },
        );
        assert.equal(result.meta.target, 'ampscript-rso');
        assert.equal(
            printSql(result.ast),
            "SELECT LastName, pi__score__c\nFROM Contact\nWHERE a = 1 AND b <> 'x' AND c <> 'y' AND d < 2 AND e <= 3 AND f > 4 AND g >= 5 AND h LIKE '%z%'",
        );
    });

    it('rejects a wrong argument count and an unknown operator', () => {
        const count = parseAmpscript('RetrieveSalesforceObjects("Contact", "A", "B", "=")', {
            platform: 'mcn',
        });
        assert.equal(count.messages[0].code, MESSAGE_CODES.ARGUMENT_COUNT);
        const op = parseAmpscript('RetrieveSalesforceObjects("Contact", "A", "B", "~", "x")', {
            platform: 'mcn',
        });
        assert.equal(op.messages[0].code, MESSAGE_CODES.UNKNOWN_FILTER_OPERATOR);
    });

    it('converts a prefix LIKE to contains with a warning', () => {
        const result = parseAmpscript(
            'RetrieveSalesforceObjects("Contact", "A", "B", "LIKE", "Ro%")',
            { platform: 'mcn' },
        );
        assert.equal(result.messages[0].code, MESSAGE_CODES.LIKE_MATCHES_ANYWHERE);
        assert.match(printSql(result.ast), /B LIKE '%Ro%'/);
    });

    it('rejects the same field in two conditions (DB RSO #22, #24)', () => {
        const result = parseAmpscript(
            'RetrieveSalesforceObjects("Contact", "A", "B", ">", "1", "b", "<", "9")',
            { platform: 'mcn' },
        );
        assert.equal(result.ast, null);
        assert.equal(result.messages[0].code, MESSAGE_CODES.INVALID_FILTER);
        assert.equal(
            result.messages[0].message,
            unavailable(`SELECT A FROM Contact WHERE B > 1 AND b < 9`, rso),
        );
    });

    it('rejects a LIKE value with _, [ or % inside the text', () => {
        for (const value of ['R_o', '%a[b]%', '%a%b%', '%%x%%']) {
            const result = parseAmpscript(
                `RetrieveSalesforceObjects("Contact", "A", "B", "LIKE", "${value}")`,
                { platform: 'mcn' },
            );
            assert.equal(result.ast, null, value);
            assert.equal(result.messages[0].code, MESSAGE_CODES.INVALID_FILTER_VALUE, value);
        }
    });

    it('rejects LookupRowsCS in Next and ignores RetrieveSalesforceObjects on Engagement', () => {
        const cs = parseAmpscript('LookupRowsCS("X", "A", "b")', { platform: 'mcn' });
        assert.equal(cs.messages[0].code, MESSAGE_CODES.UNSUPPORTED_EXPRESSION);
        const mce = parseAmpscript('RetrieveSalesforceObjects("Contact", "A", "B", "=", "x")');
        assert.equal(mce.messages[0].code, MESSAGE_CODES.NO_LOOKUP_FOUND);
    });

    it('reads LookupRows on a marketing object', () => {
        const result = parseAmpscript('LookupRows("X__mo", "A", "b")', { platform: 'mcn' });
        assert.equal(result.meta.target, 'ampscript-lookuprows-mo');
    });
});
