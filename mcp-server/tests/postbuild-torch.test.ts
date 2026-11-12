import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JavaScript module used by scripts/utils/postbuild.js
import { torchInstallPlan, opencvInstallPlan } from '../scripts/utils/optional-deps.js';

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

describe('opencvInstallPlan', () => {
    const cvBase = { env: {}, opencvPresent: false };

    it('installs opencv-python-headless when absent and not skipped', () => {
        const p = opencvInstallPlan(cvBase);
        expect(p.install).toBe(true);
        expect(p.args).toEqual(['install', 'opencv-python-headless']);
    });
    it('is skipped in CI unless FORCE_OPENCV is set', () => {
        for (const CI of ['true', '1', 'yes']) {
            const p = opencvInstallPlan({ ...cvBase, env: { CI } });
            expect(p.install).toBe(false);
            expect(p.reason).toMatch(/CI/);
        }
        const forced = opencvInstallPlan({ ...cvBase, env: { CI: 'true', FORCE_OPENCV: '1' } });
        expect(forced.install).toBe(true);
    });
    it('is skipped when SKIP_OPENCV is set', () => {
        for (const SKIP_OPENCV of ['1', 'true']) {
            const p = opencvInstallPlan({ ...cvBase, env: { SKIP_OPENCV } });
            expect(p.install).toBe(false);
            expect(p.reason).toMatch(/SKIP_OPENCV/);
        }
    });
    it('is skipped when already installed', () => {
        const p = opencvInstallPlan({ ...cvBase, opencvPresent: true });
        expect(p.install).toBe(false);
        expect(p.reason).toMatch(/already/i);
    });
    it('treats empty or false env values as not set', () => {
        expect(opencvInstallPlan({ ...cvBase, env: { CI: '', SKIP_OPENCV: '0' } }).install).toBe(true);
        expect(opencvInstallPlan({ ...cvBase, env: { CI: 'false' } }).install).toBe(true);
    });
});
