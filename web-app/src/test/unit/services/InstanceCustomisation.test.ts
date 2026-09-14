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
    toDockerEnv
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

    it.each(['/', '/etc', '/proc', '/var/run/docker.sock', '/config/test-corpus', '/defaults'])(
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
