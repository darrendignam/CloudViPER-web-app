import './env';

const auth = {
    // Google sign-in is optional. An appliance that does not use it leaves these
    // unset, and isGoogleAuthConfigured is what every consumer checks rather
    // than each re-deciding what counts as configured.
    'googleAuth':
    {
        clientID: process.env.GOOGLE_AUTH_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_AUTH_CLIENT_SECRET || '',
        callbackURL: `https://${process.env.DOMAIN_NAME || 'cloudviper.org'}/account/google/return/`,
    },

    'mysqlSessionAuth':
    {   
        host: process.env.DB_HOST || 'localhost', 
        port: 3306, 
        user: process.env.DB_USER || 'root', 
        password: process.env.DB_PASSWORD || 'password',
        database: process.env.DB_NAME || 'database',
    },
};

/**
 * Whether Google sign-in can actually be offered.
 *
 * Both halves are required: a client id without a secret fails at the token
 * exchange rather than at startup, which is a far more confusing way to find
 * out the configuration is incomplete.
 */
export function isGoogleAuthConfigured(): boolean {
    return Boolean(auth.googleAuth.clientID && auth.googleAuth.clientSecret);
}

export default auth;