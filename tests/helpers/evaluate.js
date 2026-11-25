/**
 * Test-only evaluator: runs a parsed SELECT against in-memory rows with the SQL semantics
 * observed in Marketing Cloud Engagement query activities (see tests/fixtures/ground-truth.json):
 * - text compares ignore case and trailing spaces (also for <, >, …);
 * - LIKE ignores case and trailing spaces of the value; `%` = any text, `_` = one character, `[…]` = one character of a set
 *   (so `[%]` matches a literal %);
 * - NULL never matches a comparison, LIKE, IN or NOT IN (so `<>` and NOT IN exclude NULL);
 * - an empty string is a value, not NULL (`= ''` matches only empty text);
 * - Number / Decimal / Boolean / Date columns compare by value.
 */

const NUMERIC_TYPES = new Set(['Number', 'Decimal']);
// one LIKE token: %, _, a character set such as [%] / [^a-c], or any single character
const LIKE_TOKEN = /%|_|\[\^?[^\]]+\]|[\s\S]/g;

/**
 * Converts a LIKE pattern into a regular expression.
 *
 * @param {string} pattern LIKE pattern
 * @returns {RegExp} case-insensitive, anchored expression
 */
export function likeToRegExp(pattern) {
    const source = pattern.replaceAll(LIKE_TOKEN, (token) => {
        if (token === '%') {
            return String.raw`[\s\S]*`;
        }
        if (token === '_') {
            return String.raw`[\s\S]`;
        }
        if (token.length > 2 && token.startsWith('[')) {
            const isNegated = token[1] === '^';
            const body = token.slice(isNegated ? 2 : 1, -1).replaceAll(/[\\^]/g, String.raw`\$&`);
            return `[${isNegated ? '^' : ''}${body}]`;
        }
        return token.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
    });
    return new RegExp(`^${source}$`, 'i');
}

/**
 * Builds a case-insensitive field → type lookup.
 *
 * @param {{Name: string, FieldType: string}[]} fields fixture fields
 * @returns {Map<string, string>} lower-case name → field type
 */
function typeMap(fields) {
    return new Map(fields.map((field) => [field.Name.toLowerCase(), field.FieldType]));
}

/**
 * Reads a column of a row (case-insensitive name); missing values are NULL.
 *
 * @param {object} row fixture row
 * @param {string} column column name
 * @returns {string|number|boolean|null} value or null
 */
function readColumn(row, column) {
    const key = Object.keys(row).find((name) => name.toLowerCase() === column.toLowerCase());
    return key === undefined ? null : row[key];
}

/**
 * Converts a row value and a literal into two comparable values of the column type.
 *
 * @param {string|number|boolean|null} rowValue row value (not null)
 * @param {string} literal literal text
 * @param {string} type field type
 * @returns {[number|string, number|string]} comparable pair
 */
function comparable(rowValue, literal, type) {
    if (NUMERIC_TYPES.has(type)) {
        return [Number(rowValue), Number(literal)];
    }
    if (type === 'Boolean') {
        const asNumber = (value) => (value === true || /^(?:1|true)$/i.test(String(value)) ? 1 : 0);
        return [asNumber(rowValue), asNumber(literal)];
    }
    if (type === 'Date') {
        return [Date.parse(String(rowValue)), Date.parse(literal)];
    }
    return [String(rowValue).trimEnd().toLowerCase(), String(literal).trimEnd().toLowerCase()];
}

/**
 * Compares a row value with a literal.
 *
 * @param {string|number|boolean|null} rowValue row value
 * @param {string} op comparison operator
 * @param {string} literal literal text
 * @param {string} type field type
 * @returns {boolean} true when the condition holds (false for NULL)
 */
function compare(rowValue, op, literal, type) {
    if (rowValue === null || rowValue === undefined) {
        return false;
    }
    const [left, right] = comparable(rowValue, literal, type);
    switch (op) {
        case '=': {
            return left === right;
        }
        case '<>': {
            return left !== right;
        }
        case '>': {
            return left > right;
        }
        case '>=': {
            return left >= right;
        }
        case '<': {
            return left < right;
        }
        case '<=': {
            return left <= right;
        }
        default: {
            throw new Error(`Unknown operator ${op}`);
        }
    }
}

/**
 * Evaluates a WHERE expression for one row.
 *
 * @param {object} expr expression node
 * @param {object} row fixture row
 * @param {Map<string, string>} types field types
 * @returns {boolean} true when the row matches
 */
function matches(expr, row, types) {
    if (expr.type === 'and') {
        return matches(expr.left, row, types) && matches(expr.right, row, types);
    }
    if (expr.type === 'or') {
        return matches(expr.left, row, types) || matches(expr.right, row, types);
    }
    const value = readColumn(row, expr.column);
    const type = types.get(expr.column.toLowerCase()) ?? 'Text';
    switch (expr.type) {
        case 'compare': {
            return compare(value, expr.op, expr.value.value, type);
        }
        case 'like': {
            // SQL ignores trailing spaces of the matched value
            return (
                value !== null &&
                likeToRegExp(expr.pattern.value).test(String(value).replace(/ +$/, ''))
            );
        }
        case 'in': {
            if (value === null) {
                return false;
            }
            const found = expr.values.some((item) => compare(value, '=', item.value, type));
            return expr.negated ? !found : found;
        }
        case 'between': {
            return (
                compare(value, '>=', expr.low.value, type) &&
                compare(value, '<=', expr.high.value, type)
            );
        }
        case 'null': {
            const isNull = value === null || value === undefined;
            return expr.negated ? !isNull : isNull;
        }
        default: {
            throw new Error(`Unknown expression ${expr.type}`);
        }
    }
}

/**
 * Returns the rows a parsed SELECT reads from a fixture (WHERE only; TOP / ORDER BY are not
 * applied because the ground truth compares row sets).
 *
 * @param {object} ast SELECT AST from parseSql
 * @param {{fields: object[], rows: object[]}} fixture data extension fixture
 * @returns {object[]} matching rows
 */
export function evaluate(ast, fixture) {
    const types = typeMap(fixture.fields);
    return fixture.rows.filter((row) => !ast.where || matches(ast.where, row, types));
}
