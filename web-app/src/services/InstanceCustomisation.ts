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
    '/config/test-corpus',
    '/defaults'
];

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
