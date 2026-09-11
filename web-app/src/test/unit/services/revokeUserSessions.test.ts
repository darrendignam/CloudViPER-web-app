/**
 * Logging out ends access, not work.
 *
 * A ViPER desktop can be running a long job, and that job lives in the
 * container's X session, which does not care whether anyone is watching. So
 * logout withdraws the user's Selkies tokens and leaves the container alone;
 * signing back in and launching mints a fresh one.
 */
jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

const mockContainerService = {
    getContainer: jest.fn(),
    execInContainer: jest.fn(),
    createContainer: jest.fn(),
    stopContainer: jest.fn(),
    removeContainer: jest.fn()
};

jest.mock('../../../services/ContainerService', () => ({
    __esModule: true,
    default: mockContainerService
}));

jest.mock('../../../models', () => ({
    ContainerImage: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() },
    Team: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn(), findOrCreate: jest.fn() },
    ViperInstance: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() },
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

import db from '../../../models';
import selkiesControlPlane from '../../../services/SelkiesControlPlane';
import viperInstanceService from '../../../services/ViperInstanceService';

const controlPlane = selkiesControlPlane as jest.Mocked<typeof selkiesControlPlane>;
const mockDb = db as unknown as { ViperInstance: { findAll: jest.Mock } };

const OWNER_ID = 42;
const LEADER_ID = 88;

function buildInstance(sessionTokens: Record<string, any>) {
    return {
        id: 7,
        uuid: 'abc123def456',
        name: 'viper-cloud-abc123def456',
        masterToken: 'master-token-for-instance',
        devPorts: null,
        sessionTokens,
        update: jest.fn().mockResolvedValue(undefined)
    };
}

const ownerToken = { role: 'controller', slot: null, mk_control: false, issuedAt: new Date().toISOString(), userId: OWNER_ID };
const leaderToken = { role: 'viewer', slot: null, mk_control: false, issuedAt: new Date().toISOString(), userId: LEADER_ID };

describe('revokeUserSessions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        controlPlane.replaceTokens.mockResolvedValue(undefined);
    });

    it('should leave the container running so a long job survives the logout', async () => {
        const instance = buildInstance({ 'owner-tok': ownerToken });
        mockDb.ViperInstance.findAll.mockResolvedValue([instance]);

        await viperInstanceService.revokeUserSessions(OWNER_ID);

        expect(mockContainerService.stopContainer).not.toHaveBeenCalled();
        expect(mockContainerService.removeContainer).not.toHaveBeenCalled();
        expect(instance.update).not.toHaveBeenCalledWith(
            expect.objectContaining({ status: expect.anything() })
        );
    });

    it('should withdraw only the logging-out user\'s token', async () => {
        const instance = buildInstance({ 'owner-tok': ownerToken, 'leader-tok': leaderToken });
        mockDb.ViperInstance.findAll.mockResolvedValue([instance]);

        await viperInstanceService.revokeUserSessions(OWNER_ID);

        // A team leader watching the same desktop keeps their view.
        expect(controlPlane.replaceTokens).toHaveBeenCalledWith(
            expect.anything(),
            { 'leader-tok': { role: 'viewer', slot: null, mk_control: false } }
        );
        expect(instance.update).toHaveBeenCalledWith({
            sessionTokens: { 'leader-tok': leaderToken }
        });
    });

    it('should send an empty set when the user held the only token', async () => {
        const instance = buildInstance({ 'owner-tok': ownerToken });
        mockDb.ViperInstance.findAll.mockResolvedValue([instance]);

        await viperInstanceService.revokeUserSessions(OWNER_ID);

        expect(controlPlane.replaceTokens).toHaveBeenCalledWith(expect.anything(), {});
        expect(instance.update).toHaveBeenCalledWith({ sessionTokens: {} });
    });

    it('should not touch an instance the user holds no token on', async () => {
        const instance = buildInstance({ 'leader-tok': leaderToken });
        mockDb.ViperInstance.findAll.mockResolvedValue([instance]);

        const count = await viperInstanceService.revokeUserSessions(OWNER_ID);

        expect(controlPlane.replaceTokens).not.toHaveBeenCalled();
        expect(instance.update).not.toHaveBeenCalled();
        expect(count).toBe(0);
    });

    it('should revoke across every instance the user holds a token on', async () => {
        const own = buildInstance({ 'owner-tok': ownerToken });
        const observed = buildInstance({ 'owner-tok-2': ownerToken, 'leader-tok': leaderToken });
        mockDb.ViperInstance.findAll.mockResolvedValue([own, observed]);

        const count = await viperInstanceService.revokeUserSessions(OWNER_ID);

        expect(count).toBe(2);
        expect(controlPlane.replaceTokens).toHaveBeenCalledTimes(2);
    });

    it('should still clear the record when the container cannot be reached', async () => {
        // A stopped container leaves the row as the only account of what is
        // live, so it must not keep a token that logout has withdrawn.
        const instance = buildInstance({ 'owner-tok': ownerToken });
        mockDb.ViperInstance.findAll.mockResolvedValue([instance]);
        controlPlane.replaceTokens.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(viperInstanceService.revokeUserSessions(OWNER_ID)).resolves.toBe(0);

        expect(instance.update).toHaveBeenCalledWith({ sessionTokens: {} });
    });

    it('should ignore tokens minted before user ids were recorded', async () => {
        // Pre-existing tokens carry userId null, and null is nobody's id, so
        // they are left for the TTL to clear rather than attributed to whoever
        // logs out first.
        const legacy = { role: 'controller', slot: null, mk_control: false, issuedAt: new Date().toISOString(), userId: null };
        const instance = buildInstance({ 'legacy-tok': legacy });
        mockDb.ViperInstance.findAll.mockResolvedValue([instance]);

        const count = await viperInstanceService.revokeUserSessions(OWNER_ID);

        expect(count).toBe(0);
        expect(instance.update).not.toHaveBeenCalled();
    });

    it('should do nothing without a user id', async () => {
        const count = await viperInstanceService.revokeUserSessions(0);

        expect(count).toBe(0);
        expect(mockDb.ViperInstance.findAll).not.toHaveBeenCalled();
    });

    it('should exclude deleted instances from the search', async () => {
        mockDb.ViperInstance.findAll.mockResolvedValue([]);

        await viperInstanceService.revokeUserSessions(OWNER_ID);

        const where = mockDb.ViperInstance.findAll.mock.calls[0][0].where;
        expect(where.status).toBeDefined();
    });
});
