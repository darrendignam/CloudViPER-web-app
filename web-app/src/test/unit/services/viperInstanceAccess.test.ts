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
    ContainerImage: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() },
    Team: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), findOrCreate: jest.fn() },
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

const instanceFixture = () => ({
    id: 7,
    uuid: 'abc123def456',
    name: 'viper-cloud-abc123def456',
    masterToken: 'master-token-for-instance',
    sessionTokens: {},
    devPorts: null,
    update: jest.fn().mockResolvedValue(undefined)
});

import selkiesControlPlane from '../../../services/SelkiesControlPlane';
import viperInstanceService from '../../../services/ViperInstanceService';
import { appLogger } from '../../../config/logger';

const controlPlane = selkiesControlPlane as jest.Mocked<typeof selkiesControlPlane>;

describe('ViperInstanceService instance access', () => {
    let instance: any;

    beforeEach(() => {
        jest.clearAllMocks();
        instance = instanceFixture();
        controlPlane.grantSoleToken.mockResolvedValue(undefined);
        controlPlane.revokeAll.mockResolvedValue(undefined);
        controlPlane.replaceTokens.mockResolvedValue(undefined);
    });

    describe('grantInstanceAccess', () => {
        it('should mint a high-entropy token and register it against the instance host', async () => {
            const token = await viperInstanceService.grantInstanceAccess(instance);

            expect(token).toHaveLength(43);
            expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(controlPlane.replaceTokens).toHaveBeenCalledWith(
                { host: 'viper-cloud-abc123def456', masterToken: 'master-token-for-instance' },
                { [token]: { role: 'controller', slot: null, mk_control: false } }
            );
        });

        it('should mint a different token on every call so relaunching invalidates the old link', async () => {
            const first = await viperInstanceService.grantInstanceAccess(instance);
            const second = await viperInstanceService.grantInstanceAccess(instance);

            expect(first).not.toBe(second);
        });

        it('should pass the requested role through to the control plane', async () => {
            const token = await viperInstanceService.grantInstanceAccess(instance, 'viewer');

            expect(controlPlane.replaceTokens.mock.calls[0][1][token].role).toBe('viewer');
        });

        it('should keep existing tokens live so a viewer does not eject the owner', async () => {
            const ownerToken = 'owner-token-already-issued';
            instance.sessionTokens = {
                [ownerToken]: { role: 'controller', slot: null, mk_control: false, issuedAt: new Date().toISOString() }
            };

            const viewerToken = await viperInstanceService.grantInstanceAccess(instance, 'viewer');
            const sent = controlPlane.replaceTokens.mock.calls[0][1];

            expect(Object.keys(sent).sort()).toEqual([ownerToken, viewerToken].sort());
            expect(sent[ownerToken].role).toBe('controller');
            expect(sent[viewerToken].role).toBe('viewer');
        });

        it('should drop tokens past their lifetime rather than accumulating them', async () => {
            const stale = new Date(Date.now() - (13 * 60 * 60 * 1000)).toISOString();
            instance.sessionTokens = {
                'long-forgotten': { role: 'controller', slot: null, mk_control: false, issuedAt: stale }
            };

            const token = await viperInstanceService.grantInstanceAccess(instance);
            const sent = controlPlane.replaceTokens.mock.calls[0][1];

            expect(Object.keys(sent)).toEqual([token]);
        });

        it('should not send its own bookkeeping field to the control plane', async () => {
            const token = await viperInstanceService.grantInstanceAccess(instance);

            expect(controlPlane.replaceTokens.mock.calls[0][1][token]).not.toHaveProperty('issuedAt');
        });

        it('should persist the issued set so the next grant can rebuild it', async () => {
            const token = await viperInstanceService.grantInstanceAccess(instance);

            expect(instance.update).toHaveBeenCalledWith({
                sessionTokens: expect.objectContaining({ [token]: expect.objectContaining({ role: 'controller' }) })
            });
        });

        it('should address the control plane by published port in development', async () => {
            instance.devPorts = { web: 3010, control: 3011 };

            await viperInstanceService.grantInstanceAccess(instance);

            expect(controlPlane.replaceTokens).toHaveBeenCalledWith(
                { host: '127.0.0.1', masterToken: 'master-token-for-instance', port: 3011 },
                expect.anything()
            );
        });

        it('should refuse an instance created before Selkies support', async () => {
            await expect(
                viperInstanceService.grantInstanceAccess({ ...instanceFixture(), masterToken: null })
            ).rejects.toThrow(/predates Selkies support/);

            expect(controlPlane.replaceTokens).not.toHaveBeenCalled();
        });

        it('should propagate control plane failures rather than returning a dead token', async () => {
            controlPlane.replaceTokens.mockRejectedValue(
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
            await viperInstanceService.revokeInstanceAccess({ ...instanceFixture(), masterToken: null });

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
                attributes: { exclude: ['masterToken', 'statusKey', 'sessionTokens'] }
            })
        );
    });

    it('should tolerate an inspect payload with no environment', async () => {
        db.ViperInstance.findOne.mockResolvedValue({ id: 1, uuid: 'abc', createdAt: new Date() });
        containerService.getContainer.mockReturnValue({ inspect: jest.fn().mockResolvedValue({ Config: {} }) });

        await expect(viperInstanceService.inspectInstance('container-1')).resolves.toBeDefined();
    });
});
