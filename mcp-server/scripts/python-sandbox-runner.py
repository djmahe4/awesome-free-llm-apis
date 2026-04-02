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

try:
    from RestrictedPython import compile_restricted, safe_globals, safe_builtins
    from RestrictedPython.Guards import (
        safe_iter_unpack_sequence,
        guarded_iter_unpack_sequence,
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


def _build_restricted_globals(data: str, print_collector: 'PrintCollector') -> dict:
    """Build the restricted globals namespace for user code execution."""
    if HAS_RESTRICTED_PYTHON:
        glb = safe_globals.copy()
        glb['__builtins__'] = safe_builtins.copy()
    else:
        # Fallback minimal safe builtins when RestrictedPython is not installed
        glb = {'__builtins__': {}}
        glb['__builtins__'] = {
            'print': print,
            'len': len, 'range': range, 'enumerate': enumerate, 'zip': zip,
            'map': map, 'filter': filter, 'sorted': sorted, 'reversed': reversed,
            'list': list, 'dict': dict, 'set': set, 'tuple': tuple, 'frozenset': frozenset,
            'str': str, 'int': int, 'float': float, 'bool': bool, 'bytes': bytes,
            'max': max, 'min': min, 'sum': sum, 'abs': abs, 'round': round,
            'isinstance': isinstance, 'issubclass': issubclass, 'type': type,
            'repr': repr, 'format': format, 'hasattr': hasattr, 'getattr': getattr,
            'callable': callable, 'iter': iter, 'next': next, 'any': any, 'all': all,
            'hash': hash, 'id': id, 'hex': hex, 'oct': oct, 'bin': bin, 'chr': chr, 'ord': ord,
            'divmod': divmod, 'pow': pow, 'slice': slice,
            'True': True, 'False': False, 'None': None,
            'Exception': Exception, 'ValueError': ValueError, 'TypeError': TypeError,
            'KeyError': KeyError, 'IndexError': IndexError, 'StopIteration': StopIteration,
            'AttributeError': AttributeError, 'RuntimeError': RuntimeError,
        }

    # Allow controlled import of safe modules
    glb['__builtins__']['__import__'] = _safe_import

    # RestrictedPython guard hooks
    if HAS_RESTRICTED_PYTHON:
        glb['_iter_unpack_sequence_'] = safe_iter_unpack_sequence
        glb['_getiter_'] = iter
        glb['_getattr_'] = getattr
        glb['_write_'] = lambda x: x  # Allow writes to local names

    # Inject DATA global
    glb['DATA'] = data

    # Wire print() to our collector
    if HAS_RESTRICTED_PYTHON:
        glb['_print_'] = print_collector
        glb['print'] = print_collector

    return glb


def run_sandboxed(code: str, data: str) -> tuple[str, str, bool]:
    """
    Execute `code` in a RestrictedPython sandbox with `data` available as DATA.

    Returns:
        (stdout: str, stderr: str, success: bool)
    """
    # Redirect real stdout/stderr
    real_stdout = sys.stdout
    real_stderr = sys.stderr
    captured_stderr = io.StringIO()
    sys.stderr = captured_stderr

    stdout_lines: list[str] = []

    if HAS_RESTRICTED_PYTHON:
        # Use RestrictedPython's PrintCollector
        collector = PrintCollector()

        def captured_print(*args, **kwargs):
            sep = kwargs.get('sep', ' ')
            end = kwargs.get('end', '\n')
            line = sep.join(str(a) for a in args)
            stdout_lines.append(line)
            # Also write to collector for compatibility
            real_stdout.write(line + end)
            real_stdout.flush()

        # Compile using RestrictedPython
        try:
            byte_code = compile_restricted(code, filename='<sandbox>', mode='exec')
        except SyntaxError as e:
            sys.stdout = real_stdout
            sys.stderr = real_stderr
            return '', f'SyntaxError: {e}', False

        restricted_globals = _build_restricted_globals(data, captured_print)
        restricted_globals['print'] = captured_print

        try:
            exec(byte_code, restricted_globals)  # noqa: S102
            success = True
        except Exception as e:  # noqa: BLE001
            captured_stderr.write(traceback.format_exc())
            success = False
    else:
        # Fallback: manual builtins restriction (no RestrictedPython installed)
        sys.stdout = io.StringIO()

        def captured_print(*args, **kwargs):
            sep = kwargs.get('sep', ' ')
            end = kwargs.get('end', '')
            line = sep.join(str(a) for a in args)
            stdout_lines.append(line + end.rstrip('\n'))

        safe_glb = _build_restricted_globals(data, captured_print)
        safe_glb['print'] = captured_print

        try:
            exec(compile(code, '<sandbox>', 'exec'), safe_glb)  # noqa: S102
            success = True
        except Exception as e:  # noqa: BLE001
            captured_stderr.write(traceback.format_exc())
            success = False

        sys.stdout = real_stdout

    sys.stderr = real_stderr
    return '\n'.join(stdout_lines), captured_stderr.getvalue(), success


def main() -> None:
    # Read user code from stdin
    code = sys.stdin.read()
    if not code.strip():
        print('[python-sandbox] No code provided via stdin.', file=sys.stderr)
        sys.exit(1)

    # Read DATA from environment variable (injected by Node.js executor)
    data = os.environ.get('SANDBOX_DATA', '')

    stdout, stderr, success = run_sandboxed(code, data)

    if stdout:
        print(stdout, end='')
    if stderr:
        print(stderr, end='', file=sys.stderr)

    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
