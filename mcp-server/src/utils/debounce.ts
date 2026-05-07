/**
 * Simple debounce function for TypeScript
 */
export function debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
): ((...args: Parameters<T>) => void) & { flush: () => void } {
    let timeout: NodeJS.Timeout | null = null;
    let lastArgs: Parameters<T> | null = null;

    const debounced = (...args: Parameters<T>): void => {
        lastArgs = args;
        if (timeout) {
            clearTimeout(timeout);
        }

        timeout = setTimeout(() => {
            timeout = null;
            if (lastArgs) func(...lastArgs);
        }, wait);
    };

    debounced.flush = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
            if (lastArgs) return func(...lastArgs);
        }
        return undefined;
    };

    return debounced;
}
