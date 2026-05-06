export function getGSMEndpoint(endpoint: string) {
    if (
        window.location.port === '4173' ||
        window.location.port === '5174'
    ) {
        return window.location.protocol + '//' + window.location.hostname + ':7275' + endpoint;
    }
    return endpoint;
}
