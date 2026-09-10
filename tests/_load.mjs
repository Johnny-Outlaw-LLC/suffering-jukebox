// Shared plumbing for the test suites.
//
// Most of what is worth testing in this app is either a TypeScript module under
// src/lib that a route imports, or a plain function sitting inside the 2 MB
// public/index.html. Neither can simply be `import`ed from a test: the first
// uses "@/lib/..." path aliases and pulls in a Supabase client at module load,
// the second is not a module at all.
//
// loadTs() transpiles a lib and runs it in THIS realm (not a vm context), so an
// object it returns is deepStrictEqual-comparable against a literal written in
// the test. loadHtmlFns() lifts named functions straight out of the dashboard.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

const root = new URL('../', import.meta.url);

export function readRepoFile(relPath) {
  return readFileSync(new URL(relPath, root), 'utf8');
}

/**
 * Transpile and evaluate a src/lib module.
 *
 * `stubs` is keyed by import specifier suffix, so "@/lib/sj-admin-auth" is
 * matched by the key "sj-admin-auth". Anything a module imports that is not
 * stubbed throws by name rather than returning undefined - a silent undefined
 * import is how a test ends up proving nothing.
 */
export function loadTs(relPath, stubs = {}) {
  const js = ts.transpileModule(readRepoFile(relPath), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const require = (name) => {
    for (const key of Object.keys(stubs)) {
      if (name === key || name.endsWith(key)) return stubs[key];
    }
    throw new Error(`${relPath} imported ${name}, which the test did not stub`);
  };
  new Function('exports', 'require', 'module', js)(module.exports, require, module);
  return module.exports;
}

/** The Supabase half of sj-admin-auth, stubbed. Nothing here talks to a network. */
export const adminAuthStub = {
  JUKEBOX_SCHEMA: 'jukebox',
  SJ_PROTECTED_ADMIN_EMAIL: 'johnnyoutlawllc@gmail.com',
  SJ_SUPABASE_URL: 'https://example.invalid',
  SJ_SUPABASE_ANON_KEY: 'anon',
  createSjServiceClient() {
    throw new Error('a pure-rules test reached for the database');
  },
  createSjAuthClient() {
    throw new Error('a pure-rules test reached for the database');
  },
};

const html = readRepoFile('public/index.html');
export { html as dashboardHtml };

/** The source text between two markers, asserted to exist. */
export function htmlSlice(startMarker, endMarker) {
  const from = html.indexOf(startMarker);
  assert.ok(from >= 0, `could not find "${startMarker}" in public/index.html`);
  const to = html.indexOf(endMarker, from + startMarker.length);
  assert.ok(to > from, `could not find "${endMarker}" after "${startMarker}"`);
  return html.slice(from, to);
}

/**
 * Pull named top-level functions (and const declarations) out of the dashboard
 * and evaluate them here, so a client-side rule can be tested against the same
 * inputs as its server-side twin.
 */
export function loadHtmlFns(names, { startMarker, endMarker } = {}) {
  return loadFnsFrom(startMarker ? htmlSlice(startMarker, endMarker) : html, names);
}

/** The same, out of any source text - the admin pages are not the dashboard. */
export function loadFnsFrom(source, names) {
  const out = {};
  for (const name of names) {
    const decl = `function ${name}(`;
    const at = source.indexOf(decl);
    assert.ok(at >= 0, `could not find function ${name}() in public/index.html`);
    out[name] = extractFunction(source, at);
  }
  const body = Object.values(out).join('\n');
  const factory = new Function(`${body}\nreturn {${names.join(',')}};`);
  return factory();
}

/**
 * Same, but evaluated against a scope object standing in for the page globals
 * the function reads and writes (ytQueue, ytQueueIdx, and so on). Assignments
 * land back on that object, so a test can read the queue index the function
 * left behind. Anything the function calls that touches the DOM is stubbed by
 * putting a function of that name on the scope.
 */
export function loadHtmlFnsInScope(names, scope) {
  const fns = names.map((name) => {
    const decl = `function ${name}(`;
    const at = html.indexOf(decl);
    assert.ok(at >= 0, `could not find function ${name}() in public/index.html`);
    return extractFunction(html, at);
  });
  const factory = new Function(
    '__scope',
    `with (__scope) {\n${fns.join('\n')}\nreturn {${names.join(',')}};\n}`,
  );
  return factory(scope);
}

/** Read one function declaration by walking its braces. */
function extractFunction(source, at) {
  let depth = 0;
  let started = false;
  for (let i = at; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') { depth++; started = true; continue; }
    if (ch === '}') {
      depth--;
      if (started && depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error('unbalanced braces reading a function out of public/index.html');
}
