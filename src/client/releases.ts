// The RayoMD release this package downloads when neither RAYOMD_PATH nor `rayomd` on PATH is set,
// and the SHA-256 of each release asset it accepts. Update with `npm run pin-release -- <version>`,
// which downloads the assets of that GitHub release, checks them against the digests GitHub
// reports and rewrites this file.

/** A platform with a release binary: Node's `${process.platform}-${process.arch}`. */
export type ReleasePlatform = 'linux-x64' | 'win32-x64';

/** One release asset: the archive, the binary's path inside it and the archive's SHA-256. */
export interface ReleaseAsset {
    archive: string;
    member: string;
    sha256: string;
}

export type ReleaseTable = Record<string, Partial<Record<ReleasePlatform, string>>>;

/** The release downloaded by default. */
export const RAYOMD_VERSION = '5.3.0';

/** SHA-256 of each release archive, by version and platform (lower-case hex). */
export const RELEASE_SHA256: ReleaseTable = {
    '5.3.0': {
        'linux-x64': '0a6145a30abcd64e2a0c54dd0650382566f1f07b4f9993b3123db22271e57bf0',
        'win32-x64': '68dd4e533a57696d1ca6b42f47b440b2412af0249d3b66c54d18931007b96d2f',
    },
    '5.2.5': {
        'linux-x64': '254ae746f656ee576ba85fc33a11643b61449d53d59ed85f20fc014418361d1d',
        'win32-x64': '1b9cef838787c5ac1cf4e8830e4d0de5d3248d14ff9972cad2058d0b3c96e4b8',
    },
};

export const RELEASE_BASE_URL = 'https://github.com/Butterski/rayomd/releases/download';

/**
 * The asset of `version` for `platform`: the static Linux tarball (it runs on glibc and musl
 * alike) or the Windows zip, as the RayoMD release workflow names them.
 */
export function releaseAsset(version: string, platform: ReleasePlatform, table: ReleaseTable = RELEASE_SHA256): ReleaseAsset {
    const sha256 = table[version]?.[platform];
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
        throw new Error(`No pinned SHA-256 for the RayoMD ${version} release asset of ${platform}; ` +
            'install rayomd on PATH or set RAYOMD_PATH.');
    }
    if (platform === 'linux-x64') {
        const folder = `rayomd-${version}-linux-x64-static`;
        return { archive: `${folder}.tar.gz`, member: `${folder}/rayomd`, sha256 };
    }
    const folder = `rayomd-${version}-windows-x64`;
    return { archive: `${folder}.zip`, member: `${folder}/rayomd.exe`, sha256 };
}

/** The current platform when RayoMD publishes a binary for it, else undefined. */
export function currentReleasePlatform(platform: string = process.platform, arch: string = process.arch): ReleasePlatform | undefined {
    const key = `${platform}-${arch}`;
    return key === 'linux-x64' || key === 'win32-x64' ? key : undefined;
}
