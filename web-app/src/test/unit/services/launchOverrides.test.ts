/**
 * A system administrator may decide what one desktop is given. They may not
 * decide what a desktop can reach.
 *
 * That distinction is the whole of this file. Overrides exist so fifteen
 * desktops can be waiting, each with its own API key, before fifteen people
 * arrive. They are not a way around the containment rules, and an admin's
 * override is validated by exactly the same code a saved image is.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-overrides-'));
process.env.INSTANCE_VOLUME_ROOT = ROOT;

const SHARED = path.join(ROOT, 'jhove-corpora');
const OTHER = path.join(ROOT, 'samples');
fs.mkdirSync(SHARED, { recursive: true });
fs.mkdirSync(OTHER, { recursive: true });

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

jest.mock('../../../services/ContainerService', () => ({ __esModule: true, default: mockContainerService }));

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

const mockDb = db as unknown as {
    ViperInstance: { create: jest.Mock; count: jest.Mock };
    User: { findByPk: jest.Mock };
};

const ADMIN = { id: 1, username: 'admin', email: 'a@x.org', role: UserRole.ADMIN, teamId: null };
const MEMBER = { id: 2, username: 'mem', email: 'm@x.org', role: UserRole.MEMBER, teamId: 5 };

const PARTICIPANT = { id: 7, username: 'workshop7', email: 'w7@x.org', role: UserRole.MEMBER, teamId: 5 };

function fakeContainer() {
    const stream = { write: jest.fn(), end: jest.fn(), on: (e: string, h: () => void) => { if (e === 'end') h(); } };
    return {
        id: 'container-abc',
        start: jest.fn().mockResolvedValue(undefined),
        exec: jest.fn().mockResolvedValue({ start: jest.fn().mockResolvedValue(stream) })
    };
}

function imageWith(overrides: Record<string, unknown> = {}) {
    return {
        reference: 'opf-cloud-viper:ipres2026',
        imageId: 4,
        origin: 'team',
        envVars: { TITLE: 'Workshop' },
        volumes: [{ hostPath: SHARED, containerPath: '/config/test-corpus', readOnly: true }],
        cpuLimit: 2,
        memoryLimitMb: 4096,
        ...overrides
    };
}

function createdRow() {
    return mockDb.ViperInstance.create.mock.calls[0]?.[0] || {};
}

function envUsed(): string[] {
    return mockContainerService.createContainer.mock.calls[0]?.[0]?.Env || [];
}

function bindsUsed(): string[] {
    return mockContainerService.createContainer.mock.calls[0]?.[0]?.HostConfig?.Binds || [];
}

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

beforeEach(() => {
    jest.clearAllMocks();
    mockResolveImageForUser.mockResolvedValue(imageWith());
    mockContainerService.createContainer.mockResolvedValue(fakeContainer());
    mockContainerService.execInContainer.mockResolvedValue({ output: '', exitCode: 0 });
    mockDb.ViperInstance.count.mockResolvedValue(0);
    mockDb.User.findByPk.mockResolvedValue(PARTICIPANT);
    mockDb.ViperInstance.create.mockImplementation(async (values: any) => ({
        ...values, id: 1, update: jest.fn().mockResolvedValue(undefined)
    }));
});

describe('who may override a launch', () => {
    it.each([
        ['an owner', { ownerId: 7 }],
        ['environment', { envOverrides: { OPENROUTER_API_KEY: 'sk-or-v1-x' } }],
        ['volumes', { volumeOverrides: [{ hostPath: SHARED, containerPath: '/config/x' }] }]
    ])('should refuse a member naming %s', async (_label, options) => {
        await expect(viperInstanceService.createInstance(MEMBER as any, null, options as any))
            .rejects.toThrow('Only system administrators can override an instance at launch');

        expect(mockContainerService.createContainer).not.toHaveBeenCalled();
    });

    it('should let a member launch normally, with the team image deciding everything', async () => {
        // The point of the feature: a participant gets a working desktop without
        // being handed the means to reconfigure one.
        await viperInstanceService.createInstance(MEMBER as any);

        expect(envUsed()).toContain('TITLE=Workshop');
        expect(bindsUsed()).toEqual([`${fs.realpathSync(SHARED)}:/config/test-corpus:ro`]);
    });
});

describe('overrides an administrator may make', () => {
    it('should merge environment over the image, per name', async () => {
        await viperInstanceService.createInstance(ADMIN as any, null, {
            envOverrides: { OPENROUTER_API_KEY: 'sk-or-v1-seven' }
        });

        expect(envUsed()).toContain('TITLE=Workshop');
        expect(envUsed()).toContain('OPENROUTER_API_KEY=sk-or-v1-seven');
    });

    it('should let an override replace a value the image set', async () => {
        await viperInstanceService.createInstance(ADMIN as any, null, {
            envOverrides: { TITLE: 'Bench 7' }
        });

        expect(envUsed()).toContain('TITLE=Bench 7');
        expect(envUsed()).not.toContain('TITLE=Workshop');
    });

    it('should replace the mounts outright when given', async () => {
        await viperInstanceService.createInstance(ADMIN as any, null, {
            volumeOverrides: [{ hostPath: OTHER, containerPath: '/config/samples', readOnly: true }]
        });

        expect(bindsUsed()).toEqual([`${fs.realpathSync(OTHER)}:/config/samples:ro`]);
    });

    it('should keep the image mounts when volumes are not mentioned', async () => {
        await viperInstanceService.createInstance(ADMIN as any, null, { envOverrides: { X: '1' } });

        expect(bindsUsed()).toEqual([`${fs.realpathSync(SHARED)}:/config/test-corpus:ro`]);
    });

    it('should allow clearing the mounts with an empty list', async () => {
        await viperInstanceService.createInstance(ADMIN as any, null, { volumeOverrides: [] });

        expect(bindsUsed()).toEqual([]);
    });

    it('should allow a per-launch resource ceiling', async () => {
        await viperInstanceService.createInstance(ADMIN as any, null, { memoryLimitMb: 8192 });

        expect(mockContainerService.createContainer.mock.calls[0][0].HostConfig.Memory)
            .toBe(8192 * 1024 * 1024);
    });
});

describe('the boundary an administrator still cannot cross', () => {
    it('should refuse an override naming a variable the platform owns', async () => {
        // An admin may change what a desktop is given. Handing it a known master
        // token would let anyone holding that value drive every desktop.
        await expect(viperInstanceService.createInstance(ADMIN as any, null, {
            envOverrides: { SELKIES_MASTER_TOKEN: 'known' }
        })).rejects.toThrow(/cannot be overridden/);

        expect(mockContainerService.createContainer).not.toHaveBeenCalled();
    });

    it('should refuse an override mounting a path outside the shared root', async () => {
        await expect(viperInstanceService.createInstance(ADMIN as any, null, {
            volumeOverrides: [{ hostPath: '/etc', containerPath: '/config/etc' }]
        })).rejects.toThrow(/outside the shared content directory|does not exist/);

        expect(mockContainerService.createContainer).not.toHaveBeenCalled();
    });

    it('should refuse an override mounting over the desktop itself', async () => {
        await expect(viperInstanceService.createInstance(ADMIN as any, null, {
            volumeOverrides: [{ hostPath: SHARED, containerPath: '/etc' }]
        })).rejects.toThrow(/used by the desktop itself/);
    });

    it('should refuse a resource ceiling beyond the appliance', async () => {
        await expect(viperInstanceService.createInstance(ADMIN as any, null, { memoryLimitMb: 999999 }))
            .rejects.toThrow(/cannot be more than/);
    });
});

describe('launching on someone else\'s behalf', () => {
    it('should record the target as the owner', async () => {
        await viperInstanceService.createInstance(ADMIN as any, null, { ownerId: 7 });

        expect(createdRow().owner).toBe(7);
    });

    it('should record who actually pressed the button', async () => {
        // Owner and cause stop being the same question the moment this is
        // allowed, so the row has to answer both.
        await viperInstanceService.createInstance(ADMIN as any, null, { ownerId: 7 });

        expect(createdRow().createdById).toBe(1);
    });

    it('should leave createdById null for an ordinary self-service launch', async () => {
        await viperInstanceService.createInstance(MEMBER as any);

        expect(createdRow().createdById).toBeNull();
    });

    it('should resolve the image for the target, not the administrator', async () => {
        // A participant's team default is the whole point. Resolving as the
        // admin would hand them the admin's global default instead.
        await viperInstanceService.createInstance(ADMIN as any, null, { ownerId: 7 });

        expect(mockResolveImageForUser).toHaveBeenCalledWith(
            expect.objectContaining({ id: 7, role: UserRole.MEMBER, teamId: 5 }),
            null
        );
    });

    it('should refuse a user who does not exist', async () => {
        mockDb.User.findByPk.mockResolvedValue(null);

        await expect(viperInstanceService.createInstance(ADMIN as any, null, { ownerId: 999 }))
            .rejects.toThrow('There is no user with that id');
    });

    it('should apply the target limit, not the administrator\'s', async () => {
        // An admin is unlimited. Without this, a slip while pre-creating a room
        // gives one person three desktops and another none.
        mockDb.ViperInstance.count.mockResolvedValue(1);

        await expect(viperInstanceService.createInstance(ADMIN as any, null, { ownerId: 7 }))
            .rejects.toThrow(/already has 1 instance.*limit for a member/);

        expect(mockContainerService.createContainer).not.toHaveBeenCalled();
    });

    it('should not count the administrator\'s own instances against them', async () => {
        mockDb.ViperInstance.count.mockResolvedValue(99);

        await expect(viperInstanceService.createInstance(ADMIN as any)).resolves.toBeDefined();
    });
});
