#!/usr/bin/env python3
"""
Python Sandbox Runner — MCP code_mode utility
==============================================

Uses RestrictedPython to execute user-provided Python code in a sandboxed
environment where:
  - Filesystem access is blocked  (open, io, os, pathlib, etc. are not available)
  - Network access is blocked     (__import__ of socket, http, urllib is blocked)
  - Process spawning is blocked   (subprocess, os.system, etc. are not available)
  - Dangerous builtins are removed

Contract:
  Input:  code is read from stdin (entire stdin = user script)
          DATA is injected as a top-level variable (from $SANDBOX_DATA env var)
  Output: stdout is captured from print() calls
  Exit:   0 = success, 1 = compilation/runtime error

Usage (called by the Node.js MCP executor):
  echo "<user_code>" | SANDBOX_DATA="<data>" python3 python-sandbox-runner.py

Requires: RestrictedPython >= 6.0  (pip install RestrictedPython)
"""

import sys
import os
import io
import traceback
import warnings

# Suppress RestrictedPython warning about 'printed' variable not being read.
# We handle output collection manually via SharedCollector, making the variable redundant.
warnings.filterwarnings("ignore", category=SyntaxWarning, message=".*never reads 'printed' variable.*")

try:
    from RestrictedPython import compile_restricted, safe_globals, safe_builtins
    from RestrictedPython.Guards import (
        guarded_iter_unpack_sequence,
        guarded_unpack_sequence,
    )
    from RestrictedPython.PrintCollector import PrintCollector
    HAS_RESTRICTED_PYTHON = True
except ImportError:
    HAS_RESTRICTED_PYTHON = False


# ---------------------------------------------------------------------------
# Blocked import list — any module in this set raises ImportError
# ---------------------------------------------------------------------------
_BLOCKED_MODULES = frozenset({
    # Filesystem
    'os', 'os.path', 'pathlib', 'shutil', 'glob', 'tempfile', 'fnmatch',
    'fileinput', 'stat', 'filecmp', 'tarfile', 'zipfile', 'gzip', 'bz2',
    'lzma', 'io',
    # Network
    'socket', 'ssl', 'http', 'http.client', 'http.server', 'urllib',
    'urllib.request', 'urllib.parse', 'urllib.error', 'ftplib', 'imaplib',
    'smtplib', 'poplib', 'xmlrpc', 'asyncio',
    # Process / system
    'subprocess', 'multiprocessing', 'threading', 'concurrent',
    'ctypes', 'cffi', 'mmap',
    # Code execution
    'code', 'codeop', 'py_compile', 'compileall', 'dis', 'ast', 'symtable',
    'token', 'tokenize', 'pickle', 'shelve', 'marshal',
    # Dangerous stdlib
    'signal', 'gc', 'weakref', 'importlib', 'runpy', 'site',
    'sysconfig', 'platform', 'resource', 'pty', 'tty', 'termios',
})


def _safe_import(name, *args, **kwargs):
    """Replacement for __import__ that blocks dangerous modules."""
    base = name.split('.')[0]
    if base in _BLOCKED_MODULES or name in _BLOCKED_MODULES:
        raise ImportError(
            f"Import of '{name}' is not allowed in sandbox mode. "
            "Only safe stdlib modules (json, math, re, datetime, etc.) are permitted."
        )
    return __import__(name, *args, **kwargs)


def run_sandboxed(code: str, data: str) -> tuple[str, str, bool]:
    """
    Execute `code` in a RestrictedPython sandbox with `data` available as DATA.

    Returns:
        (stdout: str, stderr: str, success: bool)
    """
    if not HAS_RESTRICTED_PYTHON:
        return '', 'CRITICAL: RestrictedPython is not installed. Python sandboxing is disabled. Please install it with: pip install RestrictedPython', False

    # Redirect real stdout/stderr to prevent any unexpected leakage
    real_stdout = sys.stdout
    real_stderr = sys.stderr
    captured_stderr = io.StringIO()
    sys.stderr = captured_stderr
    sys.stdout = io.StringIO()  # Also redirect stdout just in case

    stdout_lines: list[str] = []

    class SharedCollector:
        """A collector that appends to the shared stdout_lines list."""
        def __init__(self, _get_write=None):
            pass
        def write(self, data):
            stdout_lines.append(data)
        def __call__(self):
            return ''.join(stdout_lines)
        def _call_print(self, *args, **kwargs):
            sep = kwargs.get('sep', ' ')
            end = kwargs.get('end', '\n')
            stdout_lines.append(sep.join(map(str, args)) + end)

    def builtin_print(*args, **kwargs):
        """Custom builtin print that appends to our list."""
        sep = kwargs.get('sep', ' ')
        end = kwargs.get('end', '\n')
        stdout_lines.append(sep.join(map(str, args)) + end)

    try:
        # Compile using RestrictedPython
        try:
            byte_code = compile_restricted(code, filename='<sandbox>', mode='exec')
        except SyntaxError as e:
            return '', f'SyntaxError: {e}', False

        glb = safe_globals.copy()
        glb['__builtins__'] = safe_builtins.copy()
        glb['__builtins__']['__import__'] = _safe_import
        glb['__builtins__']['print'] = builtin_print
        
        # In RestrictedPython, the 'print' statement is transformed to use _print_
        glb['_print_'] = SharedCollector
        glb['_iter_unpack_sequence_'] = guarded_iter_unpack_sequence
        glb['_getiter_'] = iter
        glb['_getattr_'] = getattr
        glb['_write_'] = lambda x: x
        glb['DATA'] = data

        try:
            exec(byte_code, glb)  # noqa: S102
            success = True
        except Exception:  # noqa: BLE001
            captured_stderr.write(traceback.format_exc())
            success = False

        # Return accumulated output
        stdout = ''.join(stdout_lines)
        return stdout, captured_stderr.getvalue(), success

    finally:
        sys.stdout = real_stdout
        sys.stderr = real_stderr


def main() -> None:
    if not HAS_RESTRICTED_PYTHON:
        print("[python-sandbox] CRITICAL: RestrictedPython is not installed. Python sandboxing is disabled.", file=sys.stderr)
        print("Please install it with: pip install RestrictedPython", file=sys.stderr)
        sys.exit(2)

    # Read user code from stdin
    try:
        code = sys.stdin.read()
    except EOFError:
        code = ''

    if not code.strip():
        print('[python-sandbox] No code provided via stdin.', file=sys.stderr)
        sys.exit(1)

    # Read DATA from environment variable (injected by Node.js executor)
    data = os.environ.get('SANDBOX_DATA', '')

    stdout, stderr, success = run_sandboxed(code, data)

    # Note: PrintCollector usually adds a trailing newline
    if stdout:
        print(stdout, end='')
    if stderr:
        print(stderr, end='', file=sys.stderr)

    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
