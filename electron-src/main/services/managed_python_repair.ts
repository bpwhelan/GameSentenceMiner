/** A failed backend lifetime, with its initialization state captured at exit. */
export class BackendProcessError extends Error {
    constructor(message: string, readonly beforeInitialization: boolean, options?: ErrorOptions) {
        super(message, options);
        this.name = 'BackendProcessError';
    }
}
