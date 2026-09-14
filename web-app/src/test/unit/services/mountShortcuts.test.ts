/**
 * Shared folders are only useful if somebody finds them. A mount lands in the
 * home directory, which nobody at a workshop thinks to open, so every mount an
 * image configures gets a desktop icon.
 *
 * These tests also hold the line that the instance service mounts what the
 * image says and nothing else: the hardcoded test corpus bind that preceded
 * this feature is gone, and its dead desktop icon with it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-shortcuts-'));
process.env.INSTANCE_VOLUME_ROOT = ROOT;

const CORPORA = path.join(ROOT, 'jhove-corpora');
const SAMPLES = path.join(ROOT, 'samples');

fs.mkdirSync(CORPORA, { recursive: true });
fs.mkdirSync(SAMPLES, { recursive: true });

jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

const mockContainerService = {
    createContainer: jest.fn(),
    execInContainer: jest.fn(),
    getContainer: jest.fn(),
    stopContainer: jest.fn(),
    removeContainer: jest.fn()
};

jest.mock('../../../services/ContainerService', () => ({
    __esModule: true,
    default: mockContainerService
}));

const mockResolveImageForUser = jest.fn();

jest.mock('../../../services/ContainerImageService', () => ({
    __esModule: true,
    default: { resolveImageForUser: mockResolveImageForUser }
}));

jest.mock('../../../utility/portManager', () => ({
    getAvailablePort: jest.fn(),
    getMultipleAvailablePorts: jest.fn().mockResolvedValue([3010, 3011])
}));

jest.mock('../../../utility/scriptManager', () => ({
    readAndProcessScript: jest.fn().mockReturnValue('#!/bin/bash\n'),
    validateRequiredScripts: jest.fn().mockReturnValue({ valid: true, missing: [] })
}));

jest.mock('../../../models', () => ({
    ViperInstance: { create: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), count: jest.fn() },
    ContainerImage: { findByPk: jest.fn(), findOne: jest.fn() },
    Team: { findByPk: jest.fn() },
    User: { findByPk: jest.fn() },
    Log: { create: jest.fn() },
    sequelize: { query: jest.fn() }
}));

import db from '../../../models';
import { UserRole } from '../../../types/UserRole';
import viperInstanceService from '../../../services/ViperInstanceService';

const mockDb = db as unknown as { ViperInstance: { create: jest.Mock } };

const ADMIN = { id: 1, username: 'admin', email: 'a@x.org', role: UserRole.ADMIN, teamId: null };

/**
 * The monitoring script is streamed in over an exec, not run as a command, so
 * a container mock without one fails the setup before it reaches the icons.
 */
function fakeContainer() {
    const stream = {
        write: jest.fn(),
        end: jest.fn(),
        on: (event: string, handler: () => void) => { if (event === 'end') handler(); }
    };

    return {
        id: 'container-abc',
        start: jest.fn().mockResolvedValue(undefined),
        exec: jest.fn().mockResolvedValue({ start: jest.fn().mockResolvedValue(stream) })
    };
}

function imageWith(overrides: Record<string, unknown> = {}) {
    return {
        reference: 'ghcr.io/x/viper:2.1',
        imageId: 11,
        origin: 'global',
        envVars: {},
        volumes: [],
        cpuLimit: null,
        memoryLimitMb: null,
        ...overrides
    };
}

/** Every symlink the setup made, as "target -> link". */
function symlinksCreated(): string[] {
    return mockContainerService.execInContainer.mock.calls
        .filter((call: any) => Array.isArray(call[1]) && call[1][0] === 'ln')
        .map((call: any) => `${call[1][2]} -> ${call[1][3]}`);
}

function bindsUsed(): string[] {
    return mockContainerService.createContainer.mock.calls[0]?.[0]?.HostConfig?.Binds || [];
}

function envUsed(): string[] {
    return mockContainerService.createContainer.mock.calls[0]?.[0]?.Env || [];
}

function hostConfigUsed(): Record<string, any> {
    return mockContainerService.createContainer.mock.calls[0]?.[0]?.HostConfig || {};
}

afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('desktop shortcuts for shared folders', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockResolveImageForUser.mockResolvedValue(imageWith());
        mockContainerService.createContainer.mockResolvedValue(fakeContainer());
        mockContainerService.execInContainer.mockResolvedValue({ output: '', exitCode: 0 });
        mockDb.ViperInstance.create.mockImplementation(async (values: any) => ({
            ...values,
            id: 1,
            update: jest.fn().mockResolvedValue(undefined)
        }));
    });

    it('should put an icon on each mount the image configures', async () => {
        mockResolveImageForUser.mockResolvedValue(imageWith({
            volumes: [
                { hostPath: CORPORA, containerPath: '/config/jhove-corpora', readOnly: true },
                { hostPath: SAMPLES, containerPath: '/config/samples', readOnly: true }
            ]
        }));

        await viperInstanceService.createInstance(ADMIN as any);

        expect(symlinksCreated()).toEqual([
            '/config/jhove-corpora -> /config/Desktop/jhove-corpora',
            '/config/samples -> /config/Desktop/samples'
        ]);
    });

    it('should name the icon after the destination the administrator chose', async () => {
        mockResolveImageForUser.mockResolvedValue(imageWith({
            volumes: [{ hostPath: CORPORA, containerPath: '/config/Reference Files', readOnly: true }]
        }));

        await viperInstanceService.createInstance(ADMIN as any);

        expect(symlinksCreated()).toEqual(['/config/Reference Files -> /config/Desktop/Reference Files']);
    });

    it('should create the desktop directory as abc, not as root', async () => {
        // Created as root it would be root owned, and the symlink step that
        // follows, which runs as abc, would fail on a fresh volume.
        mockResolveImageForUser.mockResolvedValue(imageWith({
            volumes: [{ hostPath: CORPORA, containerPath: '/config/jhove-corpora', readOnly: true }]
        }));

        await viperInstanceService.createInstance(ADMIN as any);

        const calls = mockContainerService.execInContainer.mock.calls
            .filter((call: any) => Array.isArray(call[1]) && call[1].join(' ').includes('/config/Desktop'));

        expect(calls.map((call: any) => call[1][0])).toEqual(['mkdir', 'ln']);
        calls.forEach((call: any) => expect(call[2]).toEqual(expect.objectContaining({ User: 'abc' })));
    });

    it('should leave the desktop alone when the image shares nothing', async () => {
        await viperInstanceService.createInstance(ADMIN as any);

        expect(symlinksCreated()).toEqual([]);
        expect(mockContainerService.execInContainer.mock.calls
            .some((call: any) => Array.isArray(call[1]) && call[1].join(' ').includes('/config/Desktop'))).toBe(false);
    });

    it('should still start the instance when the icons cannot be made', async () => {
        // The files are mounted and reachable either way; only the icon is
        // missing, so this is not worth failing a launch over.
        mockResolveImageForUser.mockResolvedValue(imageWith({
            volumes: [{ hostPath: CORPORA, containerPath: '/config/jhove-corpora', readOnly: true }]
        }));
        mockContainerService.execInContainer.mockImplementation(async (_id: string, command: string[]) =>
            command[0] === 'ln' ? { output: 'read-only file system', exitCode: 1 } : { output: '', exitCode: 0 });

        await expect(viperInstanceService.createInstance(ADMIN as any)).resolves.toBeDefined();
    });
});

describe('what an instance is given', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockResolveImageForUser.mockResolvedValue(imageWith());
        mockContainerService.createContainer.mockResolvedValue(fakeContainer());
        mockContainerService.execInContainer.mockResolvedValue({ output: '', exitCode: 0 });
        mockDb.ViperInstance.create.mockImplementation(async (values: any) => ({
            ...values,
            id: 1,
            update: jest.fn().mockResolvedValue(undefined)
        }));
    });

    it('should mount nothing when the image configures nothing', async () => {
        // The hardcoded test corpus bind this replaced mounted an empty
        // directory into every desktop and hung a dead icon off it.
        await viperInstanceService.createInstance(ADMIN as any);

        expect(bindsUsed()).toEqual([]);
    });

    it('should mount what the image configures, read-only', async () => {
        mockResolveImageForUser.mockResolvedValue(imageWith({
            volumes: [{ hostPath: CORPORA, containerPath: '/config/jhove-corpora', readOnly: true }]
        }));

        await viperInstanceService.createInstance(ADMIN as any);

        expect(bindsUsed()).toEqual([`${fs.realpathSync(CORPORA)}:/config/jhove-corpora:ro`]);
    });

    it('should pass the image environment variables through', async () => {
        mockResolveImageForUser.mockResolvedValue(imageWith({ envVars: { JHOVE_HOME: '/opt/jhove' } }));

        await viperInstanceService.createInstance(ADMIN as any);

        expect(envUsed()).toContain('JHOVE_HOME=/opt/jhove');
    });

    it('should refuse to launch when an image asks for a path outside the shared root', async () => {
        // Validation is at launch as well as at save, because a row could have
        // been written before the root moved, or edited around the interface.
        mockResolveImageForUser.mockResolvedValue(imageWith({
            volumes: [{ hostPath: '/etc', containerPath: '/config/etc', readOnly: true }]
        }));

        await expect(viperInstanceService.createInstance(ADMIN as any))
            .rejects.toThrow(/outside the shared content directory|does not exist/);

        expect(mockContainerService.createContainer).not.toHaveBeenCalled();
    });

    it('should refuse to launch when an image tries to set a platform variable', async () => {
        mockResolveImageForUser.mockResolvedValue(imageWith({ envVars: { SELKIES_MASTER_TOKEN: 'known' } }));

        await expect(viperInstanceService.createInstance(ADMIN as any))
            .rejects.toThrow(/cannot be overridden/);

        expect(mockContainerService.createContainer).not.toHaveBeenCalled();
    });

    it('should always give an instance a memory and CPU ceiling', async () => {
        // The state before this existed: an unlimited container, where one
        // runaway job exhausts the host and ends every other desktop on it.
        await viperInstanceService.createInstance(ADMIN as any);

        const hostConfig = hostConfigUsed();

        expect(hostConfig.Memory).toBeGreaterThan(0);
        expect(hostConfig.NanoCpus).toBeGreaterThan(0);
        expect(hostConfig.PidsLimit).toBeGreaterThan(0);
        expect(hostConfig.OomScoreAdj).toBeGreaterThan(0);
        expect(hostConfig.Ulimits.length).toBeGreaterThan(0);
    });

    it('should not let a resource limit overwrite the shared folders', async () => {
        // Both are spread into the same HostConfig object. Ordering them wrong
        // would silently drop every mount, which no test of either alone would
        // notice.
        mockResolveImageForUser.mockResolvedValue(imageWith({
            volumes: [{ hostPath: CORPORA, containerPath: '/config/jhove-corpora', readOnly: true }],
            cpuLimit: 4,
            memoryLimitMb: 4096
        }));

        await viperInstanceService.createInstance(ADMIN as any);

        expect(hostConfigUsed().Binds).toEqual([`${fs.realpathSync(CORPORA)}:/config/jhove-corpora:ro`]);
        expect(hostConfigUsed().Memory).toBe(4096 * 1024 * 1024);
    });

    it('should use the limits the image configures', async () => {
        mockResolveImageForUser.mockResolvedValue(imageWith({ cpuLimit: 4, memoryLimitMb: 8192 }));

        await viperInstanceService.createInstance(ADMIN as any);

        expect(hostConfigUsed().Memory).toBe(8192 * 1024 * 1024);
        expect(hostConfigUsed().NanoCpus).toBe(4e9);
    });

    it('should fall back to the appliance default when the image sets none', async () => {
        // Every image in the pool predates this feature, so the fallback is the
        // path that actually runs today.
        mockResolveImageForUser.mockResolvedValue(imageWith({ cpuLimit: null, memoryLimitMb: null }));

        await viperInstanceService.createInstance(ADMIN as any);

        const { cpuLimit, memoryLimitMb } = require('../../../services/InstanceCustomisation').DEFAULT_RESOURCE_LIMITS;

        expect(hostConfigUsed().Memory).toBe(memoryLimitMb * 1024 * 1024);
        expect(hostConfigUsed().NanoCpus).toBe(cpuLimit * 1e9);
    });

    it('should refuse to launch when an image asks for more than the appliance allows', async () => {
        mockResolveImageForUser.mockResolvedValue(imageWith({ memoryLimitMb: 999999 }));

        await expect(viperInstanceService.createInstance(ADMIN as any))
            .rejects.toThrow(/cannot be more than/);

        expect(mockContainerService.createContainer).not.toHaveBeenCalled();
    });
});
