/**
 * Runs `onShutdown` once when the process is asked to stop: SIGINT, SIGTERM, or its parent closing stdin
 * (the normal way an MCP host ends a stdio server). Without the stdin case, a host that just closes the pipe
 * left the Chrome children running. A failing handler never throws out of the event handler.
 */
export function installShutdownHooks(
    onShutdown: () => Promise<void> | void,
    proc: { on(ev: string, cb: () => void): unknown; stdin?: { on(ev: string, cb: () => void): unknown } } = process,
): void {
    let started = false;
    const run = () => {
        if (started) return;
        started = true;
        Promise.resolve()
            .then(onShutdown)
            .catch(err => console.error('Shutdown handler failed:', err));
    };
    proc.on('SIGINT', run);
    proc.on('SIGTERM', run);
    proc.stdin?.on('end', run);
    proc.stdin?.on('close', run);
}
