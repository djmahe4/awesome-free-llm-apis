// Decisions about optional Python packages the postbuild may install.

const on = (v) => !!v && !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());

/**
 * Whether the postbuild should pip install PyTorch, and with which arguments.
 * PyTorch is optional (it lets the model inspector read .pt checkpoints) and large, so it is skipped in CI, when
 * SKIP_TORCH is set, and when it is already installed. FORCE_TORCH overrides the CI skip.
 */
export function torchInstallPlan({ env = {}, platform = process.platform, torchPresent = false } = {}) {
  if (torchPresent) return { install: false, reason: 'PyTorch is already installed', args: [] };
  if (on(env.SKIP_TORCH)) return { install: false, reason: 'SKIP_TORCH is set', args: [] };
  if (on(env.CI) && !on(env.FORCE_TORCH)) return { install: false, reason: 'running in CI (set FORCE_TORCH=1 to install anyway)', args: [] };
  const args = ['install', 'torch'];
  // Windows and Linux default to the large CUDA build on PyPI; the CPU build is enough for the inspector.
  if (platform !== 'darwin') args.push('--index-url', 'https://download.pytorch.org/whl/cpu');
  return { install: true, reason: 'installing the CPU build', args };
}
