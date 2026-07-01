import { net, protocol } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHANGELOG_SCHEME = 'gsm-changelog';
const IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpg', '.jpeg', '.png', '.webp']);

export function registerChangelogProtocolScheme(): void {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: CHANGELOG_SCHEME,
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
            },
        },
    ]);
}

export function registerChangelogProtocolHandler(assetsDir: string): void {
    const changelogRoot = path.resolve(assetsDir, 'changelog');
    const imagesRoot = path.resolve(changelogRoot, 'images');

    protocol.handle(CHANGELOG_SCHEME, (request) => {
        const url = new URL(request.url);
        const relativePath = decodeURIComponent(
            `${url.hostname}${url.pathname}`.replace(/^\/+/, '')
        ).replaceAll('\\', '/');

        if (!relativePath.startsWith('images/')) {
            return new Response('Not found', { status: 404 });
        }

        const candidate = path.resolve(changelogRoot, relativePath);
        const imagesRootWithSeparator = `${imagesRoot}${path.sep}`;
        const extension = path.extname(candidate).toLowerCase();
        if (
            !candidate.startsWith(imagesRootWithSeparator) ||
            !IMAGE_EXTENSIONS.has(extension)
        ) {
            return new Response('Not found', { status: 404 });
        }

        return net.fetch(pathToFileURL(candidate).toString());
    });
}
