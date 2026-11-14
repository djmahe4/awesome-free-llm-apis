// Decisions about optional Python packages the postbuild may install.

const on = (v) => !!v && !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());

function buildInstallPlan({ label, present, skipVar, forceVar, env = {}, buildArgs, installReason }) {
  if (present) return { install: false, reason: `${label} is already installed`, args: [] };
  if (on(env[skipVar])) return { install: false, reason: `${skipVar} is set`, args: [] };
  if (on(env.CI) && !on(env[forceVar])) {
    return { install: false, reason: `running in CI (set ${forceVar}=1 to install anyway)`, args: [] };
  }
  return { install: true, reason: installReason, args: buildArgs() };
}

/**
 * Whether the postbuild should pip install PyTorch, and with which arguments.
 * PyTorch is optional (it lets the model inspector read .pt checkpoints) and large, so it is skipped in CI, when
 * SKIP_TORCH is set, and when it is already installed. FORCE_TORCH overrides the CI skip.
 */
export function torchInstallPlan({ env = {}, platform = process.platform, torchPresent = false } = {}) {
  return buildInstallPlan({
    label: 'PyTorch',
    present: torchPresent,
    skipVar: 'SKIP_TORCH',
    forceVar: 'FORCE_TORCH',
    env,
    installReason: 'installing the CPU build',
    buildArgs: () => {
      const args = ['install', 'torch'];
      // Windows and Linux default to the large CUDA build on PyPI; the CPU build is enough for the inspector.
      if (platform !== 'darwin') args.push('--index-url', 'https://download.pytorch.org/whl/cpu');
      return args;
    },
  });
}

/**
 * Whether the postbuild should pip install headless OpenCV (`cv2`) for depth parallax GrabCut/Telea and OCR helpers.
 * Skipped in CI, when SKIP_OPENCV is set, and when already installed. FORCE_OPENCV overrides the CI skip.
 */
export function opencvInstallPlan({ env = {}, opencvPresent = false } = {}) {
  return buildInstallPlan({
    label: 'OpenCV',
    present: opencvPresent,
    skipVar: 'SKIP_OPENCV',
    forceVar: 'FORCE_OPENCV',
    env,
    installReason: 'installing opencv-python-headless',
    buildArgs: () => ['install', 'opencv-python-headless'],
  });
}
