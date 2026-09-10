import fs from 'fs';
import path from 'path';

interface ScriptTemplateVariables {
    INSTANCE_UUID: string;
    SERVICE_URL: string;
    DOMAIN_NAME: string;
    STATUS_KEY: string;
}

const REQUIRED_SCRIPTS = [
    'viper-monitor.sh',
    'viper-monitor.desktop'
];

// The monitoring scripts live at the repository root, but the built app sits one
// directory deeper than the sources: from dist/utility the root is ../../, from
// src/utility it is ../../../. Probing both keeps a dev run and the image reading
// the same files, rather than dev silently finding nothing. Resolved on each call
// rather than once at import, so the layout is not frozen at module load.
function scriptDirectoryCandidates(): string[] {
    return [
        path.join(__dirname, '../../scripts'),
        path.join(__dirname, '../../../scripts')
    ];
}

/**
 * Resolve the directory holding the instance provisioning scripts.
 * SCRIPTS_DIR overrides the search when the layout differs from either default.
 */
export function getScriptsDirectory(): string {
    if (process.env.SCRIPTS_DIR) {
        return process.env.SCRIPTS_DIR;
    }

    const candidates = scriptDirectoryCandidates();
    const found = candidates.find((candidate) =>
        fs.existsSync(path.join(candidate, REQUIRED_SCRIPTS[0]))
    );

    return found ?? candidates[0];
}

/**
 * Read a script file and substitute template variables
 */
export function readAndProcessScript(scriptName: string, variables: ScriptTemplateVariables): string {
    const scriptPath = path.join(getScriptsDirectory(), scriptName);

    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Script file not found: ${scriptPath}`);
    }

    let scriptContent = fs.readFileSync(scriptPath, 'utf8');

    Object.entries(variables).forEach(([key, value]) => {
        const placeholder = `{{${key}}}`;
        scriptContent = scriptContent.replace(new RegExp(placeholder, 'g'), value);
    });

    return scriptContent;
}

/**
 * Get all available script files
 */
export function getAvailableScripts(): string[] {
    const scriptsDir = getScriptsDirectory();

    if (!fs.existsSync(scriptsDir)) {
        return [];
    }

    return fs.readdirSync(scriptsDir).filter(file =>
        file.endsWith('.sh') ||
        file.endsWith('.service') ||
        file.endsWith('.desktop')
    );
}

/**
 * Validate that required scripts exist
 */
export function validateRequiredScripts(): { valid: boolean; missing: string[] } {
    const scriptsDir = getScriptsDirectory();
    const missing = REQUIRED_SCRIPTS.filter(script => !fs.existsSync(path.join(scriptsDir, script)));

    return {
        valid: missing.length === 0,
        missing
    };
}
