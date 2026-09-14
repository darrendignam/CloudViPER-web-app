/**
 * MySQL hands DECIMAL back as a string, and Sequelize passes that through
 * untouched. A string reaching Docker as NanoCpus is NaN, which the daemon
 * refuses, so the container never starts and the reason is nowhere near the
 * cause. The getter on cpuLimit is what stops that, and this is what stops the
 * getter being tidied away later.
 */
import { Sequelize } from 'sequelize';
import defineContainerImage from '../../../models/containerimage';

// Never connected. build() is enough to exercise the attribute definitions.
const sequelize = new Sequelize('database', 'user', 'password', { dialect: 'mysql', logging: false });
const ContainerImage = defineContainerImage(sequelize);

function build(values: Record<string, unknown> = {}) {
    return ContainerImage.build({ reference: 'ghcr.io/x/viper:2.1', name: 'Workshop', ...values } as any);
}

describe('resource limit columns', () => {
    it('should read a decimal back as a number, not the string MySQL returns', () => {
        const image = build({ cpuLimit: '2.50' }) as any;

        expect(image.cpuLimit).toBe(2.5);
        expect(typeof image.cpuLimit).toBe('number');
    });

    it('should survive the arithmetic that turns cores into nanocpus', () => {
        const image = build({ cpuLimit: '0.50' }) as any;

        expect(Math.round(image.cpuLimit * 1e9)).toBe(5e8);
    });

    it('should keep an unset limit null rather than turning it into zero', () => {
        // Null means "use the appliance default". Zero would mean a container
        // with no CPU at all.
        const image = build() as any;

        expect(image.cpuLimit).toBeNull();
        expect(image.memoryLimitMb).toBeUndefined();
    });

    it('should hold memory as a plain number', () => {
        expect((build({ memoryLimitMb: 2048 }) as any).memoryLimitMb).toBe(2048);
    });
});
