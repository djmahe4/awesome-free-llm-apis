import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  analyzeArtifactFile,
  calculateEntropy,
  detectMagicFormat,
  extractStrings,
  extractUrls,
  registerCustomArtifactParser,
  unregisterCustomArtifactParser,
  getCustomArtifactParsers,
  clearCustomArtifactParsers,
  type ArtifactAnalyzerOptions,
  type CustomArtifactParser,
} from '../src/reverse/artifact-analyzer.js';
import { PathSafetyError } from '../src/reverse/path-safety.js';

describe('Artifact Inspection, Magic-Bytes & Shannon Entropy Analyzer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-analyzer-test-'));
  });

  afterEach(() => {
    clearCustomArtifactParsers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('detectMagicFormat', () => {
    it('identifies ELF binary magic bytes', () => {
      const elfHeader = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
      const res = detectMagicFormat(elfHeader);
      expect(res.format).toBe('ELF');
      expect(res.mimeType).toBe('application/x-executable');
    });

    it('identifies WASM magic bytes', () => {
      const wasmHeader = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const res = detectMagicFormat(wasmHeader);
      expect(res.format).toBe('WASM');
      expect(res.mimeType).toBe('application/wasm');
    });

    it('identifies PE/Windows Executable (MZ) magic bytes', () => {
      const peHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
      const res = detectMagicFormat(peHeader);
      expect(res.format).toBe('PE/Windows Executable');
      expect(res.mimeType).toBe('application/vnd.microsoft.portable-executable');
    });

    it('identifies Mach-O binaries in 32-bit, 64-bit, and Fat/Universal endians', () => {
      const macho32BE = Buffer.from([0xfe, 0xed, 0xfa, 0xce]);
      const macho32LE = Buffer.from([0xce, 0xfa, 0xed, 0xfe]);
      const macho64BE = Buffer.from([0xfe, 0xed, 0xfa, 0xcf]);
      const macho64LE = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
      const machoFatBE = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
      const machoFatLE = Buffer.from([0xbe, 0xba, 0xfe, 0xca]);

      for (const h of [macho32BE, macho32LE, macho64BE, macho64LE, machoFatBE, machoFatLE]) {
        const res = detectMagicFormat(h);
        expect(res.format).toBe('Mach-O');
        expect(res.mimeType).toBe('application/x-mach-binary');
      }
    });

    it('identifies ZIP/Archive magic bytes', () => {
      const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      const res = detectMagicFormat(zipHeader);
      expect(res.format).toBe('ZIP/Archive');
      expect(res.mimeType).toBe('application/zip');
    });

    it('identifies GGUF model magic bytes', () => {
      const ggufHeader = Buffer.from([0x47, 0x47, 0x55, 0x46, 0x03, 0x00, 0x00, 0x00]);
      const res = detectMagicFormat(ggufHeader);
      expect(res.format).toBe('GGUF');
      expect(res.mimeType).toBe('application/x-gguf');
    });

    it('identifies PDF magic bytes', () => {
      const pdfHeader = Buffer.from('%PDF-1.7\n%some-content');
      const res = detectMagicFormat(pdfHeader);
      expect(res.format).toBe('PDF');
      expect(res.mimeType).toBe('application/pdf');
    });

    it('identifies ASAR archive magic bytes', () => {
      const asarHeader = Buffer.from([0x04, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00]);
      const res = detectMagicFormat(asarHeader);
      expect(res.format).toBe('ASAR');
      expect(res.mimeType).toBe('application/x-asar');
    });

    it('falls back to Binary/Data for unknown formats or empty buffers', () => {
      expect(detectMagicFormat(Buffer.alloc(0))).toEqual({
        format: 'Binary/Data',
        mimeType: 'application/octet-stream',
      });
      expect(detectMagicFormat(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toEqual({
        format: 'Binary/Data',
        mimeType: 'application/octet-stream',
      });
    });
  });

  describe('calculateEntropy', () => {
    it('returns 0 for empty or all-zero buffers', () => {
      expect(calculateEntropy(Buffer.alloc(0))).toBe(0);
      expect(calculateEntropy(Buffer.alloc(100, 0))).toBe(0);
    });

    it('calculates Shannon entropy > 7.0 for random binary buffers', () => {
      const randomBuf = crypto.randomBytes(4096);
      const entropy = calculateEntropy(randomBuf);
      expect(entropy).toBeGreaterThan(7.0);
      expect(entropy).toBeLessThanOrEqual(8.0);
    });

    it('calculates low entropy for repetitive text', () => {
      const textBuf = Buffer.from('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      const entropy = calculateEntropy(textBuf);
      expect(entropy).toBe(0);

      const repetitiveBuf = Buffer.from('hello world '.repeat(100));
      const textEntropy = calculateEntropy(repetitiveBuf);
      expect(textEntropy).toBeLessThan(4.0);
    });
  });

  describe('extractStrings & extractUrls', () => {
    it('extracts printable ASCII strings with minLen and maxStrings thresholds', () => {
      const binaryContent = Buffer.concat([
        Buffer.from([0x00, 0x01, 0x02]),
        Buffer.from('HelloBinaryWorld'),
        Buffer.from([0x00, 0xff]),
        Buffer.from('Short'),
        Buffer.from([0x00]),
        Buffer.from('ab'), // < minLen
        Buffer.from([0x00]),
        Buffer.from('AnotherExtractedString'),
      ]);

      const strings = extractStrings(binaryContent, 4, 10);
      expect(strings).toContain('HelloBinaryWorld');
      expect(strings).toContain('Short');
      expect(strings).toContain('AnotherExtractedString');
      expect(strings).not.toContain('ab');
    });

    it('extracts valid HTTP/HTTPS URLs from strings and buffers', () => {
      const testStrings = [
        'Connecting to https://api.example.com/v1/auth for tokens',
        'Fallback server http://localhost:8080/health',
        'Invalid string with no url',
        'Punctuation at end: https://example.org/path.',
      ];

      const urls = extractUrls(testStrings);
      expect(urls).toContain('https://api.example.com/v1/auth');
      expect(urls).toContain('http://localhost:8080/health');
      expect(urls).toContain('https://example.org/path');
    });
  });

  describe('analyzeArtifactFile', () => {
    it('analyzes an ELF binary file and verifies bundle contracts', async () => {
      const filePath = path.join(tmpDir, 'sample-elf.bin');
      const header = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
      const payload = Buffer.from('ELF test payload with https://internal.corp/c2 endpoint');
      fs.writeFileSync(filePath, Buffer.concat([header, payload]));

      const evidence = await analyzeArtifactFile(filePath, { workspaceRoot: tmpDir });

      expect(evidence.evidence_id).toMatch(/^ev-[a-f0-9]{16}$/);
      expect(evidence.coverage.status).toBe('complete');
      expect(evidence.coverage.scope).toBe('binary');
      expect(evidence.provenance.trusted).toBe(false);
      expect(evidence.provenance.tool).toBe('inspect_artifact');
      expect(evidence.provenance.source).toBe('binary_static_analysis');

      const norm = evidence.normalized_result;
      expect(norm.format).toBe('ELF');
      expect(norm.mimeType).toBe('application/x-executable');
      expect(norm.entropy).toBeDefined();
      expect(typeof norm.entropy).toBe('number');
      expect(norm.isPackedOrEncrypted).toBe(false);
      expect(norm.hashes).toBeDefined();
      expect((norm.hashes as any).md5).toHaveLength(32);
      expect((norm.hashes as any).sha1).toHaveLength(40);
      expect((norm.hashes as any).sha256).toHaveLength(64);
      expect((norm.urls as string[])).toContain('https://internal.corp/c2');
    });

    it('analyzes a WASM binary file', async () => {
      const filePath = path.join(tmpDir, 'module.wasm');
      const wasmBuf = Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        Buffer.from('exported_function_name'),
      ]);
      fs.writeFileSync(filePath, wasmBuf);

      const evidence = await analyzeArtifactFile(filePath, { workspaceRoot: tmpDir });
      expect(evidence.normalized_result.format).toBe('WASM');
      expect(evidence.normalized_result.mimeType).toBe('application/wasm');
      expect(evidence.coverage.scope).toBe('binary');
    });

    it('analyzes a PE executable and detects high-entropy packing', async () => {
      const filePath = path.join(tmpDir, 'malware.exe');
      const peHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
      const highEntropyPayload = crypto.randomBytes(8192);
      fs.writeFileSync(filePath, Buffer.concat([peHeader, highEntropyPayload]));

      const evidence = await analyzeArtifactFile(filePath, { workspaceRoot: tmpDir });

      expect(evidence.normalized_result.format).toBe('PE/Windows Executable');
      expect(evidence.normalized_result.isPackedOrEncrypted).toBe(true);
      expect((evidence.normalized_result.entropy as number)).toBeGreaterThan(7.2);

      const derivations = evidence.derivations as Array<Record<string, unknown>>;
      const packingDerivation = derivations.find((d) => d.packingAlert !== undefined);
      expect(packingDerivation).toBeDefined();
    });

    it('handles an empty artifact file gracefully (0 bytes)', async () => {
      const filePath = path.join(tmpDir, 'empty.bin');
      fs.writeFileSync(filePath, Buffer.alloc(0));

      const evidence = await analyzeArtifactFile(filePath, { workspaceRoot: tmpDir });

      expect(evidence.evidence_id).toMatch(/^ev-[a-f0-9]{16}$/);
      expect(evidence.coverage.status).toBe('complete');
      expect(evidence.coverage.scope).toBe('binary');
      expect(evidence.provenance.trusted).toBe(false);

      const norm = evidence.normalized_result;
      expect(norm.format).toBe('Binary/Data');
      expect(norm.mimeType).toBe('application/octet-stream');
      expect(norm.sizeBytes).toBe(0);
      expect(norm.entropy).toBe(0);
      expect(norm.isPackedOrEncrypted).toBe(false);
      expect(norm.strings).toEqual([]);
      expect(norm.urls).toEqual([]);
    });

    it('rejects path traversal attempts outside workspaceRoot', async () => {
      await expect(
        analyzeArtifactFile('../secret.bin', { workspaceRoot: tmpDir })
      ).rejects.toThrow(PathSafetyError);
    });

    it('degrades gracefully to native analysis when REA proxy fails or is unavailable', async () => {
      const filePath = path.join(tmpDir, 'proxy-fail.bin');
      const content = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]);
      fs.writeFileSync(filePath, content);

      const evidence = await analyzeArtifactFile(filePath, {
        workspaceRoot: tmpDir,
        reaAgentsPath: 'non-existent-binary-cmd-xyz123',
      });

      expect(evidence.evidence_id).toMatch(/^ev-[a-f0-9]{16}$/);
      expect(evidence.coverage.scope).toBe('binary');
      expect(evidence.normalized_result.format).toBe('ELF');
    });

    it('invokes registered custom artifact parsers and enriches the evidence bundle', async () => {
      const filePath = path.join(tmpDir, 'firmware.img');
      const firmwareMagic = Buffer.from([0xAA, 0x55, 0xDE, 0xAD]);
      const firmwareData = Buffer.from('ARM Cortex-M4 firmware blob');
      fs.writeFileSync(filePath, Buffer.concat([firmwareMagic, firmwareData]));

      const mockParser: CustomArtifactParser = {
        name: 'iot-firmware-parser',
        priority: 10,
        canHandle: (header) =>
          header.length >= 4 &&
          header[0] === 0xaa &&
          header[1] === 0x55 &&
          header[2] === 0xde &&
          header[3] === 0xad,
        parse: (_buf, safe) => {
          return {
            format: 'IoT/Firmware',
            firmwareMeta: {
              targetArch: 'ARM Cortex-M4',
              file: safe.relativePath,
            },
            observations: [{ firmwareDetected: true }],
            derivations: [{ firmwareArchitecture: 'cortex-m4' }],
          };
        },
      };

      registerCustomArtifactParser(mockParser);
      expect(getCustomArtifactParsers().map((p) => p.name)).toContain('iot-firmware-parser');

      const evidence = await analyzeArtifactFile(filePath, { workspaceRoot: tmpDir });

      expect(evidence.normalized_result.format).toBe('IoT/Firmware');
      expect(evidence.normalized_result.firmwareMeta).toEqual({
        targetArch: 'ARM Cortex-M4',
        file: 'firmware.img',
      });

      const obs = evidence.observations as Array<Record<string, unknown>>;
      expect(obs.some((o) => o.customParser === 'iot-firmware-parser')).toBe(true);
      expect(obs.some((o) => o.firmwareDetected === true)).toBe(true);

      const derv = evidence.derivations as Array<Record<string, unknown>>;
      expect(derv.some((d) => d.firmwareArchitecture === 'cortex-m4')).toBe(true);

      // Verify unregistering
      unregisterCustomArtifactParser('iot-firmware-parser');
      expect(getCustomArtifactParsers().map((p) => p.name)).not.toContain('iot-firmware-parser');
    });
  });
});
