jest.mock('../../../config/logger', () => ({
    appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    logSQL: jest.fn(),
    logSession: jest.fn()
}));

const mockContainerService = {
    info: jest.fn(),
    listContainers: jest.fn(),
    containerStats: jest.fn()
};

jest.mock('../../../services/ContainerService', () => ({
    __esModule: true,
    default: mockContainerService
}));

jest.mock('../../../models', () => ({
    ViperInstance: { findAll: jest.fn() },
    User: { findByPk: jest.fn() },
    ContainerImage: { findAll: jest.fn() },
    Team: { findByPk: jest.fn() },
    sequelize: { query: jest.fn() }
}));

import systemStatsService, { cpuPercentFromSample } from '../../../services/SystemStatsService';
import { CLOUDVIPER_INSTANCE_LABEL } from '../../../services/ViperInstanceService';

/** A sample shaped like Docker's, with the deltas the calculation needs. */
function sample(overrides: Record<string, any> = {}) {
    return {
        cpu_stats: {
            cpu_usage: { total_usage: 2_000_000_000 },
            system_cpu_usage: 100_000_000_000,
            online_cpus: 2
        },
        precpu_stats: {
            cpu_usage: { total_usage: 1_000_000_000 },
            system_cpu_usage: 98_000_000_000
        },
        memory_stats: { usage: 500 * 1024 ** 2, limit: 4 * 1024 ** 3 },
        ...overrides
    };
}

describe('cpuPercentFromSample', () => {
    it('should compute a percentage from the delta between two cumulative counters', () => {
        // Docker never reports a percentage; it only exists as a delta. Here
        // the container used 1e9ns while the system advanced 2e9ns across 2
        // cores, so it had half of one core, which is 50% of one and 100% when
        // expressed against a single core's worth of capacity.
        expect(cpuPercentFromSample(sample(), 2)).toBe(100);
    });

    it('should scale by the number of cores Docker reports', () => {
        const oneCore = sample({
            cpu_stats: {
                cpu_usage: { total_usage: 2_000_000_000 },
                system_cpu_usage: 100_000_000_000,
                online_cpus: 1
            }
        });

        expect(cpuPercentFromSample(oneCore, 1)).toBe(50);
    });

    it('should answer null on a first sample, not zero', () => {
        // A container sampled for the first time has no previous reading. Zero
        // would be a claim about its CPU use; null says the figure is not known
        // yet, which is the truth.
        const first = sample({ precpu_stats: { cpu_usage: { total_usage: 0 } } });

        expect(cpuPercentFromSample(first, 2)).toBeNull();
    });

    it('should answer null rather than divide by zero', () => {
        const stalled = sample({
            precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 100_000_000_000 }
        });

        expect(cpuPercentFromSample(stalled, 2)).toBeNull();
    });

    it('should answer null on a malformed sample', () => {
        expect(cpuPercentFromSample(null, 2)).toBeNull();
        expect(cpuPercentFromSample({}, 2)).toBeNull();
    });

    it('should fall back to the host core count when Docker omits online_cpus', () => {
        const noCores = sample({
            cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 100_000_000_000 }
        });

        expect(cpuPercentFromSample(noCores, 4)).toBe(200);
    });
});

describe('hostStats', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockContainerService.info.mockResolvedValue({ NCPU: 2, Containers: 5, ContainersRunning: 4 });
    });

    it('should report core count and container counts from Docker', async () => {
        const stats = await systemStatsService.hostStats();

        expect(stats.cpuCount).toBe(2);
        expect(stats.containers).toEqual({ total: 5, running: 4 });
    });

    it('should express load against core count', async () => {
        const stats = await systemStatsService.hostStats();

        // A load of N on N cores is 100%. Reporting raw load alone is a figure
        // nobody can interpret without knowing the core count.
        if (stats.loadAverage.length) {
            expect(stats.loadPercent).toBeCloseTo((stats.loadAverage[0] / 2) * 100, 1);
        }
    });

    it('should still answer when Docker cannot be reached', async () => {
        // The dashboard asking about host health is exactly when the daemon
        // might be unavailable, so this must degrade rather than throw.
        mockContainerService.info.mockRejectedValue(new Error('socket missing'));

        const stats = await systemStatsService.hostStats();

        expect(stats.containers).toBeNull();
        expect(stats.cpuCount).toBe(0);
        expect(stats.loadPercent).toBeNull();
    });

    it('should read host memory, not the container total', async () => {
        const stats = await systemStatsService.hostStats();

        expect(stats.memory).not.toBeNull();
        expect(stats.memory!.totalBytes).toBeGreaterThan(0);
        expect(stats.memory!.usedBytes).toBe(stats.memory!.totalBytes - stats.memory!.availableBytes);
    });
});

describe('instanceStats', () => {
    beforeEach(() => jest.clearAllMocks());

    it('should ask Docker only for containers this service owns', async () => {
        // Scoped by the ownership label, so the database and the app itself
        // never appear next to the desktops an admin is trying to read.
        mockContainerService.listContainers.mockResolvedValue([]);

        await systemStatsService.instanceStats(2);

        expect(mockContainerService.listContainers).toHaveBeenCalledWith({
            filters: { label: [CLOUDVIPER_INSTANCE_LABEL] }
        });
    });

    it('should report per-instance cpu and memory', async () => {
        mockContainerService.listContainers.mockResolvedValue([
            { Id: 'abc', Names: ['/viper-cloud-inst1'], Labels: { [CLOUDVIPER_INSTANCE_LABEL]: 'inst1' } }
        ]);
        mockContainerService.containerStats.mockResolvedValue(sample());

        const stats = await systemStatsService.instanceStats(2);

        expect(stats).toHaveLength(1);
        expect(stats[0].name).toBe('viper-cloud-inst1');
        expect(stats[0].uuid).toBe('inst1');
        expect(stats[0].cpuPercent).toBe(100);
        expect(stats[0].memoryPercent).toBeCloseTo(12.2, 0);
    });

    it('should survive a container that stops mid-sample', async () => {
        // Listing and sampling are two calls; a desktop terminated between them
        // is ordinary, not an error worth failing the whole dashboard for.
        mockContainerService.listContainers.mockResolvedValue([
            { Id: 'gone', Names: ['/viper-cloud-gone'], Labels: { [CLOUDVIPER_INSTANCE_LABEL]: 'gone' } }
        ]);
        mockContainerService.containerStats.mockRejectedValue(new Error('no such container'));

        const stats = await systemStatsService.instanceStats(2);

        expect(stats).toHaveLength(1);
        expect(stats[0].cpuPercent).toBeNull();
    });

    it('should list the heaviest instance first', async () => {
        mockContainerService.listContainers.mockResolvedValue([
            { Id: 'a', Names: ['/viper-cloud-small'], Labels: { [CLOUDVIPER_INSTANCE_LABEL]: 'small' } },
            { Id: 'b', Names: ['/viper-cloud-big'], Labels: { [CLOUDVIPER_INSTANCE_LABEL]: 'big' } }
        ]);
        mockContainerService.containerStats.mockImplementation(async (id: string) =>
            sample({ memory_stats: { usage: id === 'b' ? 2 * 1024 ** 3 : 100 * 1024 ** 2, limit: 4 * 1024 ** 3 } })
        );

        const stats = await systemStatsService.instanceStats(2);

        expect(stats.map(s => s.name)).toEqual(['viper-cloud-big', 'viper-cloud-small']);
    });

    it('should return nothing when Docker cannot be listed', async () => {
        mockContainerService.listContainers.mockRejectedValue(new Error('daemon down'));

        await expect(systemStatsService.instanceStats(2)).resolves.toEqual([]);
    });
});
