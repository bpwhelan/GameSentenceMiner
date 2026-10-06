/** Windows argument quoting, without shell, environment, or regex expansion. */
export function splitWindowsCommandLine(command: string): string[] {
    const result: string[] = [];
    let index = 0;
    const isSpace = (value: string) => value === ' ' || value === '\t';

    while (index < command.length) {
        while (isSpace(command[index])) index += 1;
        if (index >= command.length) break;

        let argument = '';
        let quoted = false;
        while (index < command.length && (quoted || !isSpace(command[index]))) {
            let slashes = 0;
            while (command[index] === '\\') {
                slashes += 1;
                index += 1;
            }
            if (command[index] === '"') {
                argument += '\\'.repeat(Math.floor(slashes / 2));
                index += 1;
                if (slashes % 2) {
                    argument += '"';
                } else if (quoted && command[index] === '"') {
                    argument += '"';
                    index += 1;
                } else {
                    quoted = !quoted;
                }
            } else {
                argument += '\\'.repeat(slashes);
                if (index >= command.length || (!quoted && isSpace(command[index]))) break;
                argument += command[index];
                index += 1;
            }
        }
        result.push(argument);
    }
    return result;
}

export function quoteWindowsArgument(value: string): string {
    if (value && !/[\s"]/.test(value)) return value;
    const escaped = value
        .replace(/(\\*)"/g, (_match, slashes: string) => `${slashes.repeat(2)}\\"`)
        .replace(/\\+$/g, (slashes) => slashes.repeat(2));
    return `"${escaped}"`;
}

export function buildWindowsElevationCommand(executable: string, args: string[]): string {
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const argumentsOption = args.length
        ? ` -ArgumentList ${literal(args.map(quoteWindowsArgument).join(' '))}`
        : '';
    return `Start-Process -FilePath ${literal(executable)}${argumentsOption} -Verb RunAs`;
}
