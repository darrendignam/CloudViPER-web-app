import {
    SelkiesControlPlane,
    SelkiesControlPlaneError,
    SELKIES_CONTROL_PORT,
    SelkiesTarget
} from '../../../services/SelkiesControlPlane';

jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

describe('SelkiesControlPlane', () => {
    const target: SelkiesTarget = { host: 'viper-cloud-abc123', masterToken: 'master-secret' };
    let controlPlane: SelkiesControlPlane;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        controlPlane = new SelkiesControlPlane();
        fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
        global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('replaceTokens', () => {
        it('should POST the token set to the control plane port with bearer auth', async () => {
            const tokens = { 'tok-1': { role: 'controller' as const, slot: null, mk_control: false } };

            await controlPlane.replaceTokens(target, tokens);

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, options] = fetchMock.mock.calls[0];
            expect(url).toBe(`http://viper-cloud-abc123:${SELKIES_CONTROL_PORT}/tokens`);
            expect(options.method).toBe('POST');
            expect(options.headers.Authorization).toBe('Bearer master-secret');
            expect(options.headers['Content-Type']).toBe('application/json');
            expect(JSON.parse(options.body)).toEqual(tokens);
        });

        it('should honour an explicit port override', async () => {
            await controlPlane.replaceTokens({ ...target, port: 9999 }, {});

            expect(fetchMock.mock.calls[0][0]).toBe('http://viper-cloud-abc123:9999/tokens');
        });

        it('should send an abort signal so a hung container cannot wedge the request', async () => {
            await controlPlane.replaceTokens(target, {});

            expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
        });

        it('should raise SelkiesControlPlaneError carrying the status when rejected', async () => {
            fetchMock.mockResolvedValue({ ok: false, status: 401 });

            await expect(controlPlane.replaceTokens(target, {})).rejects.toMatchObject({
                name: 'SelkiesControlPlaneError',
                statusCode: 401,
                host: 'viper-cloud-abc123'
            });
        });

        it('should raise SelkiesControlPlaneError with no status when unreachable', async () => {
            fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

            const error = await controlPlane.replaceTokens(target, {}).catch((e) => e);

            expect(error).toBeInstanceOf(SelkiesControlPlaneError);
            expect(error.statusCode).toBeUndefined();
            expect(error.message).toContain('Could not reach control plane');
            expect(error.cause).toBeInstanceOf(Error);
        });

        it('should report a timeout distinctly from a refused connection', async () => {
            const timeout = new Error('The operation was aborted');
            timeout.name = 'TimeoutError';
            fetchMock.mockRejectedValue(timeout);

            await expect(controlPlane.replaceTokens(target, {})).rejects.toThrow(/did not answer within/);
        });
    });

    describe('grantSoleToken', () => {
        it('should register exactly one controller token, displacing any others', async () => {
            await controlPlane.grantSoleToken(target, 'the-only-token');

            const body = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(Object.keys(body)).toEqual(['the-only-token']);
            expect(body['the-only-token']).toEqual({ role: 'controller', slot: null, mk_control: false });
        });

        it('should support minting a viewer token', async () => {
            await controlPlane.grantSoleToken(target, 'watch-only', 'viewer');

            expect(JSON.parse(fetchMock.mock.calls[0][1].body)['watch-only'].role).toBe('viewer');
        });

        it('should propagate control plane failures to the caller', async () => {
            fetchMock.mockResolvedValue({ ok: false, status: 500 });

            await expect(controlPlane.grantSoleToken(target, 'tok')).rejects.toBeInstanceOf(SelkiesControlPlaneError);
        });
    });

    describe('revokeAll', () => {
        it('should POST an empty set, which disconnects every live client', async () => {
            await controlPlane.revokeAll(target);

            expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
        });
    });
});
