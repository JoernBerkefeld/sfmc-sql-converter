# sfmc-sql-converter

Converts SQL SELECT queries to Salesforce Marketing Cloud lookup code (SSJS, AMPscript) and back.

You write the query you would run in a query activity. The package gives you the matching code for every lookup method of Marketing Cloud Engagement. It also reads lookup code and gives you the SQL it stands for.

- No dependencies. Plain JavaScript (ES modules), runs in Node.js and in the browser.
- The code you paste is only read as text. It is never run.
- The generated SSJS uses `var` only (no arrow functions, `let`, `const` or template strings), so the SSJS engine accepts it.

## Install

```sh
npm install sfmc-sql-converter
```

Node.js 22 or newer.

## Usage

```js
import { convert } from 'sfmc-sql-converter';

const result = convert(
  "SELECT TOP 5 SubscriberKey, Email FROM [Customers] WHERE Country = 'DE' ORDER BY Email",
  { deKey: 'CUST-KEY' },
);
for (const output of result.outputs) {
  console.log(output.label, output.code ?? output.unavailable);
}

const back = convert('var rows = Platform.Function.LookupRows("Customers", ["Country"], ["DE"]);', {
  direction: 'toSql',
});
console.log(back.outputs[0].code);
// SELECT *
// FROM Customers
// WHERE Country = 'DE'
```

### `convert(input, options)`

`input` is SQL (direction `toCode`) or SSJS / AMPscript (direction `toSql`).

| Option       | Default    | Meaning                                                                       |
| ------------ | ---------- | ----------------------------------------------------------------------------- |
| `platform`   | `'mce'`    | `'mce'` (Engagement) or `'mcn'` (Next)                                        |
| `direction`  | `'toCode'` | `'toCode'` (SQL to code) or `'toSql'` (code to SQL)                           |
| `dataSource` | `'CRM'`    | Next only: `'CRM'` (Sales Cloud object) or `'MO'` (marketing object)          |
| `deKey`      | the name   | External key of the data extension. WSProxy and Rows.Retrieve need the key.   |
| `deName`     |            | `toSql` only: data extension name when the code does not carry it             |
| `columns`    |            | The column names that `SELECT *` stands for                                   |
| `schema`     |            | `{ fields: [{ name }] }`, used like `columns` when `columns` is not given     |
| `output`     |            | WSProxy options: `rowsAsObjects` (default `true`), `paging` (default `false`) |

Unknown `platform` or `direction` values throw a `TypeError`. Everything else never throws: problems come back as messages.

### Result

```js
{
    outputs: [
        {
            id: 'ssjs-wsproxy',          // target id
            language: 'ssjs',            // 'ssjs', 'ampscript' or 'sql'
            label: 'WSProxy',
            code: '<script runat="server">…</script>', // or `unavailable: '<plain reason>'`
            spans: [{ clauseId, start, end }],         // where each clause is in `code`
            messages: [],                // messages for this output only
            dropped: ['top'],            // clause ids this output leaves out
            roundTrip: { ok, sql, note }, // the code read back as SQL
        },
    ],
    messages: [],   // messages about the input
    clauseMap: [],  // { outputId, clauseId, sql, code, loc, dropped } per clause and output
    roundTrip: { ok, sql, note }, // first available output (toCode) or the printed SQL (toSql)
}
```

Every message has `severity` (`error`, `warning` or `info`), `code`, `message` (plain text), `line`, `column`, `endLine` and `endColumn` (1-based, end exclusive).

Clause ids: `column-N`, `top`, `from`, `where-N` (each single condition, left to right) and `order-N`.

## Targets (Engagement)

| Id                            | Code                                             | Available when                                                                                              |
| ----------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `ssjs-wsproxy`                | WSProxy `retrieve` of `DataExtensionObject[Key]` | the columns are known (named in the SELECT, or given with `columns` / `schema`); no anchored LIKE inside OR |
| `ssjs-rows-retrieve`          | `DataExtension.Init(Key).Rows.Retrieve(filter)`  | no anchored LIKE inside OR                                                                                  |
| `ssjs-lookuprows`             | `Platform.Function.LookupRows`                   | WHERE uses only `Column = 'value'` joined with AND                                                          |
| `ssjs-lookuporderedrows`      | `Platform.Function.LookupOrderedRows`            | as LookupRows, plus ORDER BY on columns without spaces or commas                                            |
| `ampscript-lookuprows`        | AMPscript `LookupRows` plus a FOR loop           | as LookupRows; no name or value contains `%%`                                                               |
| `ampscript-lookuporderedrows` | AMPscript `LookupOrderedRows` plus a loop        | as LookupOrderedRows; no name or value contains `%%`                                                        |
| `ampscript-lookup`            | AMPscript `Lookup`                               | exactly one column, equals joined with AND; no `%%`. Returns the first match only.                          |

When a target can't express the query, its output has `unavailable` with a plain reason instead of `code`.

WSProxy reads one batch (up to 2,500 rows) by default and says so with `FIRST_BATCH_ONLY`. When more rows exist, the code sets `hasMoreRows = true`. With `output.paging` it reads every batch with `props.ContinueRequest = result.RequestID`.

## Targets (Next)

Next mode returns the targets of the chosen `dataSource`. Only what live tests proved is generated (`NEXT_RULES` lists each rule with its test records); everything else is unavailable with a reason.

| Id                        | Data source | Code                                                           | Available when                                                                                    |
| ------------------------- | ----------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `handlebars-query`        | CRM         | `{{#each (query type="CRM" … where=":p1 …" params=(hash …))}}` | columns listed; `=`, `<>`, `<`, `<=`, `>`, `>=`, `LIKE '%text%'`, AND, OR, brackets; one ORDER BY |
| `handlebars-queryfirst`   | CRM         | `{{get (queryFirst type="CRM" …) "Field"}}`                    | as query, exactly one column; returns the first match (TOP 1)                                     |
| `ampscript-rso`           | CRM         | AMPscript `RetrieveSalesforceObjects` plus a FOR loop          | columns listed; the same operators joined with AND, each field at most once; no TOP / ORDER BY    |
| `handlebars-query-mo`     | MO          | `{{#each (query type="MO" object="X" Field__c="v" …)}}`        | `Column = value` joined with AND, each field once; TOP becomes `limit`; no ORDER BY               |
| `ampscript-lookuprows-mo` | MO          | AMPscript `LookupRows` plus a FOR loop                         | `Column = 'value'` joined with AND, each field once; no TOP / ORDER BY                            |

Values always go into `params` (literals in `where` fail in Next); `<>` is written as `!=`. Next matches LIKE as "contains", so only `'%text%'` converts. IN, NOT IN, NOT (…), BETWEEN and IS NULL are not supported in Next. On a marketing object, Next returned only one record in a test where the filter matched two, so both marketing object targets carry the warning `MO_ONE_MATCH`; filter on the key field when every match matters.

## Rewrites and dropped clauses

- **ISNULL / COALESCE.** In WHERE, `ISNULL(Column, value) op value` (and COALESCE with two arguments) is converted without the function: `Column op value`, plus `OR Column IS NULL` when the fallback itself matches the condition (`NULL_FALLBACK_REWRITTEN`). This assumes the fallback has the column's type. Reading code back gives this expanded form. Other uses of the functions stay errors.
- **OFFSET … FETCH** is an error (`UNSUPPORTED_OFFSET_FETCH`); use TOP.

- **LIKE.** The WSProxy and Rows.Retrieve `like` filter always matches anywhere (it wraps the value in `%`). `'%text%'` is sent as is. Any other pattern is sent without its outer `%`, and the generated `sqlLike()` helper then checks the exact pattern on each row. This only works on a pure AND path, so such a LIKE inside OR makes these targets unavailable (`LIKE_CHECKED_IN_SCRIPT`).
- **Empty text.** The filter rejects an empty value, so `= ''` is sent as a single space `' '`. This finds the same rows, because trailing spaces are ignored when text is compared (`EMPTY_STRING_AS_SPACE`).
- **TOP and ORDER BY.** WSProxy, Rows.Retrieve and LookupRows can't sort or limit rows. They leave ORDER BY and TOP out with a warning. LookupOrderedRows uses TOP as its row count. `TOP 0` is an error. TOP above 2,000 gets a warning on the lookup functions, which return at most 2,000 rows.
- **NOT IN** becomes a chain of `notEquals` joined with AND. A `// SQL: NOT IN` comment lets the reverse parser fold it back.
- **Names in comments.** The data extension name and the column list are kept in a `// SQL:` (SSJS) or `/* SQL: */` (AMPscript) comment. These comments never hold a backslash or a double quote (a CloudPage reads `"` as the start of a string even inside a comment), and nothing that ends the comment, the script or an AMPscript block. `~` is the escape character: `~` becomes `~~`, `"` becomes `~q`, a backslash becomes `~b`, and a `~` is put into `</`, `*/`, `]%%`, `=%%`, `%%[` and `%%=` (for example `<~/`). Reading the code back undoes this exactly, so every name comes back unchanged.
- **Backslashes** in SSJS strings are written as the unicode escape of character 5C, never as an escaped backslash. A string ending in an escaped backslash makes a CloudPage fail.

## Reading code back (`toSql`)

- Reads WSProxy `retrieve`, `DataExtension.Init(…).Rows.Retrieve(…)`, `Platform.Function.LookupRows` / `LookupOrderedRows`, AMPscript `LookupRows`, `LookupOrderedRows`, `Lookup` (also the CS variants), and bare filter objects.
- Next (`platform: 'mcn'`): Handlebars `query` / `queryFirst` (CRM and MO) and AMPscript `LookupRows` / `RetrieveSalesforceObjects`. Every `:name` in `where` must be defined once in `params`; a literal in `where` is an error. Handlebars keeps the value type: `p1="5"` reads back as `'5'`, `p1=5` as `5`. A LIKE value of plain text that is not `%text%` (e.g. `Ro%`) reads back as `'%Ro%'` with a warning; `_`, `[` or `%` inside the text is an error. These are errors too, as in the forward direction: `sortBy` with more than one field, a `get` field that is not in `fields` (Next renders it empty), and the same field in two `RetrieveSalesforceObjects` conditions.
- Engagement: when the SQL sorts without TOP, an info message (`ORDER_BY_NEEDS_TOP`) points out that a query activity in Automation Studio rejects ORDER BY without TOP.
- Variables set to fixed values are resolved. Values only known at run time are errors.
- A hand-written `like` filter without a `sqlLike()` check reads back as `LIKE '%value%'`, because the filter matches anywhere (`LIKE_MATCHES_ANYWHERE`).
- A bare filter object does not name its data extension. Pass `deName` to fill it in. Without it, the round trip is skipped (`roundTrip.skipped: true` with a note).

## Round trip

Every output is read back with the reverse parser and compared with the query. The comparison ignores keyword case, name case, brackets, whitespace, the quotes of plain numbers, and how AND / OR are grouped. It also ignores the clauses the target left out, `IN` ↔ OR chains and `NOT IN` ↔ AND chains where the target writes them that way, and `*` ↔ the column list given in the options. The Next Handlebars targets keep the quotes of plain numbers apart, because Next compares `'5'` and `5` as different types.

## Message codes

| Code                                                                                                                                                                                                 | Meaning                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `EMPTY_INPUT`                                                                                                                                                                                        | Nothing to convert                                                                  |
| `UNEXPECTED_CHARACTER`, `UNTERMINATED_STRING`, `UNTERMINATED_IDENTIFIER`, `UNTERMINATED_COMMENT`, `EMPTY_IDENTIFIER`                                                                                 | The text can't be split into words                                                  |
| `UNSUPPORTED_LINE_SEPARATOR`                                                                                                                                                                         | A name contains the line separator U+2028 or U+2029                                 |
| `SYNTAX_ERROR`, `EXPECTED_SELECT`, `EXPECTED_FROM`, `EXPECTED_IDENTIFIER`, `EXPECTED_OPERATOR`, `EXPECTED_VALUE`, `EXPECTED_STRING`, `MISSING_CLOSING_PAREN`                                         | Something is missing or in the wrong place                                          |
| `INVALID_TOP`                                                                                                                                                                                        | TOP is not a whole number above 0                                                   |
| `LITERAL_ON_LEFT`, `NULL_COMPARISON`                                                                                                                                                                 | Write `Column = value`, and `IS NULL` instead of `= NULL`                           |
| `NESTING_TOO_DEEP`, `INTERNAL_ERROR`                                                                                                                                                                 | The input can't be read                                                             |
| `UNSUPPORTED_*` (JOIN, subquery, GROUP BY, HAVING, aggregate, DISTINCT, function, column comparison, alias, qualified name, NOT LIKE, NOT BETWEEN, NOT, `*` with columns, UNION, several statements) | Not possible with a lookup                                                          |
| `SYSTEM_DATA_VIEW`                                                                                                                                                                                   | System data views can't be read with a lookup                                       |
| `TABLE_HINT_IGNORED`                                                                                                                                                                                 | Table hints such as `WITH (NOLOCK)` are ignored                                     |
| `ORDER_BY_DROPPED`, `TOP_DROPPED`                                                                                                                                                                    | The target leaves the clause out                                                    |
| `FIRST_BATCH_ONLY`                                                                                                                                                                                   | WSProxy without paging reads only the first batch of up to 2,500 rows               |
| `ORDER_BY_NEEDS_TOP`                                                                                                                                                                                 | Code → SQL on Engagement: the SQL sorts without TOP, which a query activity rejects |
| `TOP_ABOVE_LOOKUP_LIMIT`                                                                                                                                                                             | TOP asks for more than the 2,000 rows a lookup returns                              |
| `DE_KEY_ASSUMED`                                                                                                                                                                                     | No external key given; the name is used as the key                                  |
| `SELECT_STAR_NEEDS_COLUMNS`                                                                                                                                                                          | WSProxy needs the columns that `*` stands for                                       |
| `LIKE_CHECKED_IN_SCRIPT`                                                                                                                                                                             | The exact LIKE pattern is checked in the script                                     |
| `EMPTY_STRING_AS_SPACE`                                                                                                                                                                              | `''` is sent as a single space                                                      |
| `NO_LOOKUP_FOUND`, `MULTIPLE_LOOKUPS`                                                                                                                                                                | No lookup, or more than one (only the first is converted)                           |
| `ARGUMENT_COUNT`, `INVALID_ARGUMENT`, `INVALID_OBJECT_TYPE`, `INVALID_COUNT`, `INVALID_ORDER_BY`                                                                                                     | A call argument can't be read                                                       |
| `INVALID_FILTER`, `INVALID_FILTER_VALUE`, `INVALID_LOGICAL_OPERATOR`, `UNKNOWN_FILTER_OPERATOR`, `UNSUPPORTED_FILTER_OPERATOR`                                                                       | A filter object can't be read                                                       |
| `UNSUPPORTED_EXPRESSION`, `VARIABLE_VALUE`                                                                                                                                                           | A value is calculated or only known at run time                                     |
| `FROM_UNKNOWN`, `FROM_NAME_FROM_KEY`                                                                                                                                                                 | The data extension name is missing, or the key is used                              |
| `LOOKUP_FIRST_ROW_ONLY`                                                                                                                                                                              | `Lookup` returns the first matching row only                                        |
| `CASE_SENSITIVE_LOOKUP`                                                                                                                                                                              | A CS lookup compares case-sensitively                                               |
| `LIKE_MATCHES_ANYWHERE`                                                                                                                                                                              | A `like` filter without a check reads back as `'%value%'`                           |

All codes are exported as constants and in `MESSAGE_CODES`.

## Live verification

The expected rows come from real Marketing Cloud query activities on a fixture data extension (`tests/fixtures/ground-truth.json`). On 2026-11-25 the generated code of every available target ran unchanged on a CloudPage: 142 of 142 target runs (48 cases) returned the same rows as the query activity.

## License

MIT, Joern Berkefeld
