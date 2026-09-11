import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { appLogger } from '../config/logger';
import { Strategy as LocalStrategy } from 'passport-local';
import { PassportStatic } from 'passport';
import db from '../models';
import configAuth, { isGoogleAuthConfigured } from './auth';
import helperFunctions from '../utility/helperFunctions';

const options = {
    usernameField: 'email',
    // usernameField: 'username',
    incorrectUsernameError: 'Incorrect username',
    incorrectPasswordError: 'Incorrect password',
}

export default (passport: PassportStatic) => {
    //passport.use(db.User.createStrategy());
 
    passport.use(new LocalStrategy({ usernameField: options.usernameField }, (username, password, done) => {
        if (process.env.NODE_ENV === 'dev' || process.env.NODE_ENV === 'development') {
            // Never widen this to include the password. appLogger writes to a
            // rotated file with 14 day retention that /service/logs/app serves
            // to admins, so anything logged here outlives the request.
            appLogger.info('LocalStrategy authentication attempt', {
                eventType: 'Local Strategy Attempt',
                username,
                timestamp: new Date().toISOString()
            });
        }
        db.User.findOne({ 
            where: { [options.usernameField]: username } ,
            attributes: { include: ['hash', 'salt'] } // Include hash and salt fields
        }).then((user: any | null) => {
                if (!user) {
                    return done(null, false, { message: options.incorrectUsernameError });
                }

                user.authenticate(password)
                    .then((authenticatedUser: any) => {
                        if (authenticatedUser) {
                            return done(null, user);
                        } else {
                            return done(null, false, { message: options.incorrectPasswordError });
                        }
                    })
                    .catch(done);
            })
            .catch(done);
    }));
    
    // passport.use(new LocalStrategy(db.User.authenticateUser()));

    passport.serializeUser((user: any, done: (err: any, id?: any) => void) => {
        done(null, user.email);
    });
    
    passport.deserializeUser((email: string, done: (err: any, user?: any) => void) => {
        db.User.findOne({ where: { email: email } }).then((user: any | null) => {
            done(null, user);
        }).catch(done);
    });
    
    // Registering the strategy without a client id throws, which took the whole
    // process down on an appliance that simply does not use Google sign-in.
    // Optional means optional: skip it and leave the rest of auth working.
    if (!isGoogleAuthConfigured()) {
        appLogger.warn('Google sign-in is not configured, skipping that strategy', {
            eventType: 'Google Auth Disabled',
            timestamp: new Date().toISOString()
        });
        return;
    }

    passport.use(new GoogleStrategy(configAuth.googleAuth, 
        (accessToken: string, refreshToken: string, profile: any, done: (err: any, user?: any) => void) => {
            const _email = profile.emails[0].value || '';

            db.User.findOne({ where: { oauthID: profile.id } })
            .then((user: any | null) => {
                if (user) {
                    // If the user with the oauthID exists, return the user
                    return done(null, user);
                } else {
                    // If no user with the oauthID exists, look for a user with the same email
                    db.User.findOne({ where: { email: _email } })
                    .then((existingUser: any | null) => {
                        if (existingUser) {
                            // Update the existing user with the oauthID
                            existingUser.oauthID = profile.id;
                            existingUser.save().then((updatedUser: any) => {
                                return done(null, updatedUser);
                            }).catch((err: any) => {
                                return done(err);
                            });
                        } else {
                            // If no user with the same email exists, create a new user
                            const newUser = db.User.build({
                                username: helperFunctions.sanitizeUsername(profile.displayName),
                                email: _email,
                                oauthID: profile.id,
                                role: helperFunctions.updateRoleIfAdmin(_email),
                            });
                            newUser.save().then((savedUser: any) => {
                                return done(null, savedUser);
                            }).catch((err: any) => {
                                return done(err);
                            });
                        }
                    }).catch((err: any) => {
                        return done(err);
                    });
                }
            }).catch((err: any) => {
                return done(err);
            });
        }
    ));
};