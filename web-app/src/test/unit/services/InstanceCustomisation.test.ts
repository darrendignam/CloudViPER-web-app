/**
 * Per-image environment variables and volume mounts are host access wearing a
 * friendly name, so these tests are mostly about what must be refused.
 *
 * The appliance this runs on keeps the MySQL data directory beside the shared
 * content, and the application's own environment file, holding the database
 * password, cookie secret and OAuth secret, one level above it. Every escape
 * below is a real path on a real server.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-volumes-'));
process.env.INSTANCE_VOLUME_ROOT = ROOT;

import {
    listShareableDirectories,
    validateEnvVars,
    validateVolume,
    validateVolumes,
    isReservedEnvName,
    toDockerBinds,
    toDockerEnv,
    validateResourceLimits,
    toDockerResources,
    DEFAULT_RESOURCE_LIMITS,
    RESOURCE_LIMIT_BOUNDS
} from '../../../services/InstanceCustomisation';

// A shared corpus, a secret beside it, and a secret above it: the shape of the
// real appliance.
const SHARED = path.join(ROOT, 'jhove-corpora');
const SIBLING_SECRET = path.join(ROOT, 'mysql_8_data');
const OUTSIDE_SECRET = path.join(path.dirname(ROOT), 'cv-outside-secret');

beforeAll(() => {
    fs.mkdirSync(SHARED, { recursive: true });
    fs.mkdirSync(SIBLING_SECRET, { recursive: true });
    fs.mkdirSync(OUTSIDE_SECRET, { recursive: true });
});

afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.rmSync(OUTSIDE_SECRET, { recursive: true, force: true });
});

describe('volume containment', () => {
    it('should accept a directory inside the shared root', () => {
        const mount = validateVolume({ hostPath: SHARED, containerPath: '/config/corpora' });

        expect(mount.containerPath).toBe('/config/corpora');
        expect(mount.readOnly).toBe(true);
    });

    it('should default to read-only', () => {
        // These are shared by every desktop, so a writable mount is one user
        // editing what everyone else sees.
        expect(validateVolume({ hostPath: SHARED, containerPath: '/config/corpora' }).readOnly).toBe(true);
    });

    it('should allow read-write only when asked explicitly', () => {
        const mount = validateVolume({ hostPath: SHARED, containerPath: '/config/corpora', readOnly: false });

        expect(mount.readOnly).toBe(false);
    });

    it.each([
        ['the docker socket', '/var/run/docker.sock'],
        ['the host root', '/'],
        ['etc', '/etc'],
        ['a home directory', '/home/darrend']
    ])('should refuse %s as a source', (_label, hostPath) => {
        expect(() => validateVolume({ hostPath, containerPath: '/config/x' }))
            .toThrow(/outside the shared content directory|does not exist/);
    });

    it('should refuse a path that climbs out with ..', () => {
        expect(() => validateVolume({ hostPath: path.join(SHARED, '..', '..'), containerPath: '/config/x' }))
            .toThrow(/outside the shared content directory/);
    });

    it('should refuse a sibling whose name merely starts with the root', () => {
        // "/volumes/shared-secrets" begins with "/volumes/shared", so a plain
        // prefix check would let it through.
        const lookalike = ROOT + '-secrets';
        fs.mkdirSync(lookalike, { recursive: true });

        try {
            expect(() => validateVolume({ hostPath: lookalike, containerPath: '/config/x' }))
                .toThrow(/outside the shared content directory/);
        } finally {
            fs.rmSync(lookalike, { recursive: true, force: true });
        }
    });

    it('should refuse a symlink inside the root that points outside it', () => {
        // The important one. A link is spelled like an allowed path and leads
        // somewhere else, so the check has to follow it before judging.
        const link = path.join(ROOT, 'looks-innocent');
        fs.symlinkSync(OUTSIDE_SECRET, link);

        try {
            expect(() => validateVolume({ hostPath: link, containerPath: '/config/x' }))
                .toThrow(/outside the shared content directory/);
        } finally {
            fs.rmSync(link, { force: true });
        }
    });

    it('should refuse a symlink pointing at a sibling inside the root', () => {
        // The database directory sits beside the shared content on the real
        // appliance, so this is not hypothetical.
        const link = path.join(SHARED, 'db-link');
        fs.symlinkSync(SIBLING_SECRET, link);

        try {
            // Resolves to the sibling, which is inside the root, so this one is
            // allowed by design: the root is the boundary, not each directory.
            const mount = validateVolume({ hostPath: link, containerPath: '/config/x' });
            expect(mount.hostPath).toBe(fs.realpathSync(SIBLING_SECRET));
        } finally {
            fs.rmSync(link, { force: true });
        }
    });

    it('should refuse a source that does not exist', () => {
        expect(() => validateVolume({ hostPath: path.join(ROOT, 'absent'), containerPath: '/config/x' }))
            .toThrow(/does not exist/);
    });

    it('should refuse a file rather than a directory', () => {
        const file = path.join(SHARED, 'a-file.txt');
        fs.writeFileSync(file, 'x');

        try {
            expect(() => validateVolume({ hostPath: file, containerPath: '/config/x' }))
                .toThrow(/not a directory/);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    it.each(['/', '/etc', '/proc', '/var/run/docker.sock', '/defaults'])(
        'should refuse %s as a destination inside the desktop', (containerPath) => {
            // Mounting over these replaces something the desktop needs rather
            // than adding anything.
            expect(() => validateVolume({ hostPath: SHARED, containerPath }))
                .toThrow(/used by the desktop itself/);
        });

    it('should refuse relative paths on either side', () => {
        expect(() => validateVolume({ hostPath: 'volumes/shared', containerPath: '/config/x' }))
            .toThrow(/must be absolute/);
        expect(() => validateVolume({ hostPath: SHARED, containerPath: 'config/x' }))
            .toThrow(/must be absolute/);
    });

    it('should refuse two mounts landing on the same place', () => {
        expect(() => validateVolumes([
            { hostPath: SHARED, containerPath: '/config/corpora' },
            { hostPath: SIBLING_SECRET, containerPath: '/config/corpora' }
        ])).toThrow(/both target/);
    });

    it('should render binds Docker understands', () => {
        const binds = toDockerBinds(validateVolumes([
            { hostPath: SHARED, containerPath: '/config/corpora' }
        ]));

        expect(binds[0]).toBe(`${fs.realpathSync(SHARED)}:/config/corpora:ro`);
    });
});

describe('environment variable containment', () => {
    it('should accept ordinary variables', () => {
        expect(validateEnvVars({ TITLE: 'ViPER for iPRES', JHOVE_HOME: '/opt/jhove' }))
            .toEqual({ TITLE: 'ViPER for iPRES', JHOVE_HOME: '/opt/jhove' });
    });

    it.each([
        'SELKIES_MASTER_TOKEN',
        'SELKIES_ENABLE_SHARING',
        'PUID',
        'PGID',
        'TRAEFIK_CERT_RESOLVER',
        'ACME_PRE_HOOK',
        'PATH',
        'LD_PRELOAD'
    ])('should refuse %s, which the platform owns', (name) => {
        expect(isReservedEnvName(name)).toBe(true);
        expect(() => validateEnvVars({ [name]: 'anything' })).toThrow(/cannot be overridden/);
    });

    it('should refuse a reserved name whatever its case', () => {
        expect(() => validateEnvVars({ selkies_master_token: 'x' })).toThrow();
    });

    it('should refuse a value containing a line break', () => {
        // A newline ends the variable and starts the next, which is a way to
        // set a reserved name past the check above.
        expect(() => validateEnvVars({ TITLE: 'ok\nSELKIES_MASTER_TOKEN=known' }))
            .toThrow(/line breaks/);
    });

    it('should refuse a name that is not a variable name', () => {
        expect(() => validateEnvVars({ 'not a name': 'x' })).toThrow(/not a usable variable name/);
        expect(() => validateEnvVars({ '9LIVES': 'x' })).toThrow(/not a usable variable name/);
    });

    it('should treat an absent set as empty rather than failing', () => {
        expect(validateEnvVars(null)).toEqual({});
        expect(validateEnvVars(undefined)).toEqual({});
    });

    it('should render env strings Docker understands', () => {
        expect(toDockerEnv({ TITLE: 'ViPER' })).toEqual(['TITLE=ViPER']);
    });
});

describe('listShareableDirectories', () => {
    it('should offer directories inside the root', () => {
        const offered = listShareableDirectories().map(entry => entry.name);

        expect(offered).toContain('jhove-corpora');
    });

    it('should suggest a destination so the common case needs no typing', () => {
        const corpora = listShareableDirectories().find(entry => entry.name === 'jhove-corpora');

        expect(corpora!.suggestedContainerPath).toBe('/config/jhove-corpora');
    });

    it('should not offer a symlink that leads out of the root', () => {
        // Offered and then refused at save time would be a confusing way to
        // learn this; it is dropped from the list instead.
        const link = path.join(ROOT, 'escape-hatch');
        fs.symlinkSync(OUTSIDE_SECRET, link);

        try {
            expect(listShareableDirectories().map(e => e.name)).not.toContain('escape-hatch');
        } finally {
            fs.rmSync(link, { force: true });
        }
    });

    it('should not offer files', () => {
        const file = path.join(ROOT, 'loose-file.txt');
        fs.writeFileSync(file, 'x');

        try {
            expect(listShareableDirectories().map(e => e.name)).not.toContain('loose-file.txt');
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    it('should answer empty when the appliance has been given nothing', () => {
        // A fresh appliance with no shares is a normal state, not an error.
        const original = process.env.INSTANCE_VOLUME_ROOT;
        jest.resetModules();
        process.env.INSTANCE_VOLUME_ROOT = '/nonexistent-share-root';
        try {
            const fresh = require('../../../services/InstanceCustomisation');
            expect(fresh.listShareableDirectories()).toEqual([]);
        } finally {
            process.env.INSTANCE_VOLUME_ROOT = original;
            jest.resetModules();
        }
    });
});

describe('resource limits', () => {
    it('should fall back to the appliance default when nothing is set', () => {
        // An image configured before limits existed has null on both, and must
        // still launch with a ceiling rather than with none.
        expect(validateResourceLimits(null)).toEqual(DEFAULT_RESOURCE_LIMITS);
        expect(validateResourceLimits({})).toEqual(DEFAULT_RESOURCE_LIMITS);
        expect(validateResourceLimits({ cpuLimit: null, memoryLimitMb: null })).toEqual(DEFAULT_RESOURCE_LIMITS);
    });

    it('should default each side independently', () => {
        const limits = validateResourceLimits({ memoryLimitMb: 4096 });

        expect(limits.memoryLimitMb).toBe(4096);
        expect(limits.cpuLimit).toBe(DEFAULT_RESOURCE_LIMITS.cpuLimit);
    });

    it('should treat an empty string as unset, which is what a blank form field sends', () => {
        expect(validateResourceLimits({ cpuLimit: '', memoryLimitMb: '' })).toEqual(DEFAULT_RESOURCE_LIMITS);
    });

    it('should accept numbers arriving as strings from the form', () => {
        expect(validateResourceLimits({ cpuLimit: '2.5', memoryLimitMb: '3072' }))
            .toEqual({ cpuLimit: 2.5, memoryLimitMb: 3072 });
    });

    it('should accept a fractional core', () => {
        expect(validateResourceLimits({ cpuLimit: 0.5 }).cpuLimit).toBe(0.5);
    });

    it('should refuse a memory limit too small to boot a desktop', () => {
        // Launching something that instantly OOMs is worse than refusing it
        // here, because the failure surfaces far from its cause.
        expect(() => validateResourceLimits({ memoryLimitMb: 128 }))
            .toThrow(/at least .* MB/);
    });

    it('should refuse limits beyond what the appliance has', () => {
        expect(() => validateResourceLimits({ memoryLimitMb: RESOURCE_LIMIT_BOUNDS.maxMemoryLimitMb + 1 }))
            .toThrow(/cannot be more than/);
        expect(() => validateResourceLimits({ cpuLimit: RESOURCE_LIMIT_BOUNDS.maxCpuLimit + 1 }))
            .toThrow(/cannot be more than/);
    });

    it.each([0, -1, -2048])('should refuse %s as a memory limit', (value) => {
        expect(() => validateResourceLimits({ memoryLimitMb: value })).toThrow(/at least/);
    });

    it('should refuse a fractional megabyte', () => {
        expect(() => validateResourceLimits({ memoryLimitMb: 1024.5 })).toThrow(/whole number/);
    });

    it.each(['lots', NaN, Infinity, {}])('should refuse %s, which is not a number', (value) => {
        expect(() => validateResourceLimits({ cpuLimit: value })).toThrow(/must be a number/);
    });

    function dockerResources(limits = { cpuLimit: 2, memoryLimitMb: 2048 }) {
        return toDockerResources(limits) as Record<string, any>;
    }

    it('should render the HostConfig fields Docker expects', () => {
        const docker = dockerResources();

        expect(docker.Memory).toBe(2048 * 1024 * 1024);
        expect(docker.NanoCpus).toBe(2e9);
    });

    it('should always set MemorySwap explicitly', () => {
        // Docker reads an unset MemorySwap as twice Memory, which would double
        // every ceiling here the moment the host gained a swap file.
        expect(dockerResources().MemorySwap).toBeDefined();
    });

    it('should allow a grace zone into swap above the memory limit', () => {
        // A desktop that is briefly slow is recoverable. One that is killed
        // loses whatever the person was working on.
        const docker = dockerResources();

        expect(docker.MemorySwap).toBeGreaterThan(docker.Memory);
    });

    it('should make the memory limit hard when the grace is switched off', () => {
        const original = process.env.INSTANCE_SWAP_GRACE_MB;
        jest.resetModules();
        process.env.INSTANCE_SWAP_GRACE_MB = '0';
        try {
            const fresh = require('../../../services/InstanceCustomisation');
            const docker = fresh.toDockerResources({ cpuLimit: 2, memoryLimitMb: 2048 });

            expect(docker.MemorySwap).toBe(docker.Memory);
        } finally {
            if (original === undefined) delete process.env.INSTANCE_SWAP_GRACE_MB;
            else process.env.INSTANCE_SWAP_GRACE_MB = original;
            jest.resetModules();
        }
    });

    it('should set a soft limit below the hard one', () => {
        const docker = dockerResources();

        expect(docker.MemoryReservation).toBeLessThan(docker.Memory);
        expect(docker.MemoryReservation).toBeGreaterThan(0);
    });

    it('should cap processes, because a fork bomb needs no memory', () => {
        expect(dockerResources().PidsLimit).toBeGreaterThan(0);
    });

    it('should tilt the out-of-memory killer towards desktops', () => {
        // If the host runs out anyway, something dies. This decides that it is
        // one desktop rather than the database every user depends on.
        expect(dockerResources().OomScoreAdj).toBeGreaterThan(0);
    });

    it('should weight desktops below the platform for CPU and disk', () => {
        // Docker's defaults are 1024 and 500. Under contention the database and
        // the proxy have to win, or a busy room becomes an outage.
        const docker = dockerResources();

        expect(docker.CpuShares).toBeLessThan(1024);
        expect(docker.BlkioWeight).toBeLessThan(500);
    });

    it('should cap file handles and processes', () => {
        const names = dockerResources().Ulimits.map((ulimit: any) => ulimit.Name);

        expect(names).toEqual(expect.arrayContaining(['nofile', 'nproc']));
    });

    it('should keep nproc above the pid ceiling, or the pid ceiling is not the ceiling', () => {
        // RLIMIT_NPROC counts threads per UID and the whole desktop runs as abc,
        // so an nproc below PidsLimit becomes the real wall, in the same place
        // but with a worse error. Raising one without the other fixes nothing,
        // which is exactly how the first attempt at this went.
        const docker = dockerResources();
        const nproc = docker.Ulimits.find((ulimit: any) => ulimit.Name === 'nproc');

        expect(nproc.Soft).toBeGreaterThanOrEqual(docker.PidsLimit);
        expect(nproc.Hard).toBeGreaterThanOrEqual(docker.PidsLimit);
    });

    it('should allow a desktop enough processes to actually run', () => {
        // A ViPER desktop idles near 500 threads before anyone opens anything:
        // Firefox holds 166 across its processes and each JVM tool adds about
        // 40. An earlier 512 refused DROID every single time.
        expect(dockerResources().PidsLimit).toBeGreaterThanOrEqual(2048);
    });

    it('should hand out a fresh ulimit array each time', () => {
        // Docker's client mutates what it is given. A shared array would leak
        // one instance's changes into every instance launched afterwards.
        const first = dockerResources().Ulimits;
        const second = dockerResources().Ulimits;

        expect(first).not.toBe(second);
        expect(first[0]).not.toBe(second[0]);
    });

    it('should render a whole number of nanocpus for a fractional core', () => {
        // Docker rejects a non-integer NanoCpus, and 0.7 cores is 7e8 exactly
        // only if the arithmetic is rounded.
        expect(Number.isInteger(dockerResources({ cpuLimit: 0.7, memoryLimitMb: 1024 }).NanoCpus)).toBe(true);
    });

    it('should keep the defaults inside their own bounds', () => {
        // A misconfigured appliance default would refuse every image that left
        // the field blank, which is most of them.
        expect(() => validateResourceLimits(DEFAULT_RESOURCE_LIMITS)).not.toThrow();
    });
});
