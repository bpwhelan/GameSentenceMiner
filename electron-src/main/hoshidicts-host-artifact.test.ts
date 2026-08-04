import { describe, expect, it } from 'vitest';

import {
    compareHoshiDictsHostManifest,
    executableContentSha256,
    hoshidictsHostArchiveName,
    hoshidictsHostExecutableName,
    inspectExecutableBuffer,
    linuxDependencyProblems,
    validatePlatformArchitecture,
} from '../../scripts/hoshidicts-host-artifact.mjs';

const SOURCE_COMMIT = '81e293cde156751e7f38cb040c86eb2c644ee4d2';
const REPOSITORY_COMMIT = '1'.repeat(40);
const HOST_TREE = '2'.repeat(40);

function peX64() {
    const buffer = Buffer.alloc(512);
    buffer.write('MZ', 0, 'ascii');
    buffer.writeUInt32LE(128, 0x3c);
    buffer.write('PE\0\0', 128, 'binary');
    buffer.writeUInt16LE(0x8664, 132);
    return buffer;
}

function elfX64() {
    const buffer = Buffer.alloc(64);
    buffer[0] = 0x7f;
    buffer.write('ELF', 1, 'ascii');
    buffer[4] = 2;
    buffer[5] = 1;
    buffer.writeUInt16LE(0x3e, 18);
    return buffer;
}

function machOArm64() {
    const buffer = Buffer.alloc(64);
    buffer.writeUInt32LE(0xfeedfacf, 0);
    buffer.writeUInt32LE(0x0100000c, 4);
    return buffer;
}

function payload() {
    return {
        'THIRD_PARTY_NOTICES.md': {
            source: 'THIRD_PARTY_NOTICES.md',
            sha256: 'notice-hash',
            size: 100,
        },
        'licenses/HoshiDicts-MIT.txt': {
            source: 'vendor/LICENSE',
            sha256: 'license-hash',
            size: 200,
        },
    };
}

function validManifest() {
    return {
        schemaVersion: 1,
        artifact: {
            platform: 'linux',
            arch: 'x64',
            format: 'elf',
            executable: 'gsm_hoshidicts_host',
            sha256: 'binary-hash',
            contentSha256: 'content-hash',
            size: 1234,
            unixMode: 0o755,
        },
        host: {
            version: '0.1.0',
            protocolVersion: '1.0',
            hoshidictsCommit: SOURCE_COMMIT,
        },
        source: {
            repositoryCommit: REPOSITORY_COMMIT,
            hostTree: HOST_TREE,
            hostPath: 'GSM_Overlay/hoshidicts_host',
        },
        trust: {
            status: 'not-applicable',
        },
        payload: payload(),
    };
}

function validObservation() {
    return {
        platform: 'linux',
        arch: 'x64',
        inspection: { format: 'elf', arch: 'x64' },
        executableSha256: 'binary-hash',
        executableContentSha256: 'content-hash',
        executableSize: 1234,
        executableMode: 0o100755,
        currentHoshidictsCommit: SOURCE_COMMIT,
        currentHostTree: HOST_TREE,
        payload: payload(),
    };
}

describe('HoshiDicts host artifact architecture inspection', () => {
    it('recognizes the supported PE, ELF, and Mach-O architectures', () => {
        expect(inspectExecutableBuffer(peX64())).toEqual({ format: 'pe', arch: 'x64' });
        expect(inspectExecutableBuffer(elfX64())).toEqual({ format: 'elf', arch: 'x64' });
        expect(inspectExecutableBuffer(machOArm64())).toEqual({
            format: 'mach-o',
            arch: 'arm64',
        });
    });

    it('rejects a binary for the wrong platform or architecture', () => {
        expect(() =>
            validatePlatformArchitecture('linux', 'arm64', {
                format: 'elf',
                arch: 'x64',
            }),
        ).toThrow(/architecture is x64; expected arm64/);
        expect(() =>
            validatePlatformArchitecture('darwin', 'arm64', {
                format: 'elf',
                arch: 'arm64',
            }),
        ).toThrow(/format is elf; expected mach-o/);
    });

    it('uses stable platform-specific executable and archive names', () => {
        expect(hoshidictsHostExecutableName('win32')).toBe('gsm_hoshidicts_host.exe');
        expect(hoshidictsHostExecutableName('linux')).toBe('gsm_hoshidicts_host');
        expect(hoshidictsHostArchiveName('darwin', 'arm64')).toBe(
            'gsm-hoshidicts-host-darwin-arm64.tar.gz',
        );
    });

    it('ignores Authenticode checksum, certificate directory, and overlay bytes', () => {
        const unsigned = peX64();
        unsigned.writeUInt16LE(0x20b, 152);
        unsigned.writeUInt16LE(0, 134);
        unsigned.writeUInt16LE(240, 148);
        unsigned.writeUInt32LE(512, 212);

        const signed = Buffer.concat([unsigned, Buffer.from('signature')]);
        signed.writeUInt32LE(1234, 216);
        signed.writeUInt32LE(512, 296);
        signed.writeUInt32LE(9, 300);

        expect(executableContentSha256(signed)).toBe(
            executableContentSha256(unsigned),
        );
    });
});

describe('HoshiDicts host artifact manifest verification', () => {
    it('accepts the exact binary, source tree, pin, payload, and mode', () => {
        expect(
            compareHoshiDictsHostManifest(validManifest(), validObservation()),
        ).toEqual([]);
    });

    it('rejects wrong architecture metadata, pin, source tree, and executable mode', () => {
        const manifest = validManifest();
        manifest.artifact.arch = 'arm64';
        manifest.host.hoshidictsCommit = '3'.repeat(40);
        manifest.source.hostTree = '4'.repeat(40);
        const observation = validObservation();
        observation.executableMode = 0o100644;

        expect(compareHoshiDictsHostManifest(manifest, observation)).toEqual(
            expect.arrayContaining([
                'artifact architecture is "arm64"; expected "x64"',
                `HoshiDicts source pin is "${'3'.repeat(40)}"; expected "${SOURCE_COMMIT}"`,
                `host source tree is "${'4'.repeat(40)}"; expected "${HOST_TREE}"`,
                'artifact executable mode has no execute bit',
            ]),
        );
    });

    it('rejects omitted notices, licenses, and unsigned stable metadata', () => {
        const manifest = validManifest();
        manifest.payload = {};
        manifest.trust.status = 'unsigned-development';

        const problems = compareHoshiDictsHostManifest(manifest, validObservation());
        expect(problems).toContain(
            'payload file set is []; expected ["THIRD_PARTY_NOTICES.md","licenses/HoshiDicts-MIT.txt"]',
        );
        expect(problems).toContain(
            'trust status is "unsigned-development"; expected one of ["not-applicable"]',
        );
    });

    it('rejects an incompatible host protocol', () => {
        const manifest = validManifest();
        manifest.host.protocolVersion = '2.0';

        expect(
            compareHoshiDictsHostManifest(manifest, validObservation()),
        ).toContain('protocol version is "2.0"; expected "1.0"');
    });

    it('accepts a re-signed PE with changed SHA and size but identical content', () => {
        const unsigned = peX64();
        unsigned.writeUInt16LE(0x20b, 152);
        unsigned.writeUInt16LE(0, 134);
        unsigned.writeUInt16LE(240, 148);
        unsigned.writeUInt32LE(512, 212);

        const signed = Buffer.concat([unsigned, Buffer.from('signature')]);
        signed.writeUInt32LE(1234, 216);
        signed.writeUInt32LE(512, 296);
        signed.writeUInt32LE(9, 300);

        const manifest = validManifest();
        manifest.artifact.platform = 'win32';
        manifest.artifact.format = 'pe';
        manifest.artifact.executable = 'gsm_hoshidicts_host.exe';
        manifest.artifact.contentSha256 = executableContentSha256(unsigned);
        manifest.artifact.size = unsigned.length;
        manifest.trust.status = 'signed';

        const observation = validObservation();
        observation.platform = 'win32';
        observation.inspection = { format: 'pe', arch: 'x64' };
        observation.executableSha256 = 'signed-binary-hash';
        observation.executableContentSha256 = executableContentSha256(signed);
        observation.executableSize = signed.length;
        observation.executableMode = null;
        observation.allowResigned = true;

        expect(observation.executableContentSha256).toBe(
            manifest.artifact.contentSha256,
        );
        expect(observation.executableSize).not.toBe(manifest.artifact.size);
        expect(
            compareHoshiDictsHostManifest(manifest, observation),
        ).toEqual([]);
    });
});

describe('HoshiDicts Linux support baseline', () => {
    it('accepts system libraries and GLIBC 2.35 or older', () => {
        expect(
            linuxDependencyProblems(
                `
                  Shared library: [ld-linux-x86-64.so.2]
                  Shared library: [libm.so.6]
                  Shared library: [libc.so.6]
                `,
                'Name: GLIBC_2.34 Name: GLIBC_2.35',
            ),
        ).toEqual([]);
    });

    it('rejects C++ runtime dependencies and newer GLIBC symbols', () => {
        expect(
            linuxDependencyProblems(
                `
                  Shared library: [libstdc++.so.6]
                  Shared library: [libgcc_s.so.1]
                  Shared library: [libc.so.6]
                `,
                'Name: GLIBC_2.36',
            ),
        ).toEqual([
            'libstdc++ must be linked into the release host',
            'libgcc must be linked into the release host',
            'host requires GLIBC_2.36; maximum supported is GLIBC_2.35',
        ]);
    });
});
