import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JavaScript module used by scripts/utils/postbuild.js
import { torchInstallPlan } from '../scripts/utils/optional-deps.js';

// PyTorch lets the model inspector read .pt checkpoints. It is a large download, so it is optional: skipped in CI,
// when asked, and when it is already installed; a failed install only warns.

const base = { env: {}, platform: 'win32', torchPresent: false };

describe('torchInstallPlan', () => {
    it('installs the CPU build on Windows and Linux', () => {
        for (const platform of ['win32', 'linux']) {
            const p = torchInstallPlan({ ...base, platform });
            expect(p.install).toBe(true);
            expect(p.args).toEqual(['install', 'torch', '--index-url', 'https://download.pytorch.org/whl/cpu']);
        }
    });
    it('uses the default index on macOS, where the standard wheel is already CPU and Metal', () => {
        const p = torchInstallPlan({ ...base, platform: 'darwin' });
        expect(p.install).toBe(true);
        expect(p.args).toEqual(['install', 'torch']);
    });
    it('is skipped in CI, whatever the value', () => {
        for (const CI of ['true', '1', 'yes']) {
            const p = torchInstallPlan({ ...base, env: { CI } });
            expect(p.install).toBe(false);
            expect(p.reason).toMatch(/CI/);
        }
    });
    it('is skipped when SKIP_TORCH is set', () => {
        for (const SKIP_TORCH of ['1', 'true']) {
            const p = torchInstallPlan({ ...base, env: { SKIP_TORCH } });
            expect(p.install).toBe(false);
            expect(p.reason).toMatch(/SKIP_TORCH/);
        }
    });
    it('is skipped when it is already installed', () => {
        const p = torchInstallPlan({ ...base, torchPresent: true });
        expect(p.install).toBe(false);
        expect(p.reason).toMatch(/already/i);
    });
    it('treats an empty or false value as not set', () => {
        expect(torchInstallPlan({ ...base, env: { CI: '', SKIP_TORCH: '0' } }).install).toBe(true);
        expect(torchInstallPlan({ ...base, env: { CI: 'false' } }).install).toBe(true);
    });
    it('FORCE_TORCH installs even in CI', () => {
        const p = torchInstallPlan({ ...base, env: { CI: 'true', FORCE_TORCH: '1' } });
        expect(p.install).toBe(true);
    });
});
