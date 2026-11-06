import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateSafePath, type SafePathResult, type PathSafetyOptions } from './path-safety.js';
import {
  createEvidenceBundle,
  normalizeEvidence,
  type ReverseEvidence,
} from './evidence.js';
import { defaultSessionManager } from './session-manager.js';

export interface ArtifactAnalyzerOptions extends PathSafetyOptions {
  reaAgentsPath?: string;
  skipProxy?: boolean;
  minStringLength?: number;
  maxStrings?: number;
}

export interface CustomArtifactParser {
  name: string;
  priority?: number;
  canHandle: (header: Buffer, safe: SafePathResult) => boolean;
  parse: (
    buffer: Buffer,
    safe: SafePathResult,
    options?: ArtifactAnalyzerOptions
  ) =>
    | Promise<Partial<ReverseEvidence> | Record<string, unknown>>
    | Partial<ReverseEvidence>
    | Record<string, unknown>;
}

const customParsers: CustomArtifactParser[] = [];

const MAX_STRING_LEN = 2048;
const MAX_URL_SCAN_LEN = 1024 * 1024; // 1MB max scan
const DEFAULT_MAX_URLS = 50;
const CUSTOM_PARSER_TIMEOUT_MS = 5000;
const MAX_CUSTOM_ITEMS = 100;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PROTECTED_CORE_FIELDS = new Set([
  'format',
  'mimeType',
  'sizeBytes',
  'entropy',
  'isPackedOrEncrypted',
  'hashes',
]);

function sanitizeAndMergeCustomFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.has(key) || key.startsWith('__')) {
      continue;
    }
    if (PROTECTED_CORE_FIELDS.has(key)) {
      continue;
    }
    target[key] = value;
  }
}

function withTimeout<T>(promise: Promise<T> | T, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Custom parser "${label}" timed out after ${ms}ms`));
    }, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeoutPromise,
  ]);
}

export function registerCustomArtifactParser(parser: CustomArtifactParser): void {
  if (
    !parser ||
    typeof parser.name !== 'string' ||
    !parser.name.trim() ||
    typeof parser.canHandle !== 'function' ||
    typeof parser.parse !== 'function'
  ) {
    throw new TypeError(
      'Invalid CustomArtifactParser: name (string), canHandle (function), and parse (function) are required'
    );
  }
  const existingIdx = customParsers.findIndex((p) => p.name === parser.name);
  if (existingIdx >= 0) {
    customParsers.splice(existingIdx, 1);
  }
  customParsers.push(parser);
  customParsers.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export function unregisterCustomArtifactParser(name: string): void {
  const idx = customParsers.findIndex((p) => p.name === name);
  if (idx >= 0) {
    customParsers.splice(idx, 1);
  }
}

export function getCustomArtifactParsers(): CustomArtifactParser[] {
  return [...customParsers];
}

export function clearCustomArtifactParsers(): void {
  customParsers.length = 0;
}

/**
 * Calculates the Shannon entropy of a buffer in bits per byte (0.0 to 8.0).
 */
export function calculateEntropy(buf: Buffer): number {
  if (!buf || buf.length === 0) {
    return 0;
  }
  const frequencies = new Uint32Array(256);
  for (let i = 0; i < buf.length; i++) {
    frequencies[buf[i]]++;
  }

  let entropy = 0;
  const len = buf.length;
  for (let i = 0; i < 256; i++) {
    const count = frequencies[i];
    if (count > 0) {
      const p = count / len;
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
}

/**
 * Detects binary file format and MIME type using magic byte signatures.
 */
export function detectMagicFormat(header: Buffer): { format: string; mimeType: string } {
  if (!header || header.length === 0) {
    return { format: 'Binary/Data', mimeType: 'application/octet-stream' };
  }

  // UTF-8 BOM: 0xEF 0xBB 0xBF
  if (header.length >= 3 && header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf) {
    return { format: 'UTF-8 with BOM', mimeType: 'text/plain; charset=utf-8' };
  }

  // UTF-16LE BOM: 0xFF 0xFE
  if (header.length >= 2 && header[0] === 0xff && header[1] === 0xfe) {
    return { format: 'UTF-16LE Text', mimeType: 'text/plain; charset=utf-16le' };
  }

  // UTF-16BE BOM: 0xFE 0xFF
  if (header.length >= 2 && header[0] === 0xfe && header[1] === 0xff) {
    return { format: 'UTF-16BE Text', mimeType: 'text/plain; charset=utf-16be' };
  }

  // ELF: 0x7F 0x45 0x4C 0x46 (0x7F 'E' 'L' 'F')
  if (
    header.length >= 4 &&
    header[0] === 0x7f &&
    header[1] === 0x45 &&
    header[2] === 0x4c &&
    header[3] === 0x46
  ) {
    return { format: 'ELF', mimeType: 'application/x-executable' };
  }

  // WASM: 0x00 0x61 0x73 0x6D (\0 'a' 's' 'm')
  if (
    header.length >= 4 &&
    header[0] === 0x00 &&
    header[1] === 0x61 &&
    header[2] === 0x73 &&
    header[3] === 0x6d
  ) {
    return { format: 'WASM', mimeType: 'application/wasm' };
  }

  // PDF: 0x25 0x50 0x44 0x46 ('%' 'P' 'D' 'F')
  if (
    header.length >= 4 &&
    header[0] === 0x25 &&
    header[1] === 0x50 &&
    header[2] === 0x44 &&
    header[3] === 0x46
  ) {
    return { format: 'PDF', mimeType: 'application/pdf' };
  }

  // GGUF: 0x47 0x47 0x55 0x46 ('G' 'G' 'U' 'F')
  if (
    header.length >= 4 &&
    header[0] === 0x47 &&
    header[1] === 0x47 &&
    header[2] === 0x55 &&
    header[3] === 0x46
  ) {
    return { format: 'GGUF', mimeType: 'application/x-gguf' };
  }

  // ZIP / Archive: 0x50 0x4B 0x03 0x04 or 0x50 0x4B 0x05 0x06 or 0x50 0x4B 0x07 0x08
  if (
    header.length >= 4 &&
    header[0] === 0x50 &&
    header[1] === 0x4b &&
    (
      (header[2] === 0x03 && header[3] === 0x04) ||
      (header[2] === 0x05 && header[3] === 0x06) ||
      (header[2] === 0x07 && header[3] === 0x08)
    )
  ) {
    return { format: 'ZIP/Archive', mimeType: 'application/zip' };
  }

  // Mach-O:
  // 0xFEEDFACE (32-bit BE), 0xCEFAEDFE (32-bit LE)
  // 0xFEEDFACF (64-bit BE), 0xCFFAEDFE (64-bit LE)
  // 0xCAFEBABE (Fat BE), 0xBEBAFECA (Fat LE)
  if (header.length >= 4) {
    const m0 = header[0];
    const m1 = header[1];
    const m2 = header[2];
    const m3 = header[3];

    if (
      (m0 === 0xfe && m1 === 0xed && m2 === 0xfa && (m3 === 0xce || m3 === 0xcf)) ||
      ((m0 === 0xce || m0 === 0xcf) && m1 === 0xfa && m2 === 0xed && m3 === 0xfe) ||
      (m0 === 0xca && m1 === 0xfe && m2 === 0xba && m3 === 0xbe) ||
      (m0 === 0xbe && m1 === 0xba && m2 === 0xfe && m3 === 0xca)
    ) {
      return { format: 'Mach-O', mimeType: 'application/x-mach-binary' };
    }
  }

  // PE / Windows Executable: 'MZ' (0x4D, 0x5A)
  if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) {
    return { format: 'PE/Windows Executable', mimeType: 'application/vnd.microsoft.portable-executable' };
  }

  // ASAR: Electron archive format (starts with 0x04, 0x00, 0x00, 0x00)
  if (
    header.length >= 4 &&
    header[0] === 0x04 &&
    header[1] === 0x00 &&
    header[2] === 0x00 &&
    header[3] === 0x00
  ) {
    return { format: 'ASAR', mimeType: 'application/x-asar' };
  }

  return { format: 'Binary/Data', mimeType: 'application/octet-stream' };
}

/**
 * Extracts printable ASCII strings with minLen and maxStrings limits.
 * Supports dual extraction: standard 1-byte ASCII and 2-byte wide-string ASCII (char, 0x00 / UTF-16LE).
 */
export function extractStrings(buf: Buffer, minLen = 4, maxStrings = 50): string[] {
  if (!buf || buf.length === 0 || maxStrings <= 0) {
    return [];
  }
  const results: string[] = [];
  let start = -1;

  // 1-byte ASCII scan
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    const isPrintable = byte >= 0x20 && byte <= 0x7e;

    if (isPrintable) {
      if (start === -1) {
        start = i;
      } else if (i - start >= MAX_STRING_LEN) {
        results.push(buf.subarray(start, i).toString('ascii'));
        if (results.length >= maxStrings) {
          return results;
        }
        start = i;
      }
    } else {
      if (start !== -1) {
        if (i - start >= minLen) {
          results.push(buf.subarray(start, i).toString('ascii'));
          if (results.length >= maxStrings) {
            return results;
          }
        }
        start = -1;
      }
    }
  }

  if (start !== -1 && buf.length - start >= minLen && results.length < maxStrings) {
    const end = Math.min(buf.length, start + MAX_STRING_LEN);
    results.push(buf.subarray(start, end).toString('ascii'));
  }

  // 2-byte wide-string ASCII scan (UTF-16LE: char in 0x20..0x7E followed by 0x00)
  if (results.length < maxStrings && buf.length >= 2 * minLen) {
    for (let offset = 0; offset < 2 && results.length < maxStrings; offset++) {
      let wideStart = -1;
      for (let i = offset; i + 1 < buf.length; i += 2) {
        const b0 = buf[i];
        const b1 = buf[i + 1];
        if (b0 >= 0x20 && b0 <= 0x7e && b1 === 0x00) {
          if (wideStart === -1) {
            wideStart = i;
          } else if ((i + 2 - wideStart) / 2 >= MAX_STRING_LEN) {
            const str = buf.subarray(wideStart, i + 2).toString('utf16le');
            if (!results.includes(str)) {
              results.push(str);
              if (results.length >= maxStrings) return results;
            }
            wideStart = i + 2;
          }
        } else {
          if (wideStart !== -1) {
            const charCount = (i - wideStart) / 2;
            if (charCount >= minLen) {
              const str = buf.subarray(wideStart, i).toString('utf16le');
              if (!results.includes(str)) {
                results.push(str);
                if (results.length >= maxStrings) return results;
              }
            }
            wideStart = -1;
          }
        }
      }
      if (wideStart !== -1 && results.length < maxStrings) {
        const charCount = Math.floor((buf.length - wideStart) / 2);
        if (charCount >= minLen) {
          const end = Math.min(buf.length, wideStart + MAX_STRING_LEN * 2);
          const alignedEnd = wideStart + Math.floor((end - wideStart) / 2) * 2;
          const str = buf.subarray(wideStart, alignedEnd).toString('utf16le');
          if (!results.includes(str)) {
            results.push(str);
            if (results.length >= maxStrings) return results;
          }
        }
      }
    }
  }

  return results;
}

/**
 * Detects Trojan Source Unicode directional overrides (U+202A..U+202E, U+2066..U+2069).
 */
export function detectTrojanSourceOverrides(buf: Buffer): {
  detected: boolean;
  count: number;
  codepoints: string[];
} {
  if (!buf || buf.length < 2) {
    return { detected: false, count: 0, codepoints: [] };
  }
  const foundCodepoints = new Set<string>();
  let count = 0;

  // UTF-8 sequences (3 bytes: 0xE2 0x80 [0xAA..0xAE] or 0xE2 0x81 [0xA6..0xA9])
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0xe2) {
      const b1 = buf[i + 1];
      const b2 = buf[i + 2];
      if (b1 === 0x80 && b2 >= 0xaa && b2 <= 0xae) {
        count++;
        foundCodepoints.add(`U+${(0x202a + (b2 - 0xaa)).toString(16).toUpperCase()}`);
      } else if (b1 === 0x81 && b2 >= 0xa6 && b2 <= 0xa9) {
        count++;
        foundCodepoints.add(`U+${(0x2066 + (b2 - 0xa6)).toString(16).toUpperCase()}`);
      }
    }
  }

  // UTF-16LE / UTF-16BE sequences (2 bytes)
  for (let i = 0; i + 1 < buf.length; i++) {
    const b0 = buf[i];
    const b1 = buf[i + 1];

    // UTF-16LE (byte 1 is 0x20)
    if (b1 === 0x20) {
      if (b0 >= 0x2a && b0 <= 0x2e) {
        count++;
        foundCodepoints.add(`U+${(0x2000 + b0).toString(16).toUpperCase()}`);
      } else if (b0 >= 0x66 && b0 <= 0x69) {
        count++;
        foundCodepoints.add(`U+${(0x2000 + b0).toString(16).toUpperCase()}`);
      }
    }
    // UTF-16BE (byte 0 is 0x20)
    else if (b0 === 0x20) {
      if (b1 >= 0x2a && b1 <= 0x2e) {
        count++;
        foundCodepoints.add(`U+${(0x2000 + b1).toString(16).toUpperCase()}`);
      } else if (b1 >= 0x66 && b1 <= 0x69) {
        count++;
        foundCodepoints.add(`U+${(0x2000 + b1).toString(16).toUpperCase()}`);
      }
    }
  }

  return {
    detected: count > 0,
    count,
    codepoints: Array.from(foundCodepoints),
  };
}

/**
 * Extracts unique URLs from string arrays, buffers, or raw text.
 */
export function extractUrls(input: string[] | Buffer | string, maxUrls = DEFAULT_MAX_URLS): string[] {
  let text = '';
  if (Array.isArray(input)) {
    text = input.join('\n');
  } else if (Buffer.isBuffer(input)) {
    const slice = input.length > MAX_URL_SCAN_LEN ? input.subarray(0, MAX_URL_SCAN_LEN) : input;
    text = slice.toString('latin1');
  } else {
    text = String(input);
  }

  if (text.length > MAX_URL_SCAN_LEN) {
    text = text.slice(0, MAX_URL_SCAN_LEN);
  }

  const urlRegex = /https?:\/\/[a-zA-Z0-9_\-./~%#?&=+:@!$,;]+/g;
  const matches = text.match(urlRegex) || [];
  const unique = new Set<string>();
  for (const m of matches) {
    const cleaned = m.replace(/[.,;:!?)]+$/, '');
    if (cleaned.length > 8) {
      unique.add(cleaned);
      if (unique.size >= maxUrls) {
        break;
      }
    }
  }
  return Array.from(unique);
}

/**
 * Analyzes binary artifacts, executables, firmware, and archive payloads.
 */
export async function analyzeArtifactFile(
  targetPath: string,
  options?: ArtifactAnalyzerOptions
): Promise<ReverseEvidence> {
  const safeResult: SafePathResult = validateSafePath(targetPath, {
    workspaceRoot: options?.workspaceRoot,
    allowedExtensions: options?.allowedExtensions,
    maxSizeBytes: options?.maxSizeBytes,
  });

  // Option A: REA proxy passthrough via defaultSessionManager
  const reaPath = options?.reaAgentsPath || process.env.REA_AGENTS_PATH;
  if (reaPath && !options?.skipProxy) {
    const sessionKey = `artifact-analyzer:${reaPath}`;
    try {
      const proxy = await defaultSessionManager.getOrCreateSession(sessionKey, {
        command: reaPath,
      });
      if (proxy.callable.includes('inspect_artifact')) {
        const resp = await proxy.call('inspect_artifact', { target: safeResult.canonicalPath });
        if (resp && resp.text) {
          try {
            const parsed = JSON.parse(resp.text);
            const normalized = normalizeEvidence(parsed, {
              tool: 'inspect_artifact',
              target: safeResult.canonicalPath,
            });
            if (!parsed?.coverage?.scope) {
              normalized.coverage.scope = 'binary';
            }
            return normalized;
          } catch {
            // Malformed JSON from proxy, close session before fallback to Option B
            await defaultSessionManager.closeSession(sessionKey).catch(() => {});
          }
        } else {
          // Missing or empty response, close session before fallback
          await defaultSessionManager.closeSession(sessionKey).catch(() => {});
        }
      } else {
        // Missing inspect_artifact capability, close session before fallback
        await defaultSessionManager.closeSession(sessionKey).catch(() => {});
      }
    } catch {
      // Degrade gracefully on error or when method not available
      await defaultSessionManager.closeSession(sessionKey).catch(() => {});
    }
  }

  // Option B: High-performance native binary analyzer
  const buf = await fs.promises.readFile(safeResult.canonicalPath);
  const header = buf.subarray(0, 32);
  const magic = detectMagicFormat(header);
  const entropy = calculateEntropy(buf);
  const isPackedOrEncrypted = entropy > 7.2;

  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  const strings = extractStrings(buf, options?.minStringLength ?? 4, options?.maxStrings ?? 50);
  const urls = extractUrls(strings);

  let detectedFormat = magic.format;
  let detectedMimeType = magic.mimeType;

  const normalizedResult: Record<string, unknown> = {
    format: detectedFormat,
    mimeType: detectedMimeType,
    sizeBytes: buf.length,
    entropy: Number(entropy.toFixed(4)),
    isPackedOrEncrypted,
    hashes: {
      md5,
      sha1,
      sha256,
    },
    stringsCount: strings.length,
    strings,
    urls,
  };

  const observations: Record<string, unknown>[] = [
    { format: detectedFormat, mimeType: detectedMimeType },
    { sizeBytes: buf.length },
    { entropy: Number(entropy.toFixed(4)), isPackedOrEncrypted },
    { hashes: { md5, sha1, sha256 } },
    { stringsCount: strings.length },
    { urlsCount: urls.length },
  ];

  const derivations: Record<string, unknown>[] = [
    { detectedFormat },
    { detectedUrls: urls },
    ...(isPackedOrEncrypted
      ? [{ packingAlert: 'High Shannon entropy (> 7.2) indicates packed or encrypted binary payload' }]
      : []),
  ];

  const trojanSource = detectTrojanSourceOverrides(buf);
  if (trojanSource.detected) {
    observations.push({
      trojanSourceAlert: true,
      description: 'Trojan Source Unicode directional override characters detected',
      count: trojanSource.count,
      codepoints: trojanSource.codepoints,
    });
    derivations.push({
      trojanSourceDetected: true,
      codepoints: trojanSource.codepoints,
    });
    normalizedResult.trojanSource = {
      detected: true,
      count: trojanSource.count,
      codepoints: trojanSource.codepoints,
    };
  }

  // Evaluate registered custom AST / firmware / artifact parsers
  for (const parser of customParsers) {
    try {
      if (typeof parser.canHandle === 'function' && parser.canHandle(header, safeResult)) {
        const customParsed = await withTimeout(
          parser.parse(buf, safeResult, options),
          CUSTOM_PARSER_TIMEOUT_MS,
          parser.name
        );
        if (customParsed && typeof customParsed === 'object') {
          observations.push({ customParser: parser.name });
          if (
            'normalized_result' in customParsed &&
            customParsed.normalized_result &&
            typeof customParsed.normalized_result === 'object'
          ) {
            sanitizeAndMergeCustomFields(
              normalizedResult,
              customParsed.normalized_result as Record<string, unknown>
            );
          } else {
            const {
              observations: customObs,
              derivations: customDerv,
              analysis_profile: _customProfile,
              ...rest
            } = customParsed as Record<string, unknown>;
            sanitizeAndMergeCustomFields(normalizedResult, rest);

            if (Array.isArray(customObs)) {
              for (let i = 0; i < Math.min(customObs.length, MAX_CUSTOM_ITEMS); i++) {
                const item = customObs[i];
                if (item && typeof item === 'object') {
                  observations.push(item as Record<string, unknown>);
                }
              }
            }
            if (Array.isArray(customDerv)) {
              for (let i = 0; i < Math.min(customDerv.length, MAX_CUSTOM_ITEMS); i++) {
                const item = customDerv[i];
                if (item && typeof item === 'object') {
                  derivations.push(item as Record<string, unknown>);
                }
              }
            }
          }

          // Allow custom parser to refine format/mimeType only if not already detected from magic bytes
          const customFormat = (customParsed as any).format ?? (customParsed as any).normalized_result?.format;
          if (
            detectedFormat === 'Binary/Data' &&
            typeof customFormat === 'string' &&
            customFormat.trim().length > 0
          ) {
            detectedFormat = customFormat.trim();
            normalizedResult.format = detectedFormat;
          }

          const customMime = (customParsed as any).mimeType ?? (customParsed as any).normalized_result?.mimeType;
          if (
            detectedMimeType === 'application/octet-stream' &&
            typeof customMime === 'string' &&
            customMime.trim().length > 0
          ) {
            detectedMimeType = customMime.trim();
            normalizedResult.mimeType = detectedMimeType;
          }
        }
      }
    } catch {
      // Continue if custom parser errors out or times out
    }
  }

  return createEvidenceBundle({
    tool: 'inspect_artifact',
    source: 'binary_static_analysis',
    target: safeResult.canonicalPath,
    normalizedResult,
    analysisProfile: {
      format: detectedFormat,
      mimeType: detectedMimeType,
      sizeBytes: buf.length,
      entropy: Number(entropy.toFixed(4)),
      isPackedOrEncrypted,
      target: safeResult.canonicalPath,
    },
    coverage: {
      scope: 'binary',
      status: 'complete',
    },
    observations,
    derivations,
  });
}

export const inspectArtifact = analyzeArtifactFile;
