import express, { Application } from 'express';
import exphbs from './config/handlebars';
import bodyParser from 'body-parser';
import passport from 'passport';
import flash from 'connect-flash';
import { logSession, appLogger } from './config/logger';

import configAuth from './config/auth';
import { readIntEnv } from './utility/envConfig';
import { isGoogleAuthConfigured } from './config/auth';
import { isEmailConfigured } from './utility/emailRelay';



const app: Application = express();
const PORT: number = readIntEnv('PORT', 3000);
const secure_cookie = process.env.NODE_ENV === 'production';

// Log application startup
appLogger.info('Application starting', {
    nodeEnv: process.env.NODE_ENV,
    port: PORT,
    dbUser: process.env.DB_USER,
    timestamp: new Date().toISOString()
});

// Say so at boot rather than at the moment someone is waiting on an invitation.
// Both of these are optional, and both change who can get into the system, so
// silence about them is the wrong default.
if (!isEmailConfigured()) {
    appLogger.warn('Outgoing email is not configured: invitations and password resets will not be delivered', {
        eventType: 'Email Not Configured',
        timestamp: new Date().toISOString()
    });
}

if (!isGoogleAuthConfigured()) {
    appLogger.warn('Google sign-in is not configured: only local accounts can sign in', {
        eventType: 'Google Auth Not Configured',
        timestamp: new Date().toISOString()
    });
}

// Begin server setup
app.use( bodyParser.urlencoded({ extended: true}) );
app.use( bodyParser.json({ limit: '10mb' }) ); // Add JSON body parser with 10MB limit for screenshots
const path = require('path');
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Get domain name from environment variable
const DOMAIN_NAME = process.env.DOMAIN_NAME || 'cloudviper.org';
const DOMAIN_WITHOUT_WWW = DOMAIN_NAME.replace('www.', '');

// Prod specific 
if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next)=>{
        // Allow internal Docker network requests to bypass HTTPS redirect
        const isInternalRequest = 
            req.ip?.startsWith('172.') || // Docker internal network
            req.ip?.startsWith('10.') ||  // Docker internal network
            req.hostname === 'cloud-viper-gui-app' ||
            req.hostname === 'localhost';
        
        const isServiceEndpoint = req.path.startsWith('/service/');
        
        // Skip HTTPS redirect for internal service requests
        if (isInternalRequest && isServiceEndpoint) {
            appLogger.debug('Bypassing HTTPS redirect for internal request', {
                eventType: 'HTTPS Redirect Bypass',
                ip: req.ip,
                hostname: req.hostname,
                path: req.path,
                timestamp: new Date().toISOString()
            });
            return next();
        }
        
        //force https for external requests
        if (req.headers['x-forwarded-proto'] !== 'https') {
            return res.redirect(302, [`https://${DOMAIN_NAME}`, req.url].join('')); 
        }
        next();
    });
}

// Sessions
import session from 'express-session'
const MySQLStore = require('express-mysql-session')(session);
const SQLStore = new MySQLStore(configAuth.mysqlSessionAuth);
const session_config: session.SessionOptions = {
    name: "vipercloud.sid",
    // sameSite 'lax' keeps the session cookie off cross-site POSTs, so a third
    // party page cannot drive a state-changing request as the signed-in user.
    // Top-level GET navigation still carries it, which is why anything that
    // mints or revokes credentials is a POST.
    cookie: {
        maxAge: ((4 * 24) * 60 * 60 * 1000),
        secure: secure_cookie,
        httpOnly: true,
        sameSite: 'lax'
    }, // 4 days
    store: SQLStore,
    secret: process.env.APP_COOKIE_SECRET || 'default_secret', // Replace with your own secret key
    resave: false,
    saveUninitialized: false,
};

// Add session to app
const sessionMW = session(session_config);
app.use(sessionMW);
app.use(flash());

// Configure passport
app.use(passport.initialize());
app.use(passport.session());
import configurePassport from './config/passport';
// import { default } from './config/passport';
configurePassport(passport);

// View Engine
app.set('views', path.join(__dirname, 'views'));
app.engine('handlebars', exphbs.engine);
app.set('view engine', 'handlebars');

// Disable view caching in development for live reloading
if (process.env.NODE_ENV === 'dev' || process.env.NODE_ENV === 'development') {
    app.set('view cache', false);
}

app.use(express.static(path.join(__dirname, 'public')));

// Add routes
app.use('/', require('./routes/home').default);
app.use('/account', require('./routes/account').default);
app.use('/service', require('./routes/service').default);
app.use('/images', require('./routes/images').default);

//Prod SSL Stuff
if (process.env.NODE_ENV === 'production') {
    app.use(function (req, res, next) {
        if (req.headers.host === DOMAIN_WITHOUT_WWW) {
            res.redirect(302, `https://${DOMAIN_NAME}` + req.originalUrl);
        } else {
            next();
        }
    });
}

// Middleware to log session events with enhanced metadata
app.use((req, res, next) => {
    if (!req.session) {
        return next();
    }

    // Cast session to any to add custom properties
    const session = req.session as any;
    const user = req.user as any;

    // Only log if this is a new session or user authentication event
    const shouldLog = !session.logged || user !== session.lastUser;
    
    if (shouldLog) {
        // Determine event type
        let eventType = 'Session Activity';
        if (!session.logged) {
            eventType = 'Session Creation';
            session.logged = true;
        } else if (user && user !== session.lastUser) {
            eventType = user ? 'User Login' : 'User Logout';
        }
        
        // Track last user state
        session.lastUser = user;
        
        // Log session event with comprehensive metadata
        try {
            logSession(eventType, req, {
                sessionAge: req.session.cookie.maxAge,
                cookieSecure: req.session.cookie.secure,
                isNewSession: !session.logged,
                userRole: user?.role || null,
                userEmail: user?.email || null
            });
        } catch (err) {
            // console, not appLogger: this reports appLogger itself failing.
            console.error('Failed to log session event:', err);
        }
    }
    
    next();
});

// Middleware to log important route access
app.use((req, res, next) => {
    const user = req.user as any;
    const importantRoutes = [
        '/service/new-instance',
        '/service/terminate-instance',
        '/service/admin',
        '/account/login',
        '/account/logout',
        '/account/register'
    ];
    
    const isImportantRoute = importantRoutes.some(route => 
        req.originalUrl.startsWith(route)
    );
    
    if (isImportantRoute || (req.method !== 'GET' && req.method !== 'HEAD')) {
        try {
            logSession('Route Access', req, {
                route: req.originalUrl,
                method: req.method,
                userRole: user?.role || 'anonymous',
                statusCode: res.statusCode,
                bodySize: req.headers['content-length'] || null
            });
        } catch (err) {
            // console, not appLogger: this reports appLogger itself failing.
            console.error('Failed to log route access:', err);
        }
    }
    
    next();
});

// catch 404 and forward to error handler
app.use(function(req, res ) {
    appLogger.warn('404 Not Found', {
        url: req.originalUrl,
        method: req.method,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        referer: req.headers['referer'],
        timestamp: new Date().toISOString()
    });
    res.status(404).json({ error: { code: 404, status: 'not found' } });
});

// Start the server
app.listen(PORT, () => {
    appLogger.info('Server started successfully', {
        port: PORT,
        nodeEnv: process.env.NODE_ENV,
        timestamp: new Date().toISOString()
    });
});

