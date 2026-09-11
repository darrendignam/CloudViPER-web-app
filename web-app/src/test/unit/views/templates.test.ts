/**
 * Every handlebars template must compile.
 *
 * A template only fails when something renders it, so a broken one passes the
 * type checker, passes every route test that stubs the view engine, builds
 * cleanly, publishes, deploys, and then 500s the page in production. That is
 * exactly how `style={{ ... }}` reached a live server: JSX inline styles open
 * with the two characters handlebars reserves for an expression, and the parse
 * error names a line in a partial rather than the page that failed.
 *
 * Cheap to check and catches the whole class, so it runs with everything else.
 */
import fs from 'fs';
import path from 'path';
import Handlebars from 'handlebars';

const VIEWS_ROOT = path.join(__dirname, '../../../views');

function templatesUnder(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return templatesUnder(full);
        return entry.name.endsWith('.handlebars') ? [full] : [];
    });
}

const templates = templatesUnder(VIEWS_ROOT);

describe('handlebars templates', () => {
    it('should find templates to check', () => {
        // A glob that silently matches nothing would make every assertion below
        // vacuously true.
        expect(templates.length).toBeGreaterThan(5);
    });

    it.each(templates.map((file) => [path.relative(VIEWS_ROOT, file), file]))(
        '%s should compile',
        (_name, file) => {
            const source = fs.readFileSync(file as string, 'utf8');

            expect(() => Handlebars.precompile(source)).not.toThrow();
        }
    );

    it('should escape the braces of a JSX inline style', () => {
        // The specific trap. React wants style={{...}}; handlebars reads the
        // leading {{ as the start of an expression and refuses the file. The
        // codebase escapes it as \{{ , and this asserts nobody has quietly
        // added an unescaped one back.
        const offenders = templates.filter((file) => {
            const source = fs.readFileSync(file, 'utf8');
            return /(^|[^\\])style=\{\{/.test(source);
        });

        expect(offenders.map((file) => path.relative(VIEWS_ROOT, file))).toEqual([]);
    });
});
