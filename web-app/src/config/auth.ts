import './env';

const auth = {
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

export default auth;