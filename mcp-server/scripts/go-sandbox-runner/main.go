// Go Sandbox Runner — MCP code_mode utility
// ==========================================
//
// Executes user-provided JavaScript code in a sandboxed goja runtime.
// goja is a pure-Go ECMAScript 5.1+ interpreter — no external C dependencies.
//
// Sandbox guarantees:
//   - No filesystem access (no 'require', no native modules)
//   - No network access
//   - No process/OS access
//   - Execution timeout enforced via context deadline
//   - DATA global variable injected with input data
//   - print() and console.log() captured to stdout
//
// Contract:
//   Input:  JavaScript code is read from stdin
//           DATA is injected from $SANDBOX_DATA environment variable
//   Output: stdout from print() / console.log() calls
//   Exit:   0 = success, 1 = runtime/compilation error
//   Timeout: $SANDBOX_TIMEOUT_MS (default: 5000ms)
//
// Usage (called by the Node.js MCP executor):
//   echo "<user_js_code>" | SANDBOX_DATA="<data>" SANDBOX_TIMEOUT_MS=5000 ./go-sandbox-runner
//
// Build:
//   cd scripts/go-sandbox-runner && go build -o sandbox-runner .
//
// Requires: Go 1.21+, github.com/dop251/goja

package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/dop251/goja"
)

func main() {
	// Read JavaScript code from stdin
	codeBytes, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[go-sandbox] Failed to read code from stdin: %v\n", err)
		os.Exit(1)
	}
	code := strings.TrimSpace(string(codeBytes))
	if code == "" {
		fmt.Fprintln(os.Stderr, "[go-sandbox] No code provided via stdin.")
		os.Exit(1)
	}

	// Read DATA from environment
	data := os.Getenv("SANDBOX_DATA")

	// Read timeout from environment (default 5000ms)
	timeoutMs := 5000
	if t := os.Getenv("SANDBOX_TIMEOUT_MS"); t != "" {
		if v, err := strconv.Atoi(t); err == nil && v > 0 {
			timeoutMs = v
		}
	}

	stdout, stderr, success := runInGoja(code, data, time.Duration(timeoutMs)*time.Millisecond)

	if stdout != "" {
		fmt.Print(stdout)
	}
	if stderr != "" {
		fmt.Fprint(os.Stderr, stderr)
	}

	if !success {
		os.Exit(1)
	}
}

// runInGoja executes JavaScript `code` in a goja sandbox with `data` available
// as the DATA global variable. Returns (stdout, stderr, success).
func runInGoja(code, data string, timeout time.Duration) (stdout, stderr string, success bool) {
	vm := goja.New()

	var stdoutLines []string
	var stderrLines []string

	// Inject DATA global
	if err := vm.Set("DATA", data); err != nil {
		return "", fmt.Sprintf("[go-sandbox] Failed to set DATA: %v", err), false
	}

	// Implement print() → stdout
	printFn := func(call goja.FunctionCall) goja.Value {
		parts := make([]string, len(call.Arguments))
		for i, arg := range call.Arguments {
			parts[i] = arg.String()
		}
		stdoutLines = append(stdoutLines, strings.Join(parts, " "))
		return goja.Undefined()
	}
	if err := vm.Set("print", printFn); err != nil {
		return "", fmt.Sprintf("[go-sandbox] Failed to set print: %v", err), false
	}

	// Implement console.log() / console.error()
	consoleObj := vm.NewObject()
	_ = consoleObj.Set("log", func(call goja.FunctionCall) goja.Value {
		parts := make([]string, len(call.Arguments))
		for i, arg := range call.Arguments {
			parts[i] = arg.String()
		}
		stdoutLines = append(stdoutLines, strings.Join(parts, " "))
		return goja.Undefined()
	})
	_ = consoleObj.Set("error", func(call goja.FunctionCall) goja.Value {
		parts := make([]string, len(call.Arguments))
		for i, arg := range call.Arguments {
			parts[i] = arg.String()
		}
		stderrLines = append(stderrLines, strings.Join(parts, " "))
		return goja.Undefined()
	})
	_ = consoleObj.Set("warn", func(call goja.FunctionCall) goja.Value {
		parts := make([]string, len(call.Arguments))
		for i, arg := range call.Arguments {
			parts[i] = arg.String()
		}
		stderrLines = append(stderrLines, "[warn] "+strings.Join(parts, " "))
		return goja.Undefined()
	})
	if err := vm.Set("console", consoleObj); err != nil {
		return "", fmt.Sprintf("[go-sandbox] Failed to set console: %v", err), false
	}

	// Block dangerous globals that goja might expose
	for _, blocked := range []string{"require", "process", "__dirname", "__filename"} {
		_ = vm.Set(blocked, goja.Undefined())
	}

	// Enforce timeout via interrupt
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			vm.Interrupt("execution timed out")
		case <-done:
		}
	}()

	_, runErr := vm.RunString(code)
	close(done)

	stdout = strings.Join(stdoutLines, "\n")
	stderr = strings.Join(stderrLines, "\n")

	if runErr != nil {
		if ctx.Err() != nil {
			return stdout, stderr + "\n[go-sandbox] Execution timed out", false
		}
		return stdout, stderr + "\n" + runErr.Error(), false
	}

	return stdout, stderr, true
}
