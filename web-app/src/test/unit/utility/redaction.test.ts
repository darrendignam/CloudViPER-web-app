import {
    redactEnvironmentValues,
    redactContainerOptions,
    redactContainerInspect
} from '../../../utility/redaction';

const MASTER_TOKEN = 'sekrit-master-token-value';

describe('redactEnvironmentValues', () => {
    it('should replace every value while keeping the variable name', () => {
        const result = redactEnvironmentValues([
            `SELKIES_MASTER_TOKEN=${MASTER_TOKEN}`,
            'TITLE=ViPER'
        ]);

        expect(result).toEqual([
            'SELKIES_MASTER_TOKEN=[redacted]',
            'TITLE=[redacted]'
        ]);
    });

    it('should redact a value that itself contains an equals sign', () => {
        // base64url avoids '=' padding, but nothing guarantees every secret
        // that lands in an environment does, and split('=')[0] must not leak
        // the tail.
        const result = redactEnvironmentValues(['TOKEN=abc=def=ghi']);

        expect(result).toEqual(['TOKEN=[redacted]']);
        expect(JSON.stringify(result)).not.toContain('def');
    });

    it('should pass through anything that is not an array', () => {
        expect(redactEnvironmentValues(undefined)).toBeUndefined();
        expect(redactEnvironmentValues(null)).toBeNull();
    });
});

describe('redactContainerOptions', () => {
    it('should redact the master token from create options', () => {
        const options = {
            Image: 'ghcr.io/example/viper:2.0.0-alpha',
            name: 'viper-cloud-abc',
            Env: [`SELKIES_MASTER_TOKEN=${MASTER_TOKEN}`, 'PUID=1000']
        };

        const redacted = redactContainerOptions(options);

        expect(JSON.stringify(redacted)).not.toContain(MASTER_TOKEN);
        expect(redacted.Env).toEqual(['SELKIES_MASTER_TOKEN=[redacted]', 'PUID=[redacted]']);
    });

    it('should leave the rest of the options intact for diagnosis', () => {
        const redacted = redactContainerOptions({
            Image: 'viper:2.0',
            name: 'viper-cloud-abc',
            Env: ['A=1']
        });

        expect(redacted.Image).toBe('viper:2.0');
        expect(redacted.name).toBe('viper-cloud-abc');
    });

    it('should not mutate the object it was given', () => {
        const options = { Env: [`SELKIES_MASTER_TOKEN=${MASTER_TOKEN}`] };

        redactContainerOptions(options);

        expect(options.Env).toEqual([`SELKIES_MASTER_TOKEN=${MASTER_TOKEN}`]);
    });

    it('should tolerate options with no environment at all', () => {
        expect(redactContainerOptions({ Image: 'viper:2.0' })).toEqual({
            Image: 'viper:2.0',
            Env: undefined
        });
        expect(redactContainerOptions(null)).toBeNull();
    });
});

describe('redactContainerInspect', () => {
    it('should redact the environment nested under Config', () => {
        const inspect = {
            Id: 'abc123',
            Config: { Image: 'viper:2.0', Env: [`SELKIES_MASTER_TOKEN=${MASTER_TOKEN}`] }
        };

        const redacted = redactContainerInspect(inspect);

        expect(JSON.stringify(redacted)).not.toContain(MASTER_TOKEN);
        expect(redacted.Config.Env).toEqual(['SELKIES_MASTER_TOKEN=[redacted]']);
        expect(redacted.Id).toBe('abc123');
        expect(redacted.Config.Image).toBe('viper:2.0');
    });

    it('should pass through an inspect result with no Config', () => {
        expect(redactContainerInspect({ Id: 'abc123' })).toEqual({ Id: 'abc123' });
        expect(redactContainerInspect(undefined)).toBeUndefined();
    });

    it('should not mutate the inspect result it was given', () => {
        const inspect = { Config: { Env: [`SELKIES_MASTER_TOKEN=${MASTER_TOKEN}`] } };

        redactContainerInspect(inspect);

        expect(inspect.Config.Env).toEqual([`SELKIES_MASTER_TOKEN=${MASTER_TOKEN}`]);
    });
});
