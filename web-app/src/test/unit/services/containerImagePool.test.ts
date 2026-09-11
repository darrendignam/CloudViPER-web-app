jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

const mockContainerService = {
    pullImage: jest.fn(),
    listImages: jest.fn(),
    listContainers: jest.fn(),
    inspectImage: jest.fn(),
    removeImage: jest.fn(),
    commitContainer: jest.fn(),
    execInContainer: jest.fn(),
    getContainer: jest.fn()
};

jest.mock('../../../services/ContainerService', () => ({
    __esModule: true,
    default: mockContainerService
}));

jest.mock('../../../models', () => ({
    ContainerImage: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() },
    Team: { findByPk: jest.fn(), count: jest.fn() },
    User: { findByPk: jest.fn() },
    ViperInstance: { findOne: jest.fn() },
    sequelize: { query: jest.fn() }
}));

import db from '../../../models';
import { ImageSource, ImageStatus } from '../../../models/containerimage';
import containerImageService, {
    isValidReference,
    toRepositoryName,
    NEUTRALISED_TOKEN_VALUE
} from '../../../services/ContainerImageService';

const mockDb = db as unknown as {
    ContainerImage: { findOne: jest.Mock; findByPk: jest.Mock; findAll: jest.Mock; create: jest.Mock };
    Team: { count: jest.Mock };
};

const MASTER_TOKEN_VAR = 'SELKIES_MASTER_TOKEN';

describe('isValidReference', () => {
    it.each([
        'ghcr.io/darrendignam/opf-cloud-viper:2.0.0-alpha',
        'ubuntu',
        'ubuntu:24.04',
        'registry.example.org:5000/team/image:tag',
        'alpine@sha256:' + 'a'.repeat(64)
    ])('should accept %s', (reference) => {
        expect(isValidReference(reference)).toBe(true);
    });

    it.each([
        '',
        'ubuntu; rm -rf /',
        'ubuntu && curl evil.example.org',
        'ubuntu$(whoami)',
        '../../etc/passwd',
        'image with spaces'
    ])('should reject %p', (reference) => {
        expect(isValidReference(reference)).toBe(false);
    });

    it('should reject something absurdly long', () => {
        expect(isValidReference('a'.repeat(300))).toBe(false);
    });
});

describe('toRepositoryName', () => {
    it('should lowercase and dash out anything Docker will not take', () => {
        expect(toRepositoryName('ViPER Forensics Build')).toBe('viper-forensics-build');
    });

    it('should trim leading and trailing separators', () => {
        expect(toRepositoryName('  --my image--  ')).toBe('my-image');
    });
});

describe('addImageFromRegistry', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.ContainerImage.findOne.mockResolvedValue(null);
        mockContainerService.pullImage.mockResolvedValue(undefined);
        mockContainerService.inspectImage.mockResolvedValue({ Id: 'sha256:abc', Size: 7_000_000_000 });
    });

    it('should create the row as pending and return before the pull finishes', async () => {
        const created = { id: 1, reference: 'ghcr.io/x/y:1', update: jest.fn().mockResolvedValue(undefined) };
        mockDb.ContainerImage.create.mockResolvedValue(created);

        const image = await containerImageService.addImageFromRegistry({
            reference: 'ghcr.io/x/y:1',
            name: 'Y'
        });

        expect(mockDb.ContainerImage.create).toHaveBeenCalledWith(
            expect.objectContaining({ status: ImageStatus.PENDING, source: ImageSource.REGISTRY })
        );
        expect(image).toBe(created);
    });

    it('should mark the row available once the pull lands', async () => {
        const created = { id: 1, reference: 'ghcr.io/x/y:1', update: jest.fn().mockResolvedValue(undefined) };

        await containerImageService.performPull(created);

        expect(created.update).toHaveBeenCalledWith(expect.objectContaining({
            status: ImageStatus.AVAILABLE,
            digest: 'sha256:abc',
            sizeBytes: 7_000_000_000
        }));
    });

    it('should record why a pull failed rather than throwing into nothing', async () => {
        // Nothing awaits performPull, so an escaping rejection would only
        // become an unhandled one. The row is the only place to report this.
        const created = { id: 1, reference: 'ghcr.io/x/missing:1', update: jest.fn().mockResolvedValue(undefined) };
        mockContainerService.pullImage.mockRejectedValue(new Error('manifest unknown'));

        await expect(containerImageService.performPull(created)).resolves.toBeUndefined();

        expect(created.update).toHaveBeenCalledWith({
            status: ImageStatus.FAILED,
            statusMessage: 'manifest unknown'
        });
    });

    it('should refuse a reference that is not one', async () => {
        await expect(containerImageService.addImageFromRegistry({ reference: 'oops; rm -rf /', name: 'x' }))
            .rejects.toThrow('does not look like a container image reference');
        expect(mockDb.ContainerImage.create).not.toHaveBeenCalled();
    });

    it('should refuse a blocked reference', async () => {
        await expect(containerImageService.addImageFromRegistry({ reference: 'mysql:8', name: 'db' }))
            .rejects.toThrow('blocked');
    });

    it('should refuse a duplicate', async () => {
        mockDb.ContainerImage.findOne.mockResolvedValue({ id: 9 });

        await expect(containerImageService.addImageFromRegistry({ reference: 'ghcr.io/x/y:1', name: 'Y' }))
            .rejects.toThrow('already in the pool');
    });
});

describe('removeImage', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.Team.count.mockResolvedValue(0);
        mockContainerService.removeImage.mockResolvedValue(undefined);
    });

    function pooled(overrides: Record<string, any> = {}) {
        return {
            id: 1,
            reference: 'ghcr.io/x/y:1',
            source: ImageSource.REGISTRY,
            isGlobalDefault: false,
            isRecoverableAfterDeletion() { return this.source === ImageSource.REGISTRY; },
            destroy: jest.fn().mockResolvedValue(undefined),
            ...overrides
        };
    }

    it('should remove a registry image from the pool and the host', async () => {
        const image = pooled();
        mockDb.ContainerImage.findByPk.mockResolvedValue(image);

        await containerImageService.removeImage(1);

        expect(image.destroy).toHaveBeenCalled();
        expect(mockContainerService.removeImage).toHaveBeenCalledWith('ghcr.io/x/y:1');
    });

    it('should refuse to remove the global default', async () => {
        mockDb.ContainerImage.findByPk.mockResolvedValue(pooled({ isGlobalDefault: true }));

        await expect(containerImageService.removeImage(1)).rejects.toThrow('Set a different global default');
    });

    it('should refuse while a team still defaults to it', async () => {
        mockDb.ContainerImage.findByPk.mockResolvedValue(pooled());
        mockDb.Team.count.mockResolvedValue(2);

        await expect(containerImageService.removeImage(1)).rejects.toThrow('2 team(s)');
    });

    it('should refuse a platform image outright', async () => {
        // Choosing MySQL as a desktop only breaks that instance. Deleting it
        // takes the platform down, which is what the blocklist is really for.
        mockDb.ContainerImage.findByPk.mockResolvedValue(pooled({ reference: 'mysql:8' }));

        await expect(containerImageService.removeImage(1)).rejects.toThrow('underpins the platform');
    });

    it('should require confirmation for an image built here', async () => {
        mockDb.ContainerImage.findByPk.mockResolvedValue(pooled({ source: ImageSource.COMMIT }));

        await expect(containerImageService.removeImage(1)).rejects.toThrow('exists nowhere else');
    });

    it('should delete a locally built image when forced', async () => {
        const image = pooled({ source: ImageSource.COMMIT });
        mockDb.ContainerImage.findByPk.mockResolvedValue(image);

        await containerImageService.removeImage(1, { force: true });

        expect(image.destroy).toHaveBeenCalled();
    });

    it('should still drop the row when the host refuses to remove the image', async () => {
        const image = pooled();
        mockDb.ContainerImage.findByPk.mockResolvedValue(image);
        mockContainerService.removeImage.mockRejectedValue(new Error('image is in use'));

        await expect(containerImageService.removeImage(1)).resolves.toBeUndefined();

        expect(image.destroy).toHaveBeenCalled();
    });
});

describe('hostImagesAvailableToAdd', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockContainerService.listContainers.mockResolvedValue([]);
    });

    it('should exclude pooled, blocked and untagged images', async () => {
        mockContainerService.listImages.mockResolvedValue([
            { RepoTags: ['ghcr.io/x/viper:1'], Size: 100 },
            { RepoTags: ['ghcr.io/x/already:1'], Size: 200 },
            { RepoTags: ['mysql:8'], Size: 300 },
            { RepoTags: ['<none>:<none>'], Size: 400 },
            { RepoTags: null, Size: 500 }
        ]);
        mockDb.ContainerImage.findAll.mockResolvedValue([{ reference: 'ghcr.io/x/already:1' }]);

        const available = await containerImageService.hostImagesAvailableToAdd();

        expect(available.map((entry: any) => entry.reference)).toEqual(['ghcr.io/x/viper:1']);
    });
});

describe('hostImages and removeHostImage', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockContainerService.listImages.mockResolvedValue([
            { RepoTags: ['ghcr.io/x/viper:1'], Size: 10_000_000_000 },
            { RepoTags: ['ghcr.io/x/pooled:1'], Size: 500_000_000 },
            { RepoTags: ['mysql:8'], Size: 1_000_000_000 },
            { RepoTags: ['ghcr.io/x/busy:1'], Size: 200_000_000 }
        ]);
        mockDb.ContainerImage.findAll.mockResolvedValue([{ reference: 'ghcr.io/x/pooled:1' }]);
        mockContainerService.listContainers.mockResolvedValue([{ Image: 'ghcr.io/x/busy:1' }]);
        mockContainerService.removeImage.mockResolvedValue(undefined);
    });

    it('should show blocked and in-use images rather than hiding them', async () => {
        // This panel is also where disk usage is inspected, and an image that
        // cannot be deleted still occupies the disk.
        const images = await containerImageService.hostImages();

        expect(images.map((i: any) => i.reference)).toContain('mysql:8');
        expect(images.find((i: any) => i.reference === 'mysql:8').blocked).toBe(true);
        expect(images.find((i: any) => i.reference === 'ghcr.io/x/pooled:1').inPool).toBe(true);
        expect(images.find((i: any) => i.reference === 'ghcr.io/x/busy:1').inUse).toBe(true);
    });

    it('should list the largest first, since that is what disk pressure is about', async () => {
        const images = await containerImageService.hostImages();

        expect(images[0].reference).toBe('ghcr.io/x/viper:1');
    });

    it('should refuse to delete a platform image', async () => {
        await expect(containerImageService.removeHostImage('mysql:8'))
            .rejects.toThrow('underpins the platform');
        expect(mockContainerService.removeImage).not.toHaveBeenCalled();
    });

    it('should refuse to delete a pooled image and point at the pool', async () => {
        // The pool route checks defaults and team dependencies; bypassing it
        // here would delete an image teams still resolve to.
        await expect(containerImageService.removeHostImage('ghcr.io/x/pooled:1'))
            .rejects.toThrow('Remove the pool entry instead');
    });

    it('should refuse to delete an image a container still uses', async () => {
        await expect(containerImageService.removeHostImage('ghcr.io/x/busy:1'))
            .rejects.toThrow('container is still using');
    });

    it('should refuse something that is not on the host at all', async () => {
        await expect(containerImageService.removeHostImage('ghcr.io/x/absent:1'))
            .rejects.toThrow('not on this host');
    });

    it('should delete an unused, unpooled image', async () => {
        await containerImageService.removeHostImage('ghcr.io/x/viper:1');

        expect(mockContainerService.removeImage).toHaveBeenCalledWith('ghcr.io/x/viper:1');
    });
});

describe('commitInstanceToImage', () => {
    const instance = {
        id: 3,
        uuid: 'inst123abc45',
        dockerid: 'container-abc',
        isBuildInstance: true,
        imageReference: 'ghcr.io/x/base:1'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.ContainerImage.findOne.mockResolvedValue(null);
        mockDb.ContainerImage.create.mockImplementation(async (values: any) => ({ id: 77, ...values }));
        mockContainerService.execInContainer.mockResolvedValue({ output: '', exitCode: 0 });
        mockContainerService.commitContainer.mockResolvedValue({ Id: 'sha256:new' });
        mockContainerService.inspectImage.mockResolvedValue({ Id: 'sha256:new', Size: 8_000_000_000 });
    });

    it('should neutralise the master token in the committed image', async () => {
        // docker commit captures the container environment, which holds the
        // token that mints desktop access. It cannot be removed by supplying a
        // filtered Env, because the daemon merges the container's own
        // environment back over it, so a changes directive is the only lever.
        await containerImageService.commitInstanceToImage(instance, { name: 'Forensics Build' });

        const options = mockContainerService.commitContainer.mock.calls[0][1];
        expect(options.changes).toBe(`ENV ${MASTER_TOKEN_VAR}=${NEUTRALISED_TOKEN_VALUE}`);
    });

    it('should pass changes as a string, not an array', async () => {
        // dockerode JSON-encodes an array into the query string and the daemon
        // answers "ENV is not a valid change command".
        await containerImageService.commitInstanceToImage(instance, { name: 'Forensics Build' });

        expect(typeof mockContainerService.commitContainer.mock.calls[0][1].changes).toBe('string');
    });

    it('should reset /config before committing', async () => {
        await containerImageService.commitInstanceToImage(instance, { name: 'Forensics Build' });

        const commands = mockContainerService.execInContainer.mock.calls.map((call: any) => call[1].join(' '));
        expect(commands.some((command: string) => command.includes('/config'))).toBe(true);

        const resetCallOrder = mockContainerService.execInContainer.mock.invocationCallOrder[0];
        const commitCallOrder = mockContainerService.commitContainer.mock.invocationCallOrder[0];
        expect(resetCallOrder).toBeLessThan(commitCallOrder);
    });

    it('should not promote the desktop unless asked', async () => {
        await containerImageService.commitInstanceToImage(instance, { name: 'Forensics Build' });

        const commands = mockContainerService.execInContainer.mock.calls.map((call: any) => call[1].join(' '));
        expect(commands.some((command: string) => command.includes('/defaults'))).toBe(false);
    });

    it('should promote the desktop into image defaults before wiping /config', async () => {
        // Promotion has to happen first or the files it copies are already gone.
        await containerImageService.commitInstanceToImage(instance, {
            name: 'Forensics Build',
            promoteDesktop: true
        });

        const commands = mockContainerService.execInContainer.mock.calls.map((call: any) => call[1].join(' '));
        const firstPromote = commands.findIndex((command: string) => command.includes('/defaults'));
        // Matched on what the step is for rather than on the exact shell, so
        // changing how /config is cleared does not break a test about ordering.
        const reset = commands.findIndex((command: string) => /rm -rf .*\$entry|chown abc:abc \/config/.test(command));

        expect(firstPromote).toBeGreaterThanOrEqual(0);
        expect(firstPromote).toBeLessThan(reset);
    });

    it('should record what it was built from', async () => {
        const image: any = await containerImageService.commitInstanceToImage(instance, { name: 'Forensics Build' });

        expect(image.source).toBe(ImageSource.COMMIT);
        expect(image.builtFromInstanceId).toBe(3);
        expect(image.metadata.builtFromImage).toBe('ghcr.io/x/base:1');
        expect(image.reference).toBe('forensics-build:latest');
    });

    it('should honour an explicit tag', async () => {
        const image: any = await containerImageService.commitInstanceToImage(instance, {
            name: 'Forensics Build',
            tag: 'v3'
        });

        expect(image.reference).toBe('forensics-build:v3');
    });

    it('should refuse a name that collides with the pool', async () => {
        mockDb.ContainerImage.findOne.mockResolvedValue({ id: 5 });

        await expect(containerImageService.commitInstanceToImage(instance, { name: 'Forensics Build' }))
            .rejects.toThrow('already in the pool');
        expect(mockContainerService.commitContainer).not.toHaveBeenCalled();
    });

    it('should refuse a name that collides with a platform image', async () => {
        await expect(containerImageService.commitInstanceToImage(instance, { name: 'mysql' }))
            .rejects.toThrow('collides with an image the platform depends on');
    });

    it('should refuse an instance with no container', async () => {
        await expect(containerImageService.commitInstanceToImage({ uuid: 'x' }, { name: 'Anything' }))
            .rejects.toThrow('no container to commit');
    });

    it('should leave bind mounts alone when clearing /config', async () => {
        // Every real instance has the shared test corpus bind-mounted read-only
        // at /config/test-corpus. A plain recursive delete fails on it with
        // "Device or resource busy" and takes the whole commit down, which is
        // exactly what happened the first time this ran against a real desktop
        // rather than a bare probe container.
        await containerImageService.commitInstanceToImage(instance, { name: 'Forensics Build' });

        const reset = mockContainerService.execInContainer.mock.calls
            .map((call: any) => call[1].join(' '))
            .find((command: string) => command.includes('/config'));

        expect(reset).toMatch(/mountpoint|proc\/mounts/);
    });

    it('should not commit if the /config reset fails', async () => {
        // Committing anyway would ship the builder's home directory to every
        // user the image is launched for.
        mockContainerService.execInContainer.mockResolvedValue({ output: 'permission denied', exitCode: 1 });

        await expect(containerImageService.commitInstanceToImage(instance, { name: 'Forensics Build' }))
            .rejects.toThrow('Could not reset /config');
        expect(mockContainerService.commitContainer).not.toHaveBeenCalled();
    });
});
