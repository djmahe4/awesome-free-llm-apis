import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * API trap: names the members that DO exist when generated code calls one that does not.
 *
 * A 7B model called `stmt.finalize()` on a node:sqlite statement (it has none). The check reported "stmt.finalize is not a
 * function", which says nothing about what to call instead. Nothing in the workspace says it either, and no probe can
 * check a claim nobody proposed. So the check itself runs under a preload that wraps the selected built-in modules: reading
 * a member that is missing returns a function that throws "<Type> has no member 'x'. It has: a, b, c", so the existing
 * repair brief carries the real API surface, observed from the real runtime instead of a curated list.
 *
 * Covers require() (a Module._load patch) and, where Node has module.registerHooks, import of the built-in from ESM too
 * (vitest). Only class instances and the module object are wrapped; plain data (rows, arrays, buffers) is returned as is.
 * Modules come from CODING_AGENTS_API_TRAP (comma separated, default "node:sqlite"); an empty value disables it.
 */
export const DEFAULT_TRAPPED_MODULES = 'node:sqlite';

export const API_TRAP_SOURCE = String.raw`'use strict';
const Module = require('node:module');
const raw = process.env.CODING_AGENTS_API_TRAP;
const TRAPPED = new Set((raw === undefined ? 'node:sqlite' : raw).split(',').map(s => s.trim()).filter(Boolean));
if (TRAPPED.size === 0) return;
const SKIP = new Set(['then', 'catch', 'finally', 'toJSON', 'inspect', 'constructor', 'asymmetricMatch', 'nodeType', 'tagName', '$$typeof', '__esModule', 'length', 'name', 'prototype', 'toString', 'valueOf', 'toLocaleString', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__proto__', 'default']);
const unwrapOf = new WeakMap();
const wrapOf = new WeakMap();
const real = v => (v !== null && (typeof v === 'object' || typeof v === 'function') && unwrapOf.has(v)) ? unwrapOf.get(v) : v;

function members(target) {
  const out = new Set();
  for (let o = target; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor' && !k.startsWith('_') && k !== 'caller' && k !== 'callee' && k !== 'arguments') out.add(k);
  }
  return [...out].sort();
}
function plain(v) {
  if (v === null || typeof v !== 'object') return true;
  if (Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof Date || v instanceof Map || v instanceof Set || v instanceof Promise || v instanceof RegExp || v instanceof Error || v instanceof ArrayBuffer) return true;
  return Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null;
}
function label(target, fallback) {
  const c = target && target.constructor && target.constructor.name;
  return c && c !== 'Object' && c !== 'Function' ? c : fallback;
}
function wrapValue(v, name) {
  if (typeof v === 'function') return wrapFunction(v, name);
  if (v !== null && typeof v === 'object' && !plain(v)) return wrapObject(v, name);
  return v;
}
function wrapObject(target, name) {
  if (wrapOf.has(target)) return wrapOf.get(target);
  const proxy = new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t);
      if (typeof prop === 'symbol') return v;
      if (v === undefined && !(prop in t) && !SKIP.has(prop)) {
        const who = label(t, name);
        return function missing() { throw new TypeError(who + " has no member '" + prop + "'. It has: " + members(t).join(', ')); };
      }
      return wrapValue(v, name + '.' + prop);
    },
  });
  wrapOf.set(target, proxy);
  unwrapOf.set(proxy, target);
  return proxy;
}
function wrapFunction(fn, name) {
  if (wrapOf.has(fn)) return wrapOf.get(fn);
  const proxy = new Proxy(fn, {
    apply(f, thisArg, args) { return wrapValue(Reflect.apply(f, real(thisArg), args.map(real)), name + '()'); },
    construct(f, args) { return wrapObject(Reflect.construct(f, args.map(real)), label(f.prototype, name)); },
    get(f, prop) {
      const v = Reflect.get(f, prop, f);
      if (typeof prop === 'symbol') return v;
      if (v === undefined && !(prop in f) && !SKIP.has(prop) && /^[A-Za-z]/.test(prop) && f.prototype) {
        return function missing() { throw new TypeError(name + " has no static member '" + prop + "'. It has: " + members(f).join(', ')); };
      }
      return v;
    },
  });
  wrapOf.set(fn, proxy);
  unwrapOf.set(proxy, fn);
  return proxy;
}
function trapped(request) { return TRAPPED.has(request) || TRAPPED.has('node:' + request); }
function wrapModule(exportsObject, request) {
  const out = Object.create(null);
  for (const k of Object.keys(exportsObject)) out[k] = typeof exportsObject[k] === 'function' ? wrapFunction(exportsObject[k], k) : exportsObject[k];
  return new Proxy(out, {
    get(t, prop) {
      if (typeof prop === 'symbol' || prop in t || SKIP.has(prop)) return t[prop];
      return function missing() { throw new TypeError(request + " has no export '" + String(prop) + "'. It exports: " + Object.keys(t).sort().join(', ')); };
    },
  });
}
const cache = new Map();
const load = Module._load;
Module._load = function (request, parent, isMain) {
  const out = load.apply(this, arguments);
  if (!trapped(request)) return out;
  if (!cache.has(request)) cache.set(request, wrapModule(out, request));
  return cache.get(request);
};
globalThis.__codingAgentsApiTrap = request => {
  if (!cache.has(request)) cache.set(request, wrapModule(process.getBuiltinModule(request), request));
  return cache.get(request);
};
if (typeof Module.registerHooks === 'function') {
  Module.registerHooks({
    load(url, context, nextLoad) {
      if (trapped(url) && context.format !== 'commonjs-typescript') {
        const names = Object.keys(process.getBuiltinModule(url)).filter(k => /^[A-Za-z_$][\w$]*$/.test(k));
        const source = 'const w = globalThis.__codingAgentsApiTrap(' + JSON.stringify(url) + ');\nexport default w;\n' + names.map(k => 'export const ' + k + ' = w.' + k + ';').join('\n') + '\n';
        return { format: 'module', source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
`;

let cachedPath: string | undefined;

/** Writes the preload to the temp directory (once per content) and returns its path. */
export function apiTrapPreloadPath(): string {
  if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;
  const hash = crypto.createHash('sha1').update(API_TRAP_SOURCE).digest('hex').slice(0, 10);
  const file = path.join(os.tmpdir(), `coding-agents-api-trap-${hash}.cjs`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, API_TRAP_SOURCE, 'utf8');
  cachedPath = file;
  return file;
}

/** NODE_OPTIONS with the preload added (existing options are kept). Spaces in the path are quoted. */
export function withApiTrap(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.CODING_AGENTS_API_TRAP === '') return env;
  const preload = apiTrapPreloadPath();
  const quoted = /\s/.test(preload) ? `"${preload}"` : preload;
  return { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--require ${quoted}` };
}
