import { EventEmitter } from 'events';

const mockCreateContainer = jest.fn();
const mockGetContainer = jest.fn();

jest.mock('dockerode', () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
        createContainer: (...args: any[]) => mockCreateContainer(...args),
        getContainer: (...args: any[]) => mockGetContainer(...args),
        ping: jest.fn()
    }))
}));

const mockLoggerError = jest.fn();
jest.mock('../../../config/logger', () => ({
    appLogger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: (...args: any[]) => mockLoggerError(...args),
        debug: jest.fn()
    }
}));

import { DockerContainerService } from '../../../services/ContainerService';

const MASTER_TOKEN = 'sekrit-master-token-value';

function buildExec(inspectResults: any[]) {
    const stream = new EventEmitter();
    const inspect = jest.fn();
    inspectResults.forEach((result) => inspect.mockResolvedValueOnce(result));
    inspect.mockResolvedValue(inspectResults[inspectResults.length - 1]);

    return {
        inspect,
        start: jest.fn().mockImplementation(async () => {
            process.nextTick(() => stream.emit('end'));
            return stream;
        })
    };
}

describe('DockerContainerService.createContainer', () => {
    let service: DockerContainerService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new DockerContainerService();
    });

    it('should keep the master token out of the log when Docker refuses the create', async () => {
        mockCreateContainer.mockRejectedValue(new Error('Conflict: name already in use'));

        const options = {
            name: 'viper-cloud-abc',
            Env: [`SELKIES_MASTER_TOKEN=${MASTER_TOKEN}`, 'PUID=1000']
        };

        await expect(service.createContainer(options)).rejects.toThrow('Conflict');

        expect(mockLoggerError).toHaveBeenCalled();
        const logged = JSON.stringify(mockLoggerError.mock.calls);
        expect(logged).not.toContain(MASTER_TOKEN);
        // The container name is what makes the log useful, so it must survive.
        expect(logged).toContain('viper-cloud-abc');
    });

    it('should pass the unredacted options to Docker itself', async () => {
        mockCreateContainer.mockResolvedValue({ id: 'abc123' });
        const options = { Env: [`SELKIES_MASTER_TOKEN=${MASTER_TOKEN}`] };

        await service.createContainer(options);

        expect(mockCreateContainer).toHaveBeenCalledWith(options);
        expect(options.Env).toEqual([`SELKIES_MASTER_TOKEN=${MASTER_TOKEN}`]);
    });
});

describe('DockerContainerService.execInContainer', () => {
    let service: DockerContainerService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new DockerContainerService();
    });

    it('should report a genuine zero exit code', async () => {
        const exec = buildExec([{ Running: false, ExitCode: 0 }]);
        mockGetContainer.mockReturnValue({ exec: jest.fn().mockResolvedValue(exec) });

        const result = await service.execInContainer('abc123', ['true']);

        expect(result.exitCode).toBe(0);
    });

    it('should report a non-zero exit code', async () => {
        const exec = buildExec([{ Running: false, ExitCode: 1 }]);
        mockGetContainer.mockReturnValue({ exec: jest.fn().mockResolvedValue(exec) });

        const result = await service.execInContainer('abc123', ['false']);

        expect(result.exitCode).toBe(1);
    });

    it('should wait for a still-running exec rather than reading its null exit code', async () => {
        // Docker can answer the first inspect with Running true and ExitCode
        // null, which the old `|| 0` turned into success.
        const exec = buildExec([
            { Running: true, ExitCode: null },
            { Running: true, ExitCode: null },
            { Running: false, ExitCode: 127 }
        ]);
        mockGetContainer.mockReturnValue({ exec: jest.fn().mockResolvedValue(exec) });

        const result = await service.execInContainer('abc123', ['nosuchbinary']);

        expect(result.exitCode).toBe(127);
        expect(exec.inspect).toHaveBeenCalledTimes(3);
    });

    it('should report a negative code when Docker never settles the exec', async () => {
        const exec = buildExec([{ Running: true, ExitCode: null }]);
        mockGetContainer.mockReturnValue({ exec: jest.fn().mockResolvedValue(exec) });

        const result = await service.execInContainer('abc123', ['hangs']);

        // Never 0: an unsettled exec must not read as success.
        expect(result.exitCode).toBeLessThan(0);
    }, 10000);

    it('should collect the command output', async () => {
        const stream = new EventEmitter();
        const exec = {
            inspect: jest.fn().mockResolvedValue({ Running: false, ExitCode: 0 }),
            start: jest.fn().mockImplementation(async () => {
                process.nextTick(() => {
                    stream.emit('data', Buffer.from('hello '));
                    stream.emit('data', Buffer.from('world'));
                    stream.emit('end');
                });
                return stream;
            })
        };
        mockGetContainer.mockReturnValue({ exec: jest.fn().mockResolvedValue(exec) });

        const result = await service.execInContainer('abc123', ['echo', 'hello world']);

        expect(result.output).toBe('hello world');
    });
});
