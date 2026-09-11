jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

jest.mock('../../../models', () => ({
    ContainerImage: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), update: jest.fn() },
    Team: { findByPk: jest.fn() },
    User: { findByPk: jest.fn() },
    ViperInstance: { findOne: jest.fn() },
    sequelize: { query: jest.fn() }
}));

import db from '../../../models';
import { UserRole } from '../../../types/UserRole';
import { ImageStatus } from '../../../models/containerimage';
import containerImageService, {
    isBlockedImage,
    mayChooseImage,
    FALLBACK_VIPER_IMAGE
} from '../../../services/ContainerImageService';

const mockDb = db as unknown as {
    ContainerImage: { findOne: jest.Mock; findByPk: jest.Mock; findAll: jest.Mock; update: jest.Mock };
    Team: { findByPk: jest.Mock };
};

const ADMIN = { id: 1, username: 'admin', email: 'a@x.org', role: UserRole.ADMIN, teamId: null };
const MEMBER = { id: 2, username: 'member', email: 'm@x.org', role: UserRole.MEMBER, teamId: 5 };
const LEADER = { id: 3, username: 'leader', email: 'l@x.org', role: UserRole.TEAM_LEADER, teamId: 5 };

function image(overrides: Record<string, any> = {}) {
    return {
        id: 10,
        reference: 'ghcr.io/example/viper:2.1',
        name: 'ViPER 2.1',
        status: ImageStatus.AVAILABLE,
        update: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

describe('isBlockedImage', () => {
    it.each([
        'ghcr.io/darrendignam/cloudviper-web-app:2.0.0-alpha.0',
        'mysql:8',
        'docker.io/library/mariadb:11',
        'nginxproxy/nginx-proxy:latest'
    ])('should block the platform image %s', (reference) => {
        expect(isBlockedImage(reference)).toBe(true);
    });

    it('should allow a genuine ViPER desktop image', () => {
        expect(isBlockedImage('ghcr.io/darrendignam/opf-cloud-viper:2.0.0-alpha')).toBe(false);
    });

    it('should match case insensitively', () => {
        expect(isBlockedImage('MySQL:8')).toBe(true);
    });

    it('should honour additions from IMAGE_BLOCKLIST', () => {
        const original = process.env.IMAGE_BLOCKLIST;
        process.env.IMAGE_BLOCKLIST = 'forbidden-thing, another-one';
        try {
            expect(isBlockedImage('registry.example.org/forbidden-thing:1')).toBe(true);
            expect(isBlockedImage('registry.example.org/another-one:1')).toBe(true);
            expect(isBlockedImage('registry.example.org/allowed:1')).toBe(false);
        } finally {
            if (original === undefined) delete process.env.IMAGE_BLOCKLIST;
            else process.env.IMAGE_BLOCKLIST = original;
        }
    });
});

describe('mayChooseImage', () => {
    it.each([UserRole.ADMIN, UserRole.TEAM_ADMIN, UserRole.TEAM_LEADER])('should let %s choose', (role) => {
        expect(mayChooseImage({ role })).toBe(true);
    });

    it.each([UserRole.MEMBER, UserRole.TESTING, UserRole.SUBSCRIBER, UserRole.USER])(
        'should not let %s choose', (role) => {
            expect(mayChooseImage({ role })).toBe(false);
        });
});

describe('resolveImageForUser', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.ContainerImage.findOne.mockResolvedValue(null);
        mockDb.ContainerImage.findByPk.mockResolvedValue(null);
        mockDb.Team.findByPk.mockResolvedValue(null);
    });

    it('should fall back to the environment when nothing is configured', async () => {
        const resolved = await containerImageService.resolveImageForUser(MEMBER as any);

        expect(resolved).toEqual({ reference: FALLBACK_VIPER_IMAGE, imageId: null, origin: 'environment' });
    });

    it('should prefer the global default over the environment', async () => {
        const globalImage = image({ id: 20, reference: 'ghcr.io/example/global:1' });
        mockDb.ContainerImage.findOne.mockResolvedValue(globalImage);
        mockDb.ContainerImage.findByPk.mockResolvedValue(globalImage);

        const resolved = await containerImageService.resolveImageForUser(MEMBER as any);

        expect(resolved).toEqual({ reference: 'ghcr.io/example/global:1', imageId: 20, origin: 'global' });
    });

    it('should prefer the team default over the global one', async () => {
        const teamImage = image({ id: 30, reference: 'ghcr.io/example/team:1' });
        mockDb.Team.findByPk.mockResolvedValue({ id: 5, defaultImageId: 30 });
        mockDb.ContainerImage.findByPk.mockResolvedValue(teamImage);
        mockDb.ContainerImage.findOne.mockResolvedValue(image({ id: 20 }));

        const resolved = await containerImageService.resolveImageForUser(MEMBER as any);

        expect(resolved).toEqual({ reference: 'ghcr.io/example/team:1', imageId: 30, origin: 'team' });
    });

    it('should ignore a team default that never finished pulling', async () => {
        // A half-pulled default must not stop anyone launching a desktop, so
        // the chain falls through rather than failing.
        mockDb.Team.findByPk.mockResolvedValue({ id: 5, defaultImageId: 30 });
        mockDb.ContainerImage.findByPk.mockResolvedValue(image({ id: 30, status: ImageStatus.PENDING }));

        const resolved = await containerImageService.resolveImageForUser(MEMBER as any);

        expect(resolved.origin).toBe('environment');
    });

    it('should ignore a default that has since been blocklisted', async () => {
        mockDb.ContainerImage.findOne.mockResolvedValue(image({ id: 20, reference: 'mysql:8' }));
        mockDb.ContainerImage.findByPk.mockResolvedValue(image({ id: 20, reference: 'mysql:8' }));

        const resolved = await containerImageService.resolveImageForUser(MEMBER as any);

        expect(resolved.origin).toBe('environment');
    });

    it('should not consult a team default for a user with no team', async () => {
        await containerImageService.resolveImageForUser(ADMIN as any);

        expect(mockDb.Team.findByPk).not.toHaveBeenCalled();
    });

    it('should honour an explicit choice by a leader', async () => {
        mockDb.ContainerImage.findByPk.mockResolvedValue(image({ id: 42, reference: 'ghcr.io/example/chosen:1' }));

        const resolved = await containerImageService.resolveImageForUser(LEADER as any, 42);

        expect(resolved).toEqual({ reference: 'ghcr.io/example/chosen:1', imageId: 42, origin: 'explicit' });
    });

    it('should refuse an explicit choice from a role that cannot choose', async () => {
        await expect(containerImageService.resolveImageForUser(MEMBER as any, 42))
            .rejects.toThrow('role cannot choose');
    });

    it('should refuse an explicit choice that does not exist', async () => {
        mockDb.ContainerImage.findByPk.mockResolvedValue(null);

        await expect(containerImageService.resolveImageForUser(ADMIN as any, 999))
            .rejects.toThrow('does not exist');
    });

    it('should refuse an explicit choice that is not ready', async () => {
        mockDb.ContainerImage.findByPk.mockResolvedValue(image({ status: ImageStatus.PENDING }));

        await expect(containerImageService.resolveImageForUser(ADMIN as any, 10))
            .rejects.toThrow('not ready to launch');
    });

    it('should refuse an explicit choice of a blocked image', async () => {
        // Unlike a default, an explicit choice fails loudly: quietly handing
        // someone a different image than the one they picked is worse.
        mockDb.ContainerImage.findByPk.mockResolvedValue(image({ reference: 'mysql:8' }));

        await expect(containerImageService.resolveImageForUser(ADMIN as any, 10))
            .rejects.toThrow('blocked');
    });
});

describe('setGlobalDefault', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.ContainerImage.update.mockResolvedValue([1]);
    });

    it('should demote the previous default before promoting the new one', async () => {
        const target = image({ id: 55 });
        mockDb.ContainerImage.findByPk.mockResolvedValue(target);

        await containerImageService.setGlobalDefault(55);

        expect(mockDb.ContainerImage.update).toHaveBeenCalledWith(
            { isGlobalDefault: false },
            { where: { isGlobalDefault: true } }
        );
        expect(target.update).toHaveBeenCalledWith({ isGlobalDefault: true });
    });

    it('should refuse an image that is not available', async () => {
        mockDb.ContainerImage.findByPk.mockResolvedValue(image({ status: ImageStatus.FAILED }));

        await expect(containerImageService.setGlobalDefault(55)).rejects.toThrow('before it is available');
        expect(mockDb.ContainerImage.update).not.toHaveBeenCalled();
    });

    it('should refuse a blocked image', async () => {
        mockDb.ContainerImage.findByPk.mockResolvedValue(image({ reference: 'mysql:8' }));

        await expect(containerImageService.setGlobalDefault(55)).rejects.toThrow('blocked');
    });
});

describe('setTeamDefault', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should set the team default to an available image', async () => {
        const team = { id: 5, update: jest.fn().mockResolvedValue(undefined) };
        mockDb.Team.findByPk.mockResolvedValue(team);
        mockDb.ContainerImage.findByPk.mockResolvedValue(image({ id: 60 }));

        await containerImageService.setTeamDefault(5, 60);

        expect(team.update).toHaveBeenCalledWith({ defaultImageId: 60 });
    });

    it('should allow clearing the team default', async () => {
        const team = { id: 5, update: jest.fn().mockResolvedValue(undefined) };
        mockDb.Team.findByPk.mockResolvedValue(team);

        await containerImageService.setTeamDefault(5, null);

        expect(team.update).toHaveBeenCalledWith({ defaultImageId: null });
        expect(mockDb.ContainerImage.findByPk).not.toHaveBeenCalled();
    });

    it('should refuse an unknown team', async () => {
        mockDb.Team.findByPk.mockResolvedValue(null);

        await expect(containerImageService.setTeamDefault(99, 60)).rejects.toThrow('team does not exist');
    });
});

describe('launchableImages', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should drop a blocked image even if it reached the pool', async () => {
        // Defence in depth: the pool is the allowlist, but an entry added
        // before a blocklist change must not keep appearing on launch screens.
        mockDb.ContainerImage.findAll.mockResolvedValue([
            image({ id: 1, reference: 'ghcr.io/example/viper:2.1' }),
            image({ id: 2, reference: 'mysql:8' })
        ]);

        const images = await containerImageService.launchableImages();

        expect(images.map((entry: any) => entry.id)).toEqual([1]);
    });

    it('should ask only for available images', async () => {
        mockDb.ContainerImage.findAll.mockResolvedValue([]);

        await containerImageService.launchableImages();

        expect(mockDb.ContainerImage.findAll).toHaveBeenCalledWith(
            expect.objectContaining({ where: { status: ImageStatus.AVAILABLE } })
        );
    });
});
