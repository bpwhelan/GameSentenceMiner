export interface PreReleaseMetadata {
    branch: string;
    repository?: string;
    commit?: string;
}

const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_COMMIT = /^[0-9a-f]{40}$/iu;
const SAFE_BRANCH_COMPONENT = /^[A-Za-z0-9._-]+$/u;

function isSafeRepository(value: string): boolean {
    if (!SAFE_REPOSITORY.test(value)) {
        return false;
    }
    return value.split('/').every((component) => component !== '.' && component !== '..');
}

function normalizeBranch(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const branch = value.trim();
    const components = branch.split('/');
    if (
        branch.length === 0 ||
        branch.length > 255 ||
        components.some(
            (component) =>
                component.length === 0 ||
                component === '.' ||
                component === '..' ||
                !SAFE_BRANCH_COMPONENT.test(component),
        )
    ) {
        return null;
    }
    return branch;
}

export function parsePreReleaseMetadata(value: unknown): PreReleaseMetadata | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const candidate = value as Record<string, unknown>;
    const branch = normalizeBranch(candidate.branch);
    if (!branch) {
        return null;
    }

    const repositoryValue =
        typeof candidate.repository === 'string' ? candidate.repository.trim() : '';
    const repository = isSafeRepository(repositoryValue) ? repositoryValue : null;
    const commit =
        typeof candidate.commit === 'string' && SAFE_COMMIT.test(candidate.commit.trim())
            ? candidate.commit.trim().toLowerCase()
            : null;

    const hasPinnedSource =
        Object.hasOwn(candidate, 'repository') || Object.hasOwn(candidate, 'commit');
    if (hasPinnedSource) {
        return repository && commit ? { branch, repository, commit } : null;
    }
    return { branch };
}

export function getPreReleaseArchiveUrl(
    metadata: PreReleaseMetadata | null,
    fallbackRepositoryUrl: string,
): string | null {
    if (!metadata) {
        return null;
    }
    if (metadata.repository && metadata.commit) {
        return `https://github.com/${metadata.repository}/archive/${metadata.commit}.zip`;
    }

    const branchPath = metadata.branch
        .split('/')
        .map((component) => encodeURIComponent(component))
        .join('/');
    return `${fallbackRepositoryUrl.replace(/\/+$/u, '')}/archive/refs/heads/${branchPath}.zip`;
}
