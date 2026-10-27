#!/usr/bin/env node

import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { readFile, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const USAGE = `usage:
  node find-contract.mjs <url | file | -> [--base <url>] [--open]
  node find-contract.mjs <file | -> --cli
  node find-contract.mjs <url | file | -> --quote "<sentence>" [--base <url>]
  node find-contract.mjs --self-test`;

const CONTRACT_RELS = ['service-desc', 'describedby', 'service-doc'];
const DATA_TYPE = /(^|[\/+.-])(json|yaml|yml)($|[;+\s])/i;
const DATA_FILE = /\.(json|ya?ml)([?#]|$)/i;
const FIELD_TAGS = new Set(['input', 'select', 'textarea', 'button']);
const LIMITS = ['maxlength', 'minlength', 'pattern', 'min', 'max', 'step', 'accept'];
const SCHEMA_KEYS = ['inputSchema', 'input_schema', 'parameters'];
const SCHEMA_LIMITS = [
  'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
];
const BODY_METHODS = ['post', 'put', 'patch', 'delete'];
const MAX_DEPTH = 4;
const MAX_HOPS = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const PRINT_MAX = 200_000;
const DATE_META = /^(article:modified_time|article:published_time|og:updated_time|last-modified|date|dc\.date|dcterms\.modified|dcterms\.date)$/i;
const SIGN_IN_PATH = /(^|[\/_-])(log-?in|sign-?in|auth|sso)([\/_.?-]|$)/i;
const TIMEOUT_MS = 15000;
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:(?:\s+|(?<=["']))[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const LATIN1 = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute ' +
  'micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig ' +
  'Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash ' +
  'Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc ' +
  'euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml ' +
  'yacute thorn yuml'
).split(' ');
const PUNCTUATION = {
  ensp: 0x2002, emsp: 0x2003, thinsp: 0x2009, zwnj: 0x200c, zwj: 0x200d, lrm: 0x200e, rlm: 0x200f, ndash: 0x2013,
  mdash: 0x2014, lsquo: 0x2018, rsquo: 0x2019, sbquo: 0x201a, ldquo: 0x201c, rdquo: 0x201d, bdquo: 0x201e,
  dagger: 0x2020, Dagger: 0x2021, bull: 0x2022, hellip: 0x2026, permil: 0x2030, prime: 0x2032, Prime: 0x2033,
  lsaquo: 0x2039, rsaquo: 0x203a, euro: 0x20ac, trade: 0x2122, larr: 0x2190, rarr: 0x2192, minus: 0x2212,
};
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ...Object.fromEntries(LATIN1.map((name, i) => [name, String.fromCodePoint(0xa0 + i)])),
  ...Object.fromEntries(Object.entries(PUNCTUATION).map(([name, cp]) => [name, String.fromCodePoint(cp)])),
};
const LOCAL_NAME = /^(localhost|.+\.localhost|.+\.local|.+\.internal|.+\.home\.arpa)$/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const squash = (s) => s.replace(/\s+/gu, ' ').trim();
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const unBom = (s) => s.replace(/^\uFEFF/, '');

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e] ?? (/^(AMP|LT|GT|QUOT)$/.test(e) ? ENTITIES[e.toLowerCase()] : m);
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

function attrs(src) {
  const out = Object.create(null);
  for (const m of src.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

function absolute(href, base) {
  try {
    return new URL(href, base ?? undefined).href;
  } catch {
    return null;
  }
}

function urlPart(url, part) {
  try {
    return new URL(url)[part];
  } catch {
    return '';
  }
}

const bare = (host) => host.replace(/^\[|\]$/g, '');

function privateIp(ip) {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (version !== 6) return false;
  const x = ip.toLowerCase();
  const dotted = x.match(/^(?:0*:)*:?(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return privateIp(dotted[1]);
  const hex = x.match(/^(?:0*:)*:?(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return privateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^(::|::1|0*:(0*:)*0*1?)$/.test(x) || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
}

async function isLocal(url, resolveHost = lookup) {
  const host = bare(urlPart(url, 'hostname'));
  if (host === '' || LOCAL_NAME.test(host)) return true;
  if (isIP(host)) return privateIp(host);
  let addresses;
  try {
    addresses = await resolveHost(host, { all: true });
  } catch (e) {
    throw new Error(`cannot resolve ${host}: ${e.code ?? e.message}`);
  }
  return addresses.length === 0 || addresses.some((a) => privateIp(a.address));
}

function picked(relValue, type, href) {
  const rels = relValue.toLowerCase().split(/\s+/).filter(Boolean);
  const out = rels.filter((r) => CONTRACT_RELS.includes(r));
  if (rels.includes('alternate') && (type ? DATA_TYPE.test(type) : DATA_FILE.test(href))) out.push('alternate');
  return out;
}

const stripped = (html) =>
  html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

function scan(html, pageUrl) {
  const text = stripped(html);
  const tags = [...text.matchAll(TAG)].map((m) => ({
    close: m[1] === '/',
    name: m[2].toLowerCase(),
    a: attrs(m[3] ?? ''),
    end: m.index + m[0].length,
  }));
  const baseTag = tags.find((t) => !t.close && t.name === 'base' && t.a.href !== undefined);
  const base = (baseTag && absolute(baseTag.a.href, pageUrl)) || pageUrl;
  const links = [];
  const forms = [];
  const dates = [];
  let form = null;
  let select = null;
  let password = false;

  for (const t of tags) {
    const a = t.a;
    if (t.close) {
      if (t.name === 'form') form = null;
      if (t.name === 'select') select = null;
      continue;
    }
    if (t.name === 'input' && (a.type ?? '').toLowerCase() === 'password') password = true;
    if (t.name === 'meta' && a.content) {
      const key = a.property ?? a.name ?? a.itemprop ?? a['http-equiv'] ?? '';
      if (DATE_META.test(key) || /^date(published|modified)$/i.test(key)) dates.push(`meta ${key} ${a.content}`);
    } else if (t.name === 'time' && a.datetime && dates.filter((d) => d.startsWith('time ')).length < 3) {
      dates.push(`time ${a.datetime}`);
    }
    if (t.name === 'link' && a.rel && a.href !== undefined) {
      for (const rel of picked(a.rel, a.type, a.href)) {
        links.push({ rel, href: a.href, url: absolute(a.href, base), type: a.type ?? '', from: '<link>' });
      }
    } else if (t.name === 'form') {
      form = {
        method: (a.method || 'get').toUpperCase(),
        action: a.action ?? '',
        url: a.action ? absolute(a.action, base) : pageUrl ?? null,
        enctype: a.enctype || 'application/x-www-form-urlencoded',
        fields: [],
      };
      forms.push(form);
    } else if (form && FIELD_TAGS.has(t.name)) {
      let type = t.name;
      if (t.name === 'input') type = (a.type || 'text').toLowerCase();
      if (t.name === 'button') type = `button (${(a.type || 'submit').toLowerCase()})`;
      if (a.name === undefined || a.name === '') continue;
      const field = {
        name: a.name,
        type,
        required: 'required' in a,
        limits: LIMITS.filter((k) => a[k] !== undefined).map((k) => `${k}=${a[k]}`),
        options: [],
        value: type === 'hidden' ? a.value ?? '' : undefined,
      };
      form.fields.push(field);
      if (t.name === 'select') select = field;
    } else if (t.name === 'option' && select) {
      if (a.value !== undefined) select.options.push(a.value);
      else {
        const stop = text.indexOf('<', t.end);
        select.options.push(decode(text.slice(t.end, stop === -1 ? undefined : stop)).trim());
      }
    }
  }
  return { links, forms, dates, password };
}

function splitOutside(s, ch) {
  const out = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) cur += s[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '<') angle = true;
    else if (c === '>') angle = false;
    if (c === ch && !angle) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function linkHeader(value, pageUrl) {
  const out = [];
  for (const part of splitOutside(value ?? '', ',')) {
    const m = part.match(/^\s*<([^>]*)>([\s\S]*)$/);
    if (!m) continue;
    const params = Object.create(null);
    for (const p of splitOutside(m[2], ';').slice(1)) {
      const kv = p.match(/^\s*([^\s=]+)\s*(?:=\s*(?:"((?:[^"\\]|\\.)*)"|(\S*)))?\s*$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      if (!(key in params)) params[key] = kv[2]?.replace(/\\(.)/g, '$1') ?? kv[3] ?? '';
    }
    if (!params.rel) continue;
    for (const rel of picked(params.rel, params.type, m[1])) {
      out.push({ rel, href: m[1], url: absolute(m[1], pageUrl), type: params.type ?? '', from: 'Link header' });
    }
  }
  return out;
}

function parsedJson(raw, type) {
  const body = unBom(raw);
  if (!/json/i.test(type) && !/^[\[{]/.test(body.trimStart())) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function toolsOf(j) {
  const list = Array.isArray(j?.tools) ? j.tools : Array.isArray(j?.result?.tools) ? j.result.tools : Array.isArray(j) ? j : [j];
  return list.flatMap((t) => {
    const key = isObject(t) && typeof t.name === 'string' ? SCHEMA_KEYS.find((k) => isObject(t[k])) : undefined;
    return key ? [{ name: t.name, schema: t[key] }] : [];
  });
}

const isSchema = (j) => isObject(j) && (typeof j.$schema === 'string' || (j.type === 'object' && isObject(j.properties)));
const isOpenApi = (j) => isObject(j) && (typeof j.openapi === 'string' || typeof j.swagger === 'string');

function pointer(root, ref) {
  if (!ref.startsWith('#')) return undefined;
  let cur = root;
  for (const raw of ref.slice(1).split('/').filter(Boolean)) {
    let key = raw;
    try {
      key = decodeURIComponent(raw);
    } catch {
      key = raw;
    }
    key = key.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(cur) && !Array.isArray(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function deref(s, root) {
  let cur = s;
  for (let i = 0; i < 10 && isObject(cur) && typeof cur.$ref === 'string'; i += 1) {
    const target = pointer(root, cur.$ref);
    if (!isObject(target)) return cur;
    cur = target;
  }
  return isObject(cur) ? cur : {};
}

function typeOf(raw, root, depth = 0) {
  const s = deref(raw, root);
  if (typeof s.$ref === 'string') return `$ref ${s.$ref} (not resolved: read it yourself)`;
  if (Array.isArray(s.enum)) return `one of ${s.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  if ('const' in s) return `exactly ${JSON.stringify(s.const)}`;
  const alts = s.anyOf ?? s.oneOf;
  if (Array.isArray(alts) && depth < MAX_DEPTH) return alts.map((x) => typeOf(x, root, depth + 1)).join(' or ');
  const t = Array.isArray(s.type) ? s.type.join(' or ') : s.type ?? (isObject(s.properties) ? 'object' : 'any type');
  if (t === 'array' && isObject(s.items) && depth < MAX_DEPTH) return `array of ${typeOf(s.items, root, depth + 1)}`;
  return t;
}

function fields(raw, root, path = '', depth = 0, out = []) {
  const s = deref(raw, root);
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const extra = s.additionalProperties === false ? 'not allowed' : 'allowed (additionalProperties is not false)';
  out.push(`  object ${path || '(top level)'}: extra keys ${extra}`);
  const nested = [];
  for (const [name, value] of Object.entries(isObject(s.properties) ? s.properties : {})) {
    const p = deref(value, root);
    const full = path ? `${path}.${name}` : name;
    const parts = [full, typeOf(p, root)];
    if (required.has(name)) parts.push('required');
    parts.push(...SCHEMA_LIMITS.filter((k) => p[k] !== undefined).map((k) => `${k}=${show(p[k])}`));
    out.push(`     - ${parts.join('  ')}`);
    const items = deref(p.items, root);
    if (isObject(p.properties)) nested.push([p, full]);
    else if (isObject(items.properties)) nested.push([items, `${full}[]`]);
  }
  for (const [p, full] of nested) {
    if (depth + 1 < MAX_DEPTH) fields(p, root, full, depth + 1, out);
    else out.push(`  object ${full}: deeper than ${MAX_DEPTH} levels, read it in the schema itself`);
  }
  return out;
}

function bodyLines(raw, root) {
  const s = deref(raw, root);
  const items = deref(s.items, root);
  if (isObject(s.properties) || s.type === 'object') return fields(s, root);
  if (isObject(items.properties)) return [`  body: ${typeOf(s, root)}`, ...fields(items, root, '[]')];
  return [`  body: ${typeOf(s, root)}`];
}

function openApiLines(j) {
  const lines = [];
  for (const [path, rawItem] of Object.entries(isObject(j.paths) ? j.paths : {})) {
    const item = deref(rawItem, j);
    for (const method of BODY_METHODS) {
      if (!isObject(item[method])) continue;
      const op = item[method];
      let schema;
      let media = '';
      let required = false;
      if (isObject(op.requestBody)) {
        const rb = deref(op.requestBody, j);
        const content = isObject(rb.content) ? rb.content : {};
        const types = Object.keys(content);
        media = types.find((t) => /json/i.test(t)) ?? types[0] ?? '';
        schema = content[media]?.schema;
        required = rb.required === true;
      } else if (Array.isArray(op.parameters)) {
        const param = op.parameters.map((p) => deref(p, j)).find((p) => p.in === 'body');
        if (param) {
          schema = param.schema;
          media = (op.consumes ?? j.consumes ?? ['application/json'])[0];
          required = param.required === true;
        }
      }
      if (!isObject(schema)) continue;
      lines.push(`operation ${method.toUpperCase()} ${path}: body ${media}${required ? ', required' : ''}`);
      lines.push(...bodyLines(schema, j));
    }
  }
  return lines.length
    ? [...lines, 'note: only request bodies are listed. Read the query, path and header parameters of your operation yourself.']
    : ['operations: no request body is declared. Read the parameters of your operation yourself.'];
}

function schemaLines(j) {
  const tools = toolsOf(j);
  if (tools.length) return tools.flatMap((t) => [`tool ${t.name}:`, ...fields(t.schema, t.schema)]);
  if (isOpenApi(j)) return openApiLines(j);
  return isSchema(j) ? ['schema fields:', ...fields(j, j)] : [];
}

function selfContract(body, type) {
  const j = parsedJson(body, type);
  if (isObject(j)) {
    if (isOpenApi(j)) return 'an OpenAPI document';
    if (typeof j.asyncapi === 'string') return 'an AsyncAPI document';
  }
  const tools = toolsOf(j).length;
  if (tools) return tools === 1 ? 'an MCP tool definition' : `${tools} MCP tool definitions`;
  if (isSchema(j)) return 'a JSON Schema';
  if (/^(openapi|swagger|asyncapi)\s*:\s*['"]?\d/m.test(unBom(body).trimStart().slice(0, 2000))) return 'an API description in YAML';
  return null;
}

const isHtml = (body, type) =>
  /html|xml/i.test(type) ||
  (!type && /<(!doctype|html|head|body|link|form|meta|main|article|section|div|span|p|a|b|i|br|h[1-6]|ul|ol|li|table|time|script|style)\b/i.test(body));

function pageLine(page) {
  const status = page.status === null ? '' : ` (${page.status}${page.type ? `, ${page.type}` : ''})`;
  return `page: ${page.where}${status}${page.truncated ? `, cut at ${MAX_BYTES / 1024 / 1024} MB` : ''}`;
}

function signInLines(page, html) {
  const signIn =
    page.status === 401 ||
    page.status === 403 ||
    html.password ||
    (page.redirected && SIGN_IN_PATH.test(urlPart(page.where, 'pathname')));
  if (!signIn) return [];
  return [
    'sign-in: this may be a sign-in page, not the page you meant. Ask Mike to save the signed-in page ' +
      'into the session scratchpad, then run: node find-contract.mjs <saved-file> --base <its URL>',
  ];
}

function report(page) {
  const lines = [pageLine(page)];
  const own = selfContract(page.body, page.type);
  const html = isHtml(page.body, page.type) ? scan(page.body, page.base) : { links: [], forms: [], dates: [], password: false };
  const links = [...html.links, ...linkHeader(page.header, page.base)];
  lines.push(...signInLines(page, html));
  if (own) lines.push(`itself: this response is ${own}.`);
  if (own === 'an API description in YAML') {
    lines.push('fields: this script does not parse YAML. Read the request body schema of your operation yourself, and quote it.');
  }
  lines.push(...schemaLines(parsedJson(page.body, page.type)));

  lines.push(links.length ? 'declared contracts:' : 'declared contracts: none on this page');
  links.forEach((l, i) => {
    const where = l.url ?? `${l.href} (relative: run again with --base <page URL>)`;
    lines.push(`  ${i + 1}. ${l.rel.padEnd(12)} ${where}${l.type ? `  type ${l.type}` : ''}  from ${l.from}`);
  });

  lines.push(html.forms.length ? 'forms:' : 'forms: none in this HTML');
  html.forms.forEach((f, i) => {
    const target = f.url ?? `${f.action || "this page's own URL"} (relative: run again with --base <page URL>)`;
    lines.push(`  ${i + 1}. ${f.method} ${target}  ${f.enctype}`);
    if (f.fields.length === 0) lines.push('     no named fields in this HTML');
    for (const x of f.fields) {
      const parts = [x.name, x.type];
      if (x.required) parts.push('required');
      parts.push(...x.limits);
      if (x.options.length) parts.push(`options: ${x.options.map((o) => JSON.stringify(o)).join(', ')}`);
      if (x.value !== undefined) parts.push(`value ${JSON.stringify(x.value)}`);
      lines.push(`     - ${parts.join('  ')}`);
    }
  });

  const found = Boolean(own) || links.length > 0 || html.forms.length > 0;
  const rules = 'the required fields, their types and limits, and whether extra keys are allowed';
  if (links.length) {
    lines.push(`next: open each contract above (--open prints them) and quote what your body must follow: ${rules}. Build the body from that quote.`);
  } else if (own) {
    lines.push(`next: quote what your body must follow from this response: ${rules}. Build the body from that quote.`);
  } else if (found) {
    lines.push("next: quote the form's fields and limits, then build the body from them.");
  } else {
    lines.push('next: nothing is declared here. Ask Mike where the contract is. Do not guess a shape, and do not send a guess to learn from the error.');
  }
  return { lines, links, found };
}

const FLAG_WORD = /^-{1,2}[A-Za-z0-9?][\w.?-]*(=\S*)?$/;
const PLACEHOLDER = /^[<\[{(]|[>\]})]$|^[A-Z][A-Z0-9_-]*$|^\.\.\.$/;

function isFlagLine(line) {
  const spec = line.trim().split(/\s{2,}|\t/)[0];
  const words = spec.split(/,?\s+|,/).filter(Boolean);
  if (!FLAG_WORD.test(words[0] ?? '')) return false;
  let args = 0;
  for (const t of words) {
    if (FLAG_WORD.test(t)) args = 0;
    else if ((args += 1) > 1 && !PLACEHOLDER.test(t)) return false;
  }
  return true;
}

function helpText(text) {
  const lines = text.split('\n');
  const usage = [];
  lines.forEach((line, i) => {
    const inline = /^\s*usage:\s*\S/i.test(line);
    const header = /^\s*usage:?\s*$/i.test(line);
    if (!inline && !header) return;
    if (inline) usage.push(line.trim());
    for (let k = i + 1; k < lines.length; k += 1) {
      const next = lines[k];
      if (next.trim() === '' || isFlagLine(next) || (!header && !/^\s/.test(next))) break;
      usage.push(next.trim());
    }
  });
  const flags = lines.filter(isFlagLine).map((l) => l.trim());
  return { usage, flags };
}

function cliReport(where, text) {
  const { usage, flags } = helpText(text);
  const lines = [`help text: ${where}`];
  lines.push(usage.length ? 'usage:' : 'usage: no usage line found');
  for (const u of usage) lines.push(`  ${u}`);
  lines.push(flags.length ? `flags: ${flags.length} declared` : 'flags: none found in this text');
  flags.forEach((f, i) => lines.push(`  ${i + 1}. ${f}`));
  lines.push(
    flags.length
      ? 'next: quote each flag you pass, with its argument, from the lines above. A flag that is not listed is not declared: do not pass it to see what happens.'
      : 'next: this text declares no flags. Check that it is the help of the command you will run, or ask Mike where its options are documented.',
  );
  return { lines, found: flags.length > 0 };
}

function visibleText(body, type) {
  if (!isHtml(body, type)) return [squash(body)];
  const html = stripped(body);
  return [squash(decode(html.replace(/<[^>]*>/g, ' '))), squash(decode(html.replace(/<[^>]*>/g, '')))];
}

function quoteReport(page, quote) {
  const lines = [pageLine(page)];
  const html = isHtml(page.body, page.type) ? scan(page.body, page.base) : { dates: [], password: false };
  lines.push(...signInLines(page, html));
  const failed = page.status !== null && (page.status < 200 || page.status > 299);
  const wanted = squash(quote);
  const found = !failed && wanted !== '' && visibleText(page.body, page.type).some((t) => t.includes(wanted));
  if (failed) lines.push(`quote: not checked. The server answered ${page.status}, so this is not the page that states the fact.`);
  else lines.push(found ? 'quote: found on the page, word for word' : 'quote: NOT found on the page');
  const dates = [...(page.lastModified ? [`header Last-Modified ${page.lastModified}`] : []), ...html.dates];
  lines.push(dates.length ? 'dates:' : 'dates: none on the page. Cite the date you opened it.');
  for (const d of dates) lines.push(`  - ${d}`);
  lines.push(
    found
      ? 'next: cite the URL, the date, and this quote with the fact you state.'
      : 'next: copy the sentence from the page itself, not from a summary of it, and run this again. If no sentence on the page states the fact, mark the fact unchecked.',
  );
  return { lines, found };
}

const why = (e) =>
  `${e.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000} seconds` : e.message}` +
  (e.cause ? `: ${e.cause.code ?? e.cause.message}` : '');

async function capped(res) {
  const reader = res.body?.getReader();
  if (!reader) return { body: '', truncated: false };
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { body: Buffer.concat(chunks).toString('utf8'), truncated: false };
    size += value.length;
    if (size > MAX_BYTES) {
      chunks.push(value.subarray(0, value.length - (size - MAX_BYTES)));
      await reader.cancel();
      return { body: Buffer.concat(chunks).toString('utf8'), truncated: true };
    }
    chunks.push(value);
  }
}

async function get(start, { pageHost = urlPart(start, 'hostname'), fetchImpl = fetch, resolveHost = lookup } = {}) {
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    if (!/^https?:$/i.test(urlPart(url, 'protocol'))) throw new Error(`refused ${url}: only http and https are fetched`);
    if (urlPart(url, 'hostname') !== pageHost && (await isLocal(url, resolveHost))) {
      throw new Error(`refused ${url}: a local or private address that is not the page's own host. Ask Mike before you open it`);
    }
    const res = await fetchImpl(url, {
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept: 'text/html,application/xhtml+xml,application/json,application/yaml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url).href;
      continue;
    }
    const { body, truncated } = await capped(res);
    return {
      url,
      status: res.status,
      type: res.headers.get('content-type') ?? '',
      link: res.headers.get('link') ?? '',
      lastModified: res.headers.get('last-modified') ?? '',
      body: unBom(body),
      truncated,
    };
  }
  throw new Error(`more than ${MAX_HOPS} redirects from ${start}`);
}

async function openAll(links, pageUrl, options = {}) {
  const urls = [...new Set(links.map((l) => l.url).filter((u) => u && /^https?:/i.test(u)))];
  if (urls.length === 0) {
    console.log('open: no absolute http or https contract URL to open');
    return;
  }
  for (const [i, u] of urls.entries()) {
    try {
      const r = await get(u, { pageHost: urlPart(pageUrl, 'hostname'), ...options });
      const cut = r.body.length > PRINT_MAX;
      console.log(`\n--- contract ${i + 1}: ${r.url} (${r.status}${r.type ? `, ${r.type}` : ''}) ---`);
      console.log(cut ? r.body.slice(0, PRINT_MAX) : r.body);
      console.log(`--- end of contract ${i + 1}${cut || r.truncated ? `, cut at ${PRINT_MAX.toLocaleString('en-US')} characters` : ''} ---`);
    } catch (e) {
      console.log(`\n--- contract ${i + 1}: ${u} not opened: ${why(e)} ---`);
    }
  }
}

function inScratchpad(real, sid = process.env.CLAUDE_CODE_SESSION_ID, uid = process.getuid?.()) {
  if (!sid || !/^[A-Za-z0-9._-]+$/.test(sid) || uid === undefined) return false;
  const m = real.match(/^(?:\/private)?\/tmp\/claude-(\d+)\/[^/]+\/([^/]+)\/scratchpad(?:\/|$)/);
  return Boolean(m) && m[1] === String(uid) && m[2] === sid;
}

async function readInside(path) {
  const cwd = await realpath(process.cwd());
  let real;
  try {
    real = await realpath(resolve(cwd, path));
  } catch {
    throw new Error(`cannot read ${path}: no such file`);
  }
  const rel = relative(cwd, real);
  const inCwd = !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  if (!inCwd && !inScratchpad(real)) {
    throw new Error(
      `${path} is outside the working folder (${cwd}) and the session scratchpad. Ask Mike before reading it. If he agrees, copy it into the session scratchpad and run this again.`,
    );
  }
  return unBom(await readFile(real, 'utf8'));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return unBom(Buffer.concat(chunks).toString('utf8'));
}

async function selfTest() {
  const html = `<!doctype html>
<html><head>
<base href="https://api.example.test/v2/">
<link rel="stylesheet" href="site.css">
<link rel="service-desc" type="application/openapi+json" href="openapi.json">
<link rel="describedby" href="note.schema.json">
<link rel="service-doc"href="https://docs.example.test/notes">
<link rel="alternate" type="application/rss+xml" href="feed.xml">
<link rel="alternate" type="application/schema+json" href="note.schema.json">
<link rel="alternate" href="note.yaml">
<meta property="article:modified_time" content="2026-10-01T09:00:00Z">
<!-- <link rel="describedby" href="old.json"> -->
<script>const s = '<link rel="describedby" href="fake.json">';</script>
</head><body>
<p>Our newest model is <b>Nova&nbsp;3</b>, released <time datetime="2026-09-30">last week</time>.</p>
<p>Nova&rsquo;s price is &pound;5 &mdash; for now&hellip;</p>
<form action="notes" method="post">
<input name="title" required maxlength="80">
<textarea name="body" required></textarea>
<select name="kind"><option value="note">Note</option><option>Task</option></select>
<input type="hidden" name="form_id" value="n&amp;1">
<input name="">
<input type="submit" value="Save">
</form>
</body></html>`;
  const r = scan(html, 'https://example.test/notes/new');
  assert.deepEqual(
    r.links.map((l) => [l.rel, l.url]),
    [
      ['service-desc', 'https://api.example.test/v2/openapi.json'],
      ['describedby', 'https://api.example.test/v2/note.schema.json'],
      ['service-doc', 'https://docs.example.test/notes'],
      ['alternate', 'https://api.example.test/v2/note.schema.json'],
      ['alternate', 'https://api.example.test/v2/note.yaml'],
    ],
  );
  assert.equal(r.forms.length, 1);
  const [f] = r.forms;
  assert.equal(f.method, 'POST');
  assert.equal(f.url, 'https://api.example.test/v2/notes');
  assert.deepEqual(f.fields.map((x) => x.name), ['title', 'body', 'kind', 'form_id']);
  assert.deepEqual(f.fields[0].limits, ['maxlength=80']);
  assert.equal(f.fields[0].required, true);
  assert.equal(f.fields[1].type, 'textarea');
  assert.deepEqual(f.fields[2].options, ['note', 'Task']);
  assert.equal(f.fields[3].value, 'n&1');
  assert.equal(r.password, false);
  assert.deepEqual(r.dates, ['meta article:modified_time 2026-10-01T09:00:00Z', 'time 2026-09-30']);
  assert.equal(scan('<form><input type="password" name="pw"></form>', null).password, true);

  assert.equal(LATIN1.length, 96);
  assert.equal(decode('&eacute;&yuml;&nbsp;&rsquo;&mdash;&ndash;&hellip;&AMP;&Bogus;'), 'éÿ ’—–…&&Bogus;');

  const h = linkHeader(
    '<https://api.example.test/docs>; rel="service-doc", <note.json>; rel=describedby; type="application/schema+json", <https://x.test/a>; rel=next, <https://x.test/b>; title="a, b; c"; rel="describedby"',
    'https://api.example.test/v2/x',
  );
  assert.deepEqual(
    h.map((l) => [l.rel, l.url]),
    [
      ['service-doc', 'https://api.example.test/docs'],
      ['describedby', 'https://api.example.test/v2/note.json'],
      ['describedby', 'https://x.test/b'],
    ],
  );

  assert.equal(selfContract('{"$schema":"https://json-schema.org/draft-07/schema#","type":"object"}', 'application/json'), 'a JSON Schema');
  assert.equal(selfContract('\uFEFF{"$schema":"https://json-schema.org/draft-07/schema#","type":"object"}', ''), 'a JSON Schema');
  assert.equal(schemaLines(parsedJson('\uFEFF{"type":"object","properties":{"a":{"type":"string"}}}', ''))[2], '     - a  string');
  assert.equal(selfContract('openapi: "3.1.0"\ninfo:\n  title: Notes\n', 'application/yaml'), 'an API description in YAML');
  assert.equal(selfContract('{"openapi":"3.1.0","paths":{}}', ''), 'an OpenAPI document');
  assert.equal(selfContract('{"name":"x","items":[]}', 'application/json'), null);
  const page = (body, extra = {}) => ({ where: 'x', status: null, type: '', header: '', body, base: null, redirected: false, lastModified: '', ...extra });
  assert.equal(report(page('<p>hi</p>')).found, false);
  assert.ok(report(page('<p>hi</p>')).lines.at(-1).includes('Ask Mike where the contract is'));
  assert.ok(report(page('<p>hi</p>', { status: 401 })).lines.some((l) => l.startsWith('sign-in:')));
  assert.ok(!report(page('<p>hi</p>', { status: 200 })).lines.some((l) => l.startsWith('sign-in:')));
  assert.ok(report(page('openapi: 3.0.0\n')).lines.some((l) => l.startsWith('fields: this script does not parse YAML')));

  const openapi = {
    openapi: '3.1.0',
    paths: {
      '/notes': {
        get: { responses: {} },
        post: { requestBody: { $ref: '#/components/requestBodies/Note' } },
      },
      '/bulk': { put: { requestBody: { content: { 'text/plain': {}, 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Note' } } } } } } },
    },
    components: {
      requestBodies: { Note: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } } },
      schemas: { Note: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 80 } } } },
    },
  };
  assert.deepEqual(schemaLines(openapi), [
    'operation POST /notes: body application/json, required',
    '  object (top level): extra keys not allowed',
    '     - title  string  required  maxLength=80',
    'operation PUT /bulk: body application/json',
    '  body: array of object',
    '  object []: extra keys not allowed',
    '     - [].title  string  required  maxLength=80',
    'note: only request bodies are listed. Read the query, path and header parameters of your operation yourself.',
  ]);
  const swagger = { swagger: '2.0', paths: { '/x': { post: { parameters: [{ in: 'query', name: 'q' }, { in: 'body', name: 'b', required: true, schema: { type: 'object', properties: { n: { type: 'integer' } } } }] } } } };
  assert.equal(schemaLines(swagger)[0], 'operation POST /x: body application/json, required');
  assert.equal(schemaLines(swagger)[2], '     - n  integer');
  assert.deepEqual(schemaLines({ openapi: '3.0.0', paths: { '/x': { get: {} } } }), ['operations: no request body is declared. Read the parameters of your operation yourself.']);

  const tool = {
    name: 'create_note',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'meta'],
      properties: {
        title: { type: 'string', maxLength: 80 },
        kind: { enum: ['note', 'task'] },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        due: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
        meta: { $ref: '#/$defs/Meta' },
        links: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } } } },
      },
      $defs: { Meta: { type: 'object', properties: { source: { type: 'string', pattern: '^[a-z]+$' } } } },
    },
  };
  const toolLines = schemaLines({ tools: [tool] });
  assert.deepEqual(toolLines, [
    'tool create_note:',
    '  object (top level): extra keys not allowed',
    '     - title  string  required  maxLength=80',
    '     - kind  one of "note", "task"',
    '     - tags  array of string  maxItems=5',
    '     - due  string or null',
    '     - meta  object  required',
    '     - links  array of object',
    '  object meta: extra keys allowed (additionalProperties is not false)',
    '     - meta.source  string  pattern=^[a-z]+$',
    '  object links[]: extra keys allowed (additionalProperties is not false)',
    '     - links[].url  string',
  ]);
  assert.deepEqual(schemaLines({ jsonrpc: '2.0', result: { tools: [tool] } }), toolLines);
  assert.deepEqual(schemaLines({ name: 'create_note', parameters: tool.inputSchema }), toolLines);
  assert.equal(selfContract(JSON.stringify({ tools: [tool, { ...tool, name: 'b' }] }), ''), '2 MCP tool definitions');
  assert.equal(schemaLines({ type: 'object', properties: { a: { type: 'integer', minimum: 1 } } })[2], '     - a  integer  minimum=1');
  assert.deepEqual(schemaLines({ name: 'x' }), []);
  const loop = { type: 'object', properties: { self: { $ref: '#' } } };
  assert.equal(schemaLines(loop).at(-1), `  object self.self.self.self: deeper than ${MAX_DEPTH} levels, read it in the schema itself`);
  assert.equal(typeOf({ $ref: '#/nowhere' }, {}), '$ref #/nowhere (not resolved: read it yourself)');
  assert.equal(typeOf({ $ref: '#/$defs/100%' }, { $defs: { '100%': { type: 'string' } } }), 'string');

  const help = helpText(`Create a pull request.

USAGE
  gh pr create [flags]
  gh pr create --fill

FLAGS
  -B, --base branch       The branch into which you want your code merged
  -d, --draft             Mark pull request as a draft
      --title string      Title for the pull request
  -1                      List one per line
-1 means unlimited, and 0 turns it off.
Some prose that mentions -x in the middle.
`);
  assert.deepEqual(help.usage, ['gh pr create [flags]', 'gh pr create --fill']);
  assert.deepEqual(help.flags.map((x) => x.split(/\s{2,}/)[0]), ['-B, --base branch', '-d, --draft', '--title string', '-1']);
  assert.deepEqual(
    helpText('usage: git commit [<options>]\n   or: git commit --amend\n\n    -m, --message <message>\n    -F, --file <file>  read message\n').usage,
    ['usage: git commit [<options>]', 'or: git commit --amend'],
  );
  assert.deepEqual(helpText('Usage: tool [options]\n  -h  help\n').usage, ['Usage: tool [options]']);
  assert.equal(cliReport('-', 'no flags here').found, false);

  const q = (quote, extra) => quoteReport(page(html, extra), quote);
  assert.equal(q('Our newest model is Nova 3, released last week.').found, true);
  assert.equal(q('Nova’s price is £5 — for now…').found, true);
  assert.equal(q('Our newest model is Nova 4').found, false);
  assert.equal(q('   ').found, false);
  assert.equal(q('Nova 3', { status: 404 }).found, false);
  assert.ok(q('Nova 3', { status: 500 }).lines.some((l) => l.includes('The server answered 500')));
  assert.equal(q('Nova 3', { status: 200 }).found, true);
  assert.ok(q('Nova 3', { lastModified: 'Wed, 30 Sep 2026 10:00:00 GMT' }).lines.includes('  - header Last-Modified Wed, 30 Sep 2026 10:00:00 GMT'));
  assert.equal(quoteReport(page('Released: v2.4.1 on 2026-10-02.\n'), 'v2.4.1 on 2026-10-02').found, true);
  assert.ok(quoteReport(page('plain text'), 'plain').lines.includes('dates: none on the page. Cite the date you opened it.'));
  assert.equal(quoteReport(page('<p>a <script>var t = "Nova 9";</script> b</p>'), 'Nova 9').found, false);

  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.20.0.1', '192.168.1.20', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe']) {
    assert.equal(privateIp(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '172.32.0.1', '2606:4700::1111', '::ffff:5db8:d822']) assert.equal(privateIp(ip), false, ip);
  const dns = (table) => async (host) => {
    if (!(host in table)) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return table[host].map((address) => ({ address }));
  };
  const resolveHost = dns({ 'public.example.test': ['93.184.216.34'], 'evil.example.test': ['93.184.216.35', '10.0.0.5'] });
  assert.equal(await isLocal('http://localhost:8080/x', resolveHost), true);
  assert.equal(await isLocal('http://[::1]:8080/openapi.json', resolveHost), true);
  assert.equal(await isLocal('http://2130706433/', resolveHost), true);
  assert.equal(await isLocal('https://public.example.test/a', resolveHost), false);
  assert.equal(await isLocal('https://evil.example.test/a', resolveHost), true);
  assert.equal(await isLocal('not a url', resolveHost), true);
  await assert.rejects(isLocal('https://nowhere.example.test/', resolveHost), /cannot resolve nowhere\.example\.test/);

  const calls = [];
  const fake = (routes) => async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.method, undefined);
    assert.equal(init.body, undefined);
    const [status, headers, body = ''] = routes[url] ?? [404, {}];
    return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
  };
  const routes = {
    'https://public.example.test/a': [302, { location: 'http://169.254.169.254/latest/meta-data/' }],
    'https://public.example.test/b': [301, { location: '/c' }],
    'https://public.example.test/c': [200, { 'content-type': 'application/json' }, '\uFEFF{"type":"object","properties":{}}'],
    'https://public.example.test/d': [302, { location: 'https://evil.example.test/x' }],
    'https://public.example.test/loop': [302, { location: '/loop' }],
    'https://public.example.test/big': [200, {}, 'x'.repeat(MAX_BYTES + 10)],
    'http://localhost:9000/a': [302, { location: 'http://localhost:9000/b' }],
    'http://localhost:9000/b': [200, {}, 'ok'],
    'http://localhost:9000/c': [302, { location: 'http://127.0.0.1:9001/' }],
  };
  const opts = { fetchImpl: fake(routes), resolveHost };
  await assert.rejects(get('https://public.example.test/a', opts), /refused http:\/\/169\.254\.169\.254/);
  assert.deepEqual(calls, ['https://public.example.test/a']);
  const followed = await get('https://public.example.test/b', opts);
  assert.equal(followed.url, 'https://public.example.test/c');
  assert.ok(followed.body.startsWith('{'));
  calls.length = 0;
  await assert.rejects(get('https://public.example.test/d', opts), /refused https:\/\/evil\.example\.test/);
  assert.deepEqual(calls, ['https://public.example.test/d']);
  await assert.rejects(get('https://public.example.test/loop', opts), /more than 5 redirects/);
  const big = await get('https://public.example.test/big', opts);
  assert.equal(big.truncated, true);
  assert.equal(big.body.length, MAX_BYTES);
  assert.equal((await get('http://localhost:9000/a', opts)).body, 'ok');
  calls.length = 0;
  await assert.rejects(get('http://localhost:9000/c', opts), /refused http:\/\/127\.0\.0\.1:9001/);
  assert.deepEqual(calls, ['http://localhost:9000/c']);
  calls.length = 0;
  await assert.rejects(get('http://localhost:9000/b', { ...opts, pageHost: 'public.example.test' }), /refused/);
  assert.deepEqual(calls, []);
  await assert.rejects(get('file:///etc/hosts', opts), /only http and https/);

  assert.equal(inScratchpad('/private/tmp/claude-503/-Users-x/abc-1/scratchpad/cut/a.txt', 'abc-1', 503), true);
  assert.equal(inScratchpad('/tmp/claude-503/proj/abc-1/scratchpad', 'abc-1', 503), true);
  assert.equal(inScratchpad('/private/tmp/claude-503/-Users-x/other/scratchpad/a.txt', 'abc-1', 503), false);
  assert.equal(inScratchpad('/private/tmp/claude-504/-Users-x/abc-1/scratchpad/a.txt', 'abc-1', 503), false);
  assert.equal(inScratchpad('/private/tmp/claude-503/-Users-x/abc-1/scratchpadx/a.txt', 'abc-1', 503), false);
  assert.equal(inScratchpad('/private/tmp/claude-503/-Users-x/abc-1/scratchpad/a.txt', undefined, 503), false);
  assert.equal(inScratchpad('/private/tmp/claude-503/-Users-x/a/b/scratchpad/a.txt', 'a/b', 503), false);
  console.log('self-test ok');
  return 0;
}

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  let target;
  let base;
  let quote;
  let open = false;
  let cli = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--open') open = true;
    else if (a === '--cli') cli = true;
    else if (a === '--base') {
      i += 1;
      base = argv[i];
      if (base === undefined || !/^https?:\/\//i.test(base) || absolute(base) === null) throw new Error('--base takes an http or https URL');
    } else if (a === '--quote') {
      i += 1;
      quote = argv[i];
      if (quote === undefined || squash(quote) === '') throw new Error('--quote takes the sentence to look for');
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}\n${USAGE}`);
    else if (target === undefined) target = a;
    else throw new Error(`one page at a time\n${USAGE}`);
  }
  if (target === undefined) throw new Error(USAGE);
  if ([open, cli, quote !== undefined].filter(Boolean).length > 1) throw new Error(`--open, --cli and --quote do not go together\n${USAGE}`);
  const isUrl = /^https?:\/\//i.test(target);
  if (cli && isUrl) throw new Error('--cli reads help text from a file in the working folder or the session scratchpad, or from stdin (-)');

  let page;
  if (isUrl) {
    let r;
    try {
      r = await get(target);
    } catch (e) {
      throw new Error(`could not fetch ${target}: ${why(e)}`);
    }
    page = { where: r.url, status: r.status, type: r.type, header: r.link, lastModified: r.lastModified, body: r.body, truncated: r.truncated, base: base ?? r.url, redirected: r.url !== target };
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    throw new Error('give an http or https URL, a file in the working folder or the session scratchpad, or - for stdin');
  } else {
    const body = target === '-' ? await readStdin() : await readInside(target);
    page = { where: target === '-' ? 'stdin' : target, status: null, type: '', header: '', lastModified: '', body, base: base ?? null, redirected: false };
  }

  if (cli) {
    const { lines, found } = cliReport(page.where, page.body);
    console.log(lines.join('\n'));
    return found ? 0 : 2;
  }
  if (quote !== undefined) {
    const { lines, found } = quoteReport(page, quote);
    console.log(lines.join('\n'));
    return found ? 0 : 2;
  }
  const { lines, links, found } = report(page);
  console.log(lines.join('\n'));
  if (open) await openAll(links, page.base);
  return found ? 0 : 2;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`find-contract: ${error.message}`);
  process.exitCode = 1;
}
