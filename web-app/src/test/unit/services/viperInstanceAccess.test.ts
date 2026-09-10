import { SelkiesControlPlaneError } from '../../../services/SelkiesControlPlane';

jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

jest.mock('../../../services/ContainerService', () => ({
    __esModule: true,
    default: { getContainer: jest.fn(), execInContainer: jest.fn(), createContainer: jest.fn() }
}));

jest.mock('../../../models', () => ({
    ViperInstance: { findOne: jest.fn(), create: jest.fn(), update: jest.fn() },
    User: { findByPk: jest.fn() },
    sequelize: { query: jest.fn() }
}));

jest.mock('../../../services/SelkiesControlPlane', () => {
    const actual = jest.requireActual('../../../services/SelkiesControlPlane');
    return {
        __esModule: true,
        ...actual,
        default: { grantSoleToken: jest.fn(), revokeAll: jest.fn(), replaceTokens: jest.fn() }
    };
});

import selkiesControlPlane from '../../../services/SelkiesControlPlane';
import viperInstanceService from '../../../services/ViperInstanceService';
import { appLogger } from '../../../config/logger';

const controlPlane = selkiesControlPlane as jest.Mocked<typeof selkiesControlPlane>;

describe('ViperInstanceService instance access', () => {
    const instance = {
        id: 7,
        uuid: 'abc123def456',
        name: 'viper-cloud-abc123def456',
        masterToken: 'master-token-for-instance'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        controlPlane.grantSoleToken.mockResolvedValue(undefined);
        controlPlane.revokeAll.mockResolvedValue(undefined);
    });

    describe('grantInstanceAccess', () => {
        it('should mint a high-entropy token and register it against the instance host', async () => {
            const token = await viperInstanceService.grantInstanceAccess(instance);

            expect(token).toHaveLength(43);
            expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(controlPlane.grantSoleToken).toHaveBeenCalledWith(
                { host: 'viper-cloud-abc123def456', masterToken: 'master-token-for-instance' },
                token,
                'controller'
            );
        });

        it('should mint a different token on every call so relaunching invalidates the old link', async () => {
            const first = await viperInstanceService.grantInstanceAccess(instance);
            const second = await viperInstanceService.grantInstanceAccess(instance);

            expect(first).not.toBe(second);
        });

        it('should pass the requested role through to the control plane', async () => {
            const token = await viperInstanceService.grantInstanceAccess(instance, 'viewer');

            expect(controlPlane.grantSoleToken).toHaveBeenCalledWith(expect.anything(), token, 'viewer');
        });

        it('should refuse an instance created before Selkies support', async () => {
            await expect(
                viperInstanceService.grantInstanceAccess({ ...instance, masterToken: null })
            ).rejects.toThrow(/predates Selkies support/);

            expect(controlPlane.grantSoleToken).not.toHaveBeenCalled();
        });

        it('should propagate control plane failures rather than returning a dead token', async () => {
            controlPlane.grantSoleToken.mockRejectedValue(
                new SelkiesControlPlaneError('rejected', 'viper-cloud-abc123def456', 401)
            );

            await expect(viperInstanceService.grantInstanceAccess(instance)).rejects.toBeInstanceOf(
                SelkiesControlPlaneError
            );
        });
    });

    describe('revokeInstanceAccess', () => {
        it('should clear every token for the instance', async () => {
            await viperInstanceService.revokeInstanceAccess(instance);

            expect(controlPlane.revokeAll).toHaveBeenCalledWith({
                host: 'viper-cloud-abc123def456',
                masterToken: 'master-token-for-instance'
            });
        });

        it('should swallow an unreachable container so termination still completes', async () => {
            controlPlane.revokeAll.mockRejectedValue(
                new SelkiesControlPlaneError('Could not reach control plane', 'viper-cloud-abc123def456')
            );

            await expect(viperInstanceService.revokeInstanceAccess(instance)).resolves.toBeUndefined();
            expect(appLogger.warn).toHaveBeenCalledWith(
                'Could not revoke instance access - container may already be gone',
                expect.objectContaining({ instanceUUID: 'abc123def456' })
            );
        });

        it('should be a no-op for an instance with no master token', async () => {
            await viperInstanceService.revokeInstanceAccess({ ...instance, masterToken: null });

            expect(controlPlane.revokeAll).not.toHaveBeenCalled();
        });
    });
});

describe('ViperInstanceService instance inspection', () => {
    const db = require('../../../models');
    const containerService = require('../../../services/ContainerService').default;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should never serialise the container environment values', async () => {
        db.ViperInstance.findOne.mockResolvedValue({ id: 1, uuid: 'abc', createdAt: new Date() });
        containerService.getContainer.mockReturnValue({
            inspect: jest.fn().mockResolvedValue({
                Config: {
                    Env: [
                        'SELKIES_MASTER_TOKEN=the-master-token',
                        'STATUS_KEY=the-status-key',
                        'PUID=1000'
                    ]
                }
            })
        });

        const result = await viperInstanceService.inspectInstance('container-1');

        expect(JSON.stringify(result)).not.toContain('the-master-token');
        expect(JSON.stringify(result)).not.toContain('the-status-key');
        expect(result.dockerInspect.Config.Env).toEqual([
            'SELKIES_MASTER_TOKEN=[redacted]',
            'STATUS_KEY=[redacted]',
            'PUID=[redacted]'
        ]);
    });

    it('should exclude credential columns from the instance row it returns', async () => {
        db.ViperInstance.findOne.mockResolvedValue({ id: 1, uuid: 'abc', createdAt: new Date() });
        containerService.getContainer.mockReturnValue({ inspect: jest.fn().mockResolvedValue({}) });

        await viperInstanceService.inspectInstance('container-1');

        expect(db.ViperInstance.findOne).toHaveBeenCalledWith(
            expect.objectContaining({
                attributes: { exclude: ['masterToken', 'statusKey'] }
            })
        );
    });

    it('should tolerate an inspect payload with no environment', async () => {
        db.ViperInstance.findOne.mockResolvedValue({ id: 1, uuid: 'abc', createdAt: new Date() });
        containerService.getContainer.mockReturnValue({ inspect: jest.fn().mockResolvedValue({ Config: {} }) });

        await expect(viperInstanceService.inspectInstance('container-1')).resolves.toBeDefined();
    });
});
