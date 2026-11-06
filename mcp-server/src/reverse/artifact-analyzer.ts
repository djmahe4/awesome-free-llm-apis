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

export function registerCustomArtifactParser(parser: CustomArtifactParser): void {
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
 */
export function extractStrings(buf: Buffer, minLen = 4, maxStrings = 50): string[] {
  if (!buf || buf.length === 0) {
    return [];
  }
  const results: string[] = [];
  let current: number[] = [];

  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte >= 0x20 && byte <= 0x7e) {
      current.push(byte);
    } else {
      if (current.length >= minLen) {
        results.push(Buffer.from(current).toString('ascii'));
        if (results.length >= maxStrings) {
          return results;
        }
      }
      current = [];
    }
  }

  if (current.length >= minLen && results.length < maxStrings) {
    results.push(Buffer.from(current).toString('ascii'));
  }

  return results;
}

/**
 * Extracts unique URLs from string arrays, buffers, or raw text.
 */
export function extractUrls(input: string[] | Buffer | string): string[] {
  let text = '';
  if (Array.isArray(input)) {
    text = input.join('\n');
  } else if (Buffer.isBuffer(input)) {
    text = input.toString('latin1');
  } else {
    text = String(input);
  }
  const urlRegex = /https?:\/\/[a-zA-Z0-9_\-./~%#?&=+:@!$,;]+/g;
  const matches = text.match(urlRegex) || [];
  const unique = new Set<string>();
  for (const m of matches) {
    const cleaned = m.replace(/[.,;:!?)]+$/, '');
    if (cleaned.length > 8) {
      unique.add(cleaned);
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
            // Malformed JSON from proxy, fallback to Option B
          }
        }
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
  const detectedMimeType = magic.mimeType;

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

  const observations: any[] = [
    { format: detectedFormat, mimeType: detectedMimeType },
    { sizeBytes: buf.length },
    { entropy: Number(entropy.toFixed(4)), isPackedOrEncrypted },
    { hashes: { md5, sha1, sha256 } },
    { stringsCount: strings.length },
    { urlsCount: urls.length },
  ];

  const derivations: any[] = [
    { detectedFormat },
    { detectedUrls: urls },
    ...(isPackedOrEncrypted
      ? [{ packingAlert: 'High Shannon entropy (> 7.2) indicates packed or encrypted binary payload' }]
      : []),
  ];

  // Evaluate registered custom AST / firmware / artifact parsers
  for (const parser of customParsers) {
    try {
      if (parser.canHandle(header, safeResult)) {
        const customParsed = await parser.parse(buf, safeResult, options);
        if (customParsed && typeof customParsed === 'object') {
          observations.push({ customParser: parser.name });
          if (
            'normalized_result' in customParsed &&
            customParsed.normalized_result &&
            typeof customParsed.normalized_result === 'object'
          ) {
            Object.assign(normalizedResult, customParsed.normalized_result);
          } else {
            const {
              observations: customObs,
              derivations: customDerv,
              analysis_profile: _customProfile,
              ...rest
            } = customParsed as any;
            Object.assign(normalizedResult, rest);
            if (Array.isArray(customObs)) observations.push(...customObs);
            if (Array.isArray(customDerv)) derivations.push(...customDerv);
          }
          if ((customParsed as any).format) {
            detectedFormat = (customParsed as any).format;
            normalizedResult.format = detectedFormat;
          }
        }
      }
    } catch {
      // Continue if custom parser errors out
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
