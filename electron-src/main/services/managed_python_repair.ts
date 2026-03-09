function collectErrorText(error: unknown): string {
    if (error instanceof Error) {
        return `${error.message}\n${error.stack ?? ''}`;
    }
    return String(error ?? '');
}

const BROKEN_MANAGED_PYTHON_PATTERNS = [
    /python_venv/i,
    /virtual environment python/i,
    /\bvenv python\b/i,
    /managed environment/i,
    /ensurepip/i,
    /no module named pip/i,
    /scripts[\\/]+python\.exe/i,
    /bin[\\/]+python/i,
    /executable not found after setup/i,
];

export function shouldAutoRebuildManagedPythonEnv(error: unknown): boolean {
    const text = collectErrorText(error);
    return BROKEN_MANAGED_PYTHON_PATTERNS.some((pattern) => pattern.test(text));
}
