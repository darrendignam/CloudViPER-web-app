import fs from 'fs';
import path from 'path';

/**
 * Validation for the parts of an instance an administrator may configure.
 *
 * Both halves of this are host access wearing a friendly name. A bind mount
 * names a directory on the machine that runs every desktop, and an environment
 * variable can switch off the thing that keeps one desktop out of another. So
 * neither is taken at face value; both are checked here, in one place, with
 * tests, rather than at the point of use.
 */

/**
 * The only part of the filesystem instances may be given.
 *
 * A root rather than a denylist, because a denylist has to anticipate what
 * exists. The application's own directory tree holds the MySQL data directory
 * and the environment file with the database password, the cookie secret and
 * the OAuth secret, so the root deliberately sits nowhere near it: a root whose
 * entire purpose is "content meant to be shared" cannot grow a sibling that
 * should not have been.
 *
 * Under /mnt because that is where an administrator already mounts a network
 * share, which is the point of the feature: mount the SMB or NFS export on the
 * host here, and it becomes offerable to desktops without anything being copied
 * or baked into an image.
 *
 * Namespaced rather than /mnt itself, so CloudViPER does not silently claim
 * everything anyone ever mounts on the machine. Putting something here is then
 * a deliberate act rather than a side effect of mounting a disk.
 *
 * The path must be identical inside the application container and on the host,
 * because this process resolves and checks it while the Docker daemon acts on
 * it. docker-compose bind-mounts it read-only at the same path for exactly that
 * reason.
 */
export const INSTANCE_VOLUME_ROOT = process.env.INSTANCE_VOLUME_ROOT || '/mnt/cloudviper';

/**
 * Environment variables the platform owns. An instance that could set these
 * would not be an instance this system controls.
 *
 * SELKIES_MASTER_TOKEN is the sharp one: it is the credential that mints
 * desktop access, so an image configured with a known value would let anyone
 * holding that value drive every desktop launched from it. The sharing flags
 * are what keep one desktop from being handed to somebody else, and PUID/PGID
 * decide who the desktop runs as.
 */
const RESERVED_ENV_PREFIXES = ['SELKIES_', 'TRAEFIK_', 'ACME_'];
const RESERVED_ENV_NAMES = [
    'PUID', 'PGID',
    'VIRTUAL_HOST', 'VIRTUAL_PORT',
    'LETSENCRYPT_HOST', 'LETSENCRYPT_EMAIL',
    'PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH'
];

/**
 * Container paths the platform relies on. Mounting over these does not add
 * anything, it replaces something the instance needs.
 */
const RESERVED_CONTAINER_PATHS = [
    '/', '/proc', '/sys', '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib',
    '/var/run', '/var/run/docker.sock', '/run',
    '/defaults'
];

/**
 * What an instance may consume, and what it may not.
 *
 * An unlimited container is a shared appliance with one user able to end it for
 * everybody: a desktop that exhausts the host's memory does not fail alone, it
 * takes every other desktop with it. A ceiling turns that into one person's bad
 * afternoon.
 *
 * The defaults are sized from measurement rather than taste. An idle ViPER
 * desktop on this appliance holds about 1 GiB, so 2 GiB is roughly twice what
 * one needs while still capping a runaway. Two cores on a sixteen core host is
 * deliberate oversubscription, which is right for desktop work that is busy in
 * short bursts and idle the rest of the time.
 */
const DEFAULT_MEMORY_LIMIT_MB = readPositiveNumber(process.env.INSTANCE_DEFAULT_MEMORY_MB, 2048);
const DEFAULT_CPU_LIMIT = readPositiveNumber(process.env.INSTANCE_DEFAULT_CPUS, 2);

/**
 * Ceilings, so a typo cannot hand one desktop the whole machine, and floors,
 * because a desktop given 128 MB does not start. Refusing at the point of
 * configuration beats launching something that dies on boot and leaves somebody
 * guessing why.
 */
const MAX_MEMORY_LIMIT_MB = readPositiveNumber(process.env.INSTANCE_MAX_MEMORY_MB, 32768);
const MAX_CPU_LIMIT = readPositiveNumber(process.env.INSTANCE_MAX_CPUS, 16);
const MIN_MEMORY_LIMIT_MB = 512;
const MIN_CPU_LIMIT = 0.25;

/**
 * A fork bomb needs no memory to speak of, so a memory limit alone does not
 * stop one. This is not configurable per image because no legitimate desktop
 * comes near it.
 */
const INSTANCE_PIDS_LIMIT = 512;

/**
 * How far past its memory limit an instance may go into swap before the kernel
 * kills it.
 *
 * A desktop that is briefly slow is recoverable. A desktop that is killed loses
 * whatever the person was working on, so a grace zone is the kinder failure.
 * Set to 0 to make the memory limit hard, with no swap at all.
 *
 * This works whether or not the host has swap: with none, the allowance simply
 * never gets used.
 */
const INSTANCE_SWAP_GRACE_MB = readNonNegativeNumber(process.env.INSTANCE_SWAP_GRACE_MB, 1024);

/**
 * Relative weights, which only matter when the machine is contended.
 *
 * Both sit below the Docker default of 1024 for CPU and 500 for block I/O, so
 * when a room full of desktops is competing with the database and the proxy,
 * the platform wins. A slow desktop is a nuisance; a starved database is an
 * outage for everybody.
 */
const INSTANCE_CPU_SHARES = 512;
const INSTANCE_BLKIO_WEIGHT = 300;

/**
 * Tilt the kernel's out-of-memory killer towards desktops.
 *
 * If the host does run out despite every ceiling here, something is going to be
 * killed. This makes that something a ViPER instance rather than MySQL, the
 * proxy or the application, which would take every user down rather than one.
 */
const INSTANCE_OOM_SCORE_ADJ = 500;

/**
 * File handles and processes. A desktop opening a corpus needs a lot of the
 * former and few of the latter, and the host default is unbounded enough that
 * one runaway can exhaust the machine's global file table.
 */
const INSTANCE_ULIMITS = [
    { Name: 'nofile', Soft: 4096, Hard: 8192 },
    { Name: 'nproc', Soft: 2048, Hard: 4096 }
];

function readNonNegativeNumber(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readPositiveNumber(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface ResourceLimits {
    /** Cores, so 2.5 is two and a half. */
    cpuLimit: number;
    memoryLimitMb: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
    cpuLimit: DEFAULT_CPU_LIMIT,
    memoryLimitMb: DEFAULT_MEMORY_LIMIT_MB
};

export const RESOURCE_LIMIT_BOUNDS = {
    minCpuLimit: MIN_CPU_LIMIT,
    maxCpuLimit: MAX_CPU_LIMIT,
    minMemoryLimitMb: MIN_MEMORY_LIMIT_MB,
    maxMemoryLimitMb: MAX_MEMORY_LIMIT_MB
};

/**
 * Check a pair of limits, filling in the appliance default for either side left
 * unset. Null and undefined mean "whatever the appliance says", which is how an
 * image configured before this existed keeps working.
 */
export function validateResourceLimits(limits: Partial<Record<keyof ResourceLimits, unknown>> | null | undefined): ResourceLimits {
    const cpuLimit = resolveLimit(limits?.cpuLimit, DEFAULT_CPU_LIMIT, {
        label: 'CPU limit',
        unit: 'cores',
        minimum: MIN_CPU_LIMIT,
        maximum: MAX_CPU_LIMIT
    });

    const memoryLimitMb = resolveLimit(limits?.memoryLimitMb, DEFAULT_MEMORY_LIMIT_MB, {
        label: 'Memory limit',
        unit: 'MB',
        minimum: MIN_MEMORY_LIMIT_MB,
        maximum: MAX_MEMORY_LIMIT_MB,
        wholeNumber: true
    });

    return { cpuLimit, memoryLimitMb };
}

function resolveLimit(
    raw: unknown,
    fallback: number,
    rules: { label: string; unit: string; minimum: number; maximum: number; wholeNumber?: boolean }
): number {
    if (raw === null || raw === undefined || raw === '') {
        return fallback;
    }

    const value = Number(raw);

    if (!Number.isFinite(value)) {
        throw new Error(`${rules.label} must be a number`);
    }

    if (rules.wholeNumber && !Number.isInteger(value)) {
        throw new Error(`${rules.label} must be a whole number of ${rules.unit}`);
    }

    if (value < rules.minimum) {
        throw new Error(`${rules.label} must be at least ${rules.minimum} ${rules.unit}. A desktop below that does not start`);
    }

    if (value > rules.maximum) {
        throw new Error(`${rules.label} cannot be more than ${rules.maximum} ${rules.unit} on this appliance`);
    }

    return value;
}

/**
 * Render limits into the HostConfig fields Docker expects.
 *
 * Every value here was confirmed against the daemon on the appliance rather
 * than taken from documentation: Docker silently drops options the kernel will
 * not honour, reporting them in Warnings, and these came back clean and were
 * visible in the container's own cgroup files.
 *
 * MemorySwap is always set explicitly. Left unset Docker reads it as twice
 * Memory, which would silently double every ceiling here the moment the host
 * gained a swap file.
 */
export function toDockerResources(limits: ResourceLimits): Record<string, unknown> {
    const memoryBytes = limits.memoryLimitMb * 1024 * 1024;
    const swapGraceBytes = INSTANCE_SWAP_GRACE_MB * 1024 * 1024;

    return {
        Memory: memoryBytes,
        // Docker reads this as memory plus swap combined, so the allowance is
        // the difference. Equal to Memory means no swap at all.
        MemorySwap: memoryBytes + swapGraceBytes,
        // A soft limit the kernel reclaims against under pressure, so a desktop
        // drifting over its share is squeezed before it is killed outright.
        MemoryReservation: Math.floor(memoryBytes / 2),
        NanoCpus: Math.round(limits.cpuLimit * 1e9),
        CpuShares: INSTANCE_CPU_SHARES,
        BlkioWeight: INSTANCE_BLKIO_WEIGHT,
        PidsLimit: INSTANCE_PIDS_LIMIT,
        OomScoreAdj: INSTANCE_OOM_SCORE_ADJ,
        Ulimits: INSTANCE_ULIMITS.map((ulimit) => ({ ...ulimit }))
    };
}

export interface VolumeMount {
    hostPath: string;
    containerPath: string;
    readOnly: boolean;
}

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function isReservedEnvName(name: string): boolean {
    const upper = String(name || '').toUpperCase();
    return RESERVED_ENV_NAMES.includes(upper)
        || RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Check a set of environment variables, returning them normalised.
 * Throws on the first problem, because a half-applied set is worse than none.
 */
export function validateEnvVars(envVars: Record<string, unknown> | null | undefined): Record<string, string> {
    if (!envVars) return {};

    if (typeof envVars !== 'object' || Array.isArray(envVars)) {
        throw new Error('Environment variables must be a set of name and value pairs');
    }

    const validated: Record<string, string> = {};

    for (const [rawName, rawValue] of Object.entries(envVars)) {
        const name = String(rawName).trim();

        if (!ENV_NAME_PATTERN.test(name)) {
            throw new Error(`"${name}" is not a usable variable name. Use capitals, digits and underscores`);
        }

        if (isReservedEnvName(name)) {
            throw new Error(`${name} is set by CloudViPER and cannot be overridden here`);
        }

        const value = rawValue === null || rawValue === undefined ? '' : String(rawValue);

        // A newline would end the variable and start whatever came after it as
        // another one, which is a way to set a reserved name past this check.
        if (/[\n\r\0]/.test(value)) {
            throw new Error(`The value for ${name} cannot contain line breaks`);
        }

        validated[name] = value;
    }

    return validated;
}

/**
 * Check one mount, returning it normalised.
 *
 * The host path is resolved with realpath before it is judged, so a symlink
 * inside the shared root that points at the database directory is rejected on
 * where it actually leads rather than accepted on how it is spelled.
 */
export function validateVolume(mount: Partial<VolumeMount>, options: { mustExist?: boolean } = {}): VolumeMount {
    const hostPathInput = String(mount?.hostPath || '').trim();
    const containerPath = String(mount?.containerPath || '').trim();

    if (!hostPathInput || !containerPath) {
        throw new Error('A mount needs both a server path and a path inside the desktop');
    }

    if (!path.isAbsolute(hostPathInput) || !path.isAbsolute(containerPath)) {
        throw new Error('Both paths must be absolute');
    }

    const normalisedContainerPath = path.normalize(containerPath).replace(/\/+$/, '') || '/';

    if (RESERVED_CONTAINER_PATHS.includes(normalisedContainerPath)) {
        throw new Error(`${normalisedContainerPath} is used by the desktop itself and cannot be mounted over`);
    }

    const root = path.resolve(INSTANCE_VOLUME_ROOT);
    let resolvedHostPath = path.resolve(hostPathInput);

    if (options.mustExist !== false) {
        try {
            // realpath before anything is judged, so a symlink is assessed on
            // where it leads. Without this a link inside the shared root
            // pointing at the MySQL data directory would pass a prefix check
            // and mount the database into every desktop.
            resolvedHostPath = fs.realpathSync(resolvedHostPath);
        } catch {
            throw new Error(`${hostPathInput} does not exist on the server`);
        }
    }

    // Containment is decided before anything else about the path, so something
    // outside the root is refused for being outside it rather than for some
    // incidental property like not being a directory.
    //
    // Compared with a trailing separator so a sibling whose name merely starts
    // with the root, "/volumes/shared-secrets" against "/volumes/shared",
    // cannot pass as being inside it.
    if (resolvedHostPath !== root && !resolvedHostPath.startsWith(root + path.sep)) {
        throw new Error(
            `${hostPathInput} is outside the shared content directory (${root}). ` +
            'Move it there, or set INSTANCE_VOLUME_ROOT if the whole appliance should share a different one'
        );
    }

    if (options.mustExist !== false && !fs.statSync(resolvedHostPath).isDirectory()) {
        throw new Error(`${hostPathInput} is not a directory`);
    }

    return {
        hostPath: resolvedHostPath,
        containerPath: normalisedContainerPath,
        // Read-only unless someone deliberately says otherwise: these are shared
        // by every desktop, so a writable mount is one user editing what
        // everyone else sees.
        readOnly: mount.readOnly !== false
    };
}

export function validateVolumes(volumes: unknown, options: { mustExist?: boolean } = {}): VolumeMount[] {
    if (!volumes) return [];

    if (!Array.isArray(volumes)) {
        throw new Error('Volumes must be a list');
    }

    const validated = volumes.map((mount) => validateVolume(mount, options));
    const seen = new Set<string>();

    for (const mount of validated) {
        if (seen.has(mount.containerPath)) {
            throw new Error(`Two mounts both target ${mount.containerPath} inside the desktop`);
        }
        seen.add(mount.containerPath);
    }

    return validated;
}

/** Render mounts into the Bind strings Docker expects. */
export function toDockerBinds(volumes: VolumeMount[]): string[] {
    return volumes.map((mount) =>
        `${mount.hostPath}:${mount.containerPath}:${mount.readOnly ? 'ro' : 'rw'}`);
}

/** Render environment variables into the NAME=value strings Docker expects. */
export function toDockerEnv(envVars: Record<string, string>): string[] {
    return Object.entries(envVars).map(([name, value]) => `${name}=${value}`);
}

export interface ShareableDirectory {
    name: string;
    hostPath: string;
    /** A sensible destination, so the common case needs no typing. */
    suggestedContainerPath: string;
    entryCount: number | null;
}

/**
 * What an administrator may actually choose to mount.
 *
 * The interface offers this list rather than a free-text path box. Typing a
 * path is how somebody mounts the database directory by accident; picking from
 * what the appliance has been given cannot be. It also states the deployment
 * story plainly: whatever is meant to reach desktops, a network share included,
 * is mounted on the host under this one root, and appears here.
 *
 * One level deep on purpose. Nesting invites browsing the filesystem, which is
 * the thing being avoided.
 */
export function listShareableDirectories(): ShareableDirectory[] {
    const root = path.resolve(INSTANCE_VOLUME_ROOT);

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        // An appliance that has never been given anything to share is a normal
        // state, not a failure worth an error page.
        return [];
    }

    return entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => {
            const hostPath = path.join(root, entry.name);

            // Judged on where it leads, so a link out of the root is dropped
            // here rather than offered and refused later.
            let resolved: string;
            try {
                resolved = fs.realpathSync(hostPath);
                if (!fs.statSync(resolved).isDirectory()) return null;
            } catch {
                return null;
            }

            if (resolved !== root && !resolved.startsWith(root + path.sep)) {
                return null;
            }

            let entryCount: number | null = null;
            try {
                entryCount = fs.readdirSync(resolved).length;
            } catch {
                // Readable enough to mount but not to count is possible; the
                // count is a convenience, not a gate.
            }

            return {
                name: entry.name,
                hostPath: resolved,
                suggestedContainerPath: `/config/${entry.name}`,
                entryCount
            };
        })
        .filter((entry): entry is ShareableDirectory => entry !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
}
