// rayomd-mcp/client: the rayomd binary (RAYOMD_PATH, PATH or a pinned, checked download) and a
// client of its `--serve --json` mode, for the MCP server and other tools (the VS Code extension).

export { extractMember, extractTarMember, extractZipMember } from './archive.js';
export {
    cachedBinaryPath,
    defaultCacheDir,
    downloadRelease,
    findOnPath,
    type RayomdBinary,
    resolveRayomd,
    type ResolveOptions,
} from './binary.js';
export { exportArgs, type ExportOptions, type HeadingLevel, type Style } from './options.js';
export {
    currentReleasePlatform,
    RAYOMD_VERSION,
    RELEASE_BASE_URL,
    RELEASE_SHA256,
    releaseAsset,
    type ReleaseAsset,
    type ReleasePlatform,
    type ReleaseTable,
} from './releases.js';
export { runRayomd, type RunResult } from './run.js';
export {
    isServeRecord,
    MAX_REQUEST_BYTES,
    type RayomdCommand,
    RayomdServe,
    type RayomdServeOptions,
    type ServeGreeting,
    type ServeRecord,
    type ServeRequest,
} from './serve.js';
