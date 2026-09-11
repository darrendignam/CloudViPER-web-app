/**
 * Build instances are the one kind that keeps sudo, so that an admin can
 * customise a desktop and commit it as an image. Every other instance stays
 * hardened, and these tests are what stops that hardening quietly regressing
 * into "sudo for everyone".
 */
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

jest.mock('../../../services/ContainerImageService', () => ({
    __esModule: true,
    default: {
        resolveImageForUser: jest.fn().mockResolvedValue({
            reference: 'ghcr.io/x/viper:2.1',
            imageId: 11,
            origin: 'global'
        })
    }
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
const MEMBER = { id: 2, username: 'mem', email: 'm@x.org', role: UserRole.MEMBER, teamId: 5 };

function sudoWasStripped(): boolean {
    return mockContainerService.execInContainer.mock.calls
        .some((call: any) => Array.isArray(call[1]) && call[1].join(' ').includes('gpasswd -d abc sudo'));
}

describe('build instances', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockContainerService.createContainer.mockResolvedValue({
            id: 'container-abc',
            start: jest.fn().mockResolvedValue(undefined)
        });
        mockContainerService.execInContainer.mockResolvedValue({ output: '', exitCode: 0 });
        mockDb.ViperInstance.create.mockImplementation(async (values: any) => ({
            ...values,
            id: 1,
            update: jest.fn().mockResolvedValue(undefined)
        }));
    });

    it('should refuse build mode for anyone but a system admin', async () => {
        await expect(viperInstanceService.createInstance(MEMBER as any, null, { buildMode: true }))
            .rejects.toThrow('Only system administrators can create build instances');

        expect(mockContainerService.createContainer).not.toHaveBeenCalled();
    });

    it('should mark a build instance on the row', async () => {
        await viperInstanceService.createInstance(ADMIN as any, null, { buildMode: true });

        expect(mockDb.ViperInstance.create).toHaveBeenCalledWith(
            expect.objectContaining({ isBuildInstance: true })
        );
    });

    it('should not mark an ordinary instance as a build one', async () => {
        await viperInstanceService.createInstance(ADMIN as any);

        expect(mockDb.ViperInstance.create).toHaveBeenCalledWith(
            expect.objectContaining({ isBuildInstance: false })
        );
    });

    it('should keep sudo in a build instance', async () => {
        // The point of build mode. Without sudo an admin cannot install
        // anything, and the commit flow has nothing to capture.
        await viperInstanceService.createInstance(ADMIN as any, null, { buildMode: true });

        expect(sudoWasStripped()).toBe(false);
    });

    it('should strip sudo from an ordinary instance', async () => {
        // The v2.0 hardening. If this ever passes for the wrong reason, every
        // user has root inside their own container.
        await viperInstanceService.createInstance(ADMIN as any);

        expect(sudoWasStripped()).toBe(true);
    });

    it('should record the resolved image on the row', async () => {
        await viperInstanceService.createInstance(ADMIN as any);

        expect(mockDb.ViperInstance.create).toHaveBeenCalledWith(
            expect.objectContaining({ imageId: 11, imageReference: 'ghcr.io/x/viper:2.1' })
        );
    });

    it('should build the container from the resolved image', async () => {
        await viperInstanceService.createInstance(ADMIN as any);

        expect(mockContainerService.createContainer).toHaveBeenCalledWith(
            expect.objectContaining({ Image: 'ghcr.io/x/viper:2.1' })
        );
    });
});
