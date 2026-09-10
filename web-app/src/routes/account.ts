import express, { Request, Response } from 'express';
import { Op } from 'sequelize';
import db from '../models/';
import mysql from 'mysql2';
import passport from 'passport';
import crypto from 'crypto';
import helperFunctions from '../utility/helperFunctions';
import emailRelay from '../utility/emailRelay';
import configAuth from '../config/auth';
import { appLogger } from '../config/logger';
import viperInstanceService from '../services/ViperInstanceService';
import { UserRole, isValidRole, toUserRole } from '../types/UserRole';


const router = express.Router();

router.use(express.json()); // parse json

/*
ROLES:

user - nothing
testing - can run one viper
member - can run one viper
subscriber - pays for use
admin - viper and user management

Note: These roles are now defined as an enum in ../types/UserRole.ts
*/

function userAsJSON(user: any): object {
    try{
        return {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role
        };
    } catch (err) {
        appLogger.error("Error converting user to JSON: ", { error: (err as Error)?.message ?? String(err), timestamp: new Date().toISOString() });
        return {};
    }
}
interface AccountUser {
    id: number;
    username: string;
    email: string;
    role: UserRole;
    team?: string;
    invitedById?: number;
}


router.get('/', (req: Request, res: Response) => {
    const user = req.user as AccountUser | undefined;
    if (user) {
        const alertSuccess = req.flash('alert-success');
        //console.log( JSON.stringify(user) );

        switch (user.role) {
            case UserRole.ADMIN:
                res.redirect('/service/admin');
                break;
            case UserRole.TEAM_ADMIN:
                res.redirect('/service/team-admin');
                break;
            case UserRole.TEAM_LEADER:
                res.redirect('/service/team-leader');
                break;
            case UserRole.TESTING:
                res.redirect('/service/testing');
                break;
            case UserRole.MEMBER:
                res.redirect('/service/member');
                break;
            case UserRole.SUBSCRIBER:
                res.redirect('/service/member'); // Subscribers use the member view for now
                break;

            default:
                
                // Fetch full user data from database to ensure we have email
                db.User.findByPk(user.id).then((fullUser: any | null) => {
                    if (fullUser) {
                        res.render('user_account_index', {
                            user: userAsJSON(fullUser),
                            alertSuccess: alertSuccess
                        });
                    } else {
                        // Fallback to session user if DB lookup fails
                        res.render('user_account_index', {
                            user: req.user ? userAsJSON( req.user ) : {},
                            alertSuccess: alertSuccess
                        });
                    }
                }).catch((err: Error) => {
                    appLogger.error("Error fetching full user data:", { error: (err as Error)?.message ?? String(err), timestamp: new Date().toISOString() });
                    // Fallback to session user if DB lookup fails
                    res.render('user_account_index', {
                        user: req.user ? userAsJSON( req.user ) : {},
                        alertSuccess: alertSuccess
                    });
                });
        }

    } else {
        res.redirect('/account/login');
    }
});

router.post('/update', (req: Request, res: Response) => {
    const _action = req.body.action;
    const _userid = req.body.userid;

    const user = req.user as AccountUser | undefined;

    if (user && (user.role == UserRole.ADMIN || user.id == _userid)) {
        switch (_action) {
            case 'get':
                interface FindUserResponse {
                    message?: string;
                    user?: AccountUser;
                }

                db.User.findOne({ where: { id: _userid } }).then((user: any | null) => {
                    if (!user) {
                        const response: FindUserResponse = { message: 'Not found.' };
                        res.status(400).json(response);
                        return;
                    }
                    res.json(user);
                }).catch(() => {
                    appLogger.error("Error finding user by id: ", { detail: _userid, timestamp: new Date().toISOString() });
                    const response: FindUserResponse = { message: 'Error finding user.' };
                    res.status(500).json(response);
                });

                break;

            default:
                res.json(req.user); // send back the actual user, like get
        }
    } else {
        res.status(403).json({ message: 'Unauthorized.' });
    }
});

router.get('/users', async (req: Request, res: Response) => {
    const user = req.user as AccountUser | undefined;

    if (!user) {
        res.status(403).send({ message: "Unauthorized" });
        return;
    }

    try {
        let users: any[];
        
        if (user.role === UserRole.ADMIN) {
            // Admins see all users with inviter information
            users = await db.User.findAll({
                include: [{
                    model: db.User,
                    as: 'invitedBy',
                    attributes: ['id', 'username', 'email']
                }]
            });
        } else if (user.role === UserRole.TEAM_ADMIN || user.role === UserRole.TEAM_LEADER) {
            // Team admins and leaders see only their team members
            if (!user.team || user.team === 'none') {
                res.status(403).send({ message: "You must be in a team" });
                return;
            }
            users = await db.User.findAll({
                where: { team: user.team },
                include: [{
                    model: db.User,
                    as: 'invitedBy',
                    attributes: ['id', 'username', 'email']
                }]
            });
        } else {
            res.status(403).send({ message: "Insufficient permissions" });
            return;
        }

        res.json(users);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// Get all unique teams in the system (admin only)
router.get('/teams', async (req: Request, res: Response) => {
    const user = req.user as AccountUser | undefined;

    if (!user || user.role !== UserRole.ADMIN) {
        res.status(403).send({ message: "Unauthorized" });
        return;
    }

    try {
        const teams = await db.User.findAll({
            attributes: [[db.sequelize.fn('DISTINCT', db.sequelize.col('team')), 'team']],
            where: {
                team: {
                    [Op.ne]: 'none'
                }
            },
            raw: true
        });

        const teamNames = teams.map((t: any) => t.team).filter((team: string) => team && team !== 'none');
        res.json(teamNames);
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// Update user's team (admin only)
router.put('/users/:id/team', async (req: Request, res: Response): Promise<void> => {
    const currentUser = req.user as AccountUser;
    
    if (!currentUser || currentUser.role !== UserRole.ADMIN) {
        res.status(403).send({ message: "Unauthorized" });
        return;
    }

    const userId = req.params.id;
    const newTeam = req.body.team || 'none';

    try {
        const user = await db.User.findByPk(userId);
        
        if (!user) {
            res.status(404).send({ message: 'User not found' });
            return;
        }

        const oldTeam = user.team;
        user.team = newTeam;
        await user.save();

        appLogger.info('User team updated', {
            eventType: 'User Team Update',
            userId: user.id,
            userEmail: user.email,
            oldTeam,
            newTeam,
            updatedBy: currentUser.id,
            updatedByUsername: currentUser.username,
            timestamp: new Date().toISOString()
        });

        res.json({ message: 'Team updated successfully', user });
    } catch (error) {
        appLogger.error('Failed to update user team', {
            eventType: 'User Team Update Error',
            userId,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        res.status(500).send({ message: 'Error updating team', error: (error as Error).message });
    }
});

router.put('/users/:id/role', async (req: Request, res: Response): Promise<void> => {
    const currentUser = req.user as AccountUser;
    
    // Check permissions based on role
    const canUpdateRole = currentUser && (
        currentUser.role === UserRole.ADMIN ||
        currentUser.role === UserRole.TEAM_ADMIN
    );
    
    if (!canUpdateRole) {
        res.status(403).send({ message: "Unauthorized" });
        return;
    }

    const userId = req.params.id;
    const newRole = req.body.role;

    // Validate the new role
    if (!isValidRole(newRole)) {
        res.status(400).send({ 
            message: 'Invalid role', 
            validRoles: Object.values(UserRole) 
        });
        return;
    }

    try {
        // Get the target user's current role for logging
        const targetUser = await db.User.findByPk(userId);
        
        if (!targetUser) {
            res.status(404).send({ message: 'User not found' });
            return;
        }
        
        const oldRole = targetUser.role;

        // Team admin restrictions
        if (currentUser.role === UserRole.TEAM_ADMIN) {
            // Ensure target user is in their team
            if (targetUser.team !== currentUser.team) {
                res.status(403).send({ message: 'Can only update roles within your team' });
                return;
            }
            
            // Team admins can only assign USER, MEMBER, or TEAM_LEADER roles
            const allowedRoles = [UserRole.USER, UserRole.MEMBER, UserRole.TEAM_LEADER];
            if (!allowedRoles.includes(newRole as UserRole)) {
                res.status(403).send({ message: 'Team admins can only assign USER, MEMBER, or TEAM_LEADER roles' });
                return;
            }
        }


        await db.User.update({ role: newRole }, { where: { id: userId } });
        
        // Log the role change
        appLogger.info('User role changed', {
            eventType: 'Role Change',
            targetUserId: parseInt(userId),
            targetUserEmail: targetUser.email,
            targetUsername: targetUser.username,
            oldRole,
            newRole,
            changedByUserId: currentUser.id,
            changedByUsername: currentUser.username,
            changedByRole: currentUser.role,
            timestamp: new Date().toISOString()
        });

        res.status(200).send({ message: 'Role updated successfully' });
    } catch (error) {
        appLogger.error('Role change failed', {
            eventType: 'Role Change Error',
            targetUserId: parseInt(userId),
            newRole,
            changedByUserId: currentUser.id,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });
        res.status(500).send({ message: 'Error updating role', error });
    }
});

router.post('/users/invite', async (req: Request, res: Response): Promise<void> => {
    const currentUser = req.user as AccountUser;
    
    // Check if user has permission to invite based on their role
    const canInvite = currentUser && (
        currentUser.role === UserRole.ADMIN ||
        currentUser.role === UserRole.TEAM_ADMIN ||
        currentUser.role === UserRole.TEAM_LEADER
    );
    
    if (!canInvite) {
        res.status(403).send({ message: 'Unauthorized' });
        return;
    }
    
    // Validate the role before processing
    const assignedRole = toUserRole(req.body.role);
    const teamName = req.body.team || currentUser.team || 'none';
    
    // Role-based permission checks
    if (currentUser.role === UserRole.TEAM_LEADER) {
        // Team leaders can only invite members to their team
        if (assignedRole !== UserRole.MEMBER) {
            res.status(403).send({ message: 'Team leaders can only invite members' });
            return;
        }
        if (!currentUser.team || currentUser.team === 'none') {
            res.status(403).send({ message: 'You must be in a team to invite users' });
            return;
        }
    }
    
    if (currentUser.role === UserRole.TEAM_ADMIN) {
        // Team admins can invite members and team leaders to their team
        if (![UserRole.MEMBER, UserRole.TEAM_LEADER].includes(assignedRole)) {
            res.status(403).send({ message: 'Team admins can only invite members and team leaders' });
            return;
        }
        if (!currentUser.team || currentUser.team === 'none') {
            res.status(403).send({ message: 'You must be in a team to invite users' });
            return;
        }
    }
    
    try {
        const newUsername = helperFunctions.generateUsername(req.body.email);
        
        const userData: any = {
            username: newUsername,
            role: assignedRole,
            email: req.body.email,
            oauthProvider: "vipercloud",
            invitedById: currentUser.id,
            team: teamName
        };
        
        const user = await db.User.register(userData, helperFunctions.generateRandomString(25)/*password*/);
        
        // Log successful user invitation
        appLogger.info('User invited successfully', {
            eventType: 'User Invitation',
            newUserId: user.id,
            newUserEmail: req.body.email,
            newUsername,
            assignedRole: assignedRole,
            team: teamName,
            invitedByUserId: currentUser.id,
            invitedByUsername: currentUser.username,
            invitedByRole: currentUser.role,
            timestamp: new Date().toISOString()
        });
        
        try {
            await emailRelay.sendInvitedEmail(req.body.email, newUsername, currentUser.username);
            
            // Log successful email sending
            appLogger.info('Invitation email sent', {
                eventType: 'Invitation Email',
                recipientEmail: req.body.email,
                recipientUsername: newUsername,
                invitedByUsername: currentUser.username,
                timestamp: new Date().toISOString()
            });
        } catch (emailError) {
            appLogger.error('Error sending invitation email:', { error: (emailError as Error)?.message ?? String(emailError), timestamp: new Date().toISOString() });
            
            // Log email failure
            appLogger.error('Invitation email failed', {
                eventType: 'Invitation Email Error',
                recipientEmail: req.body.email,
                recipientUsername: newUsername,
                invitedByUsername: currentUser.username,
                error: (emailError as Error).message,
                timestamp: new Date().toISOString()
            });
            // Continue execution - user was created successfully even if email failed
        }
        
        res.status(200).send({ message: 'User invited successfully', user });
    } catch (err: any) {
        // Log invitation failure
        appLogger.error('User invitation failed', {
            eventType: 'User Invitation Error',
            targetEmail: req.body.email,
            targetRole: assignedRole,
            team: teamName,
            invitedByUserId: currentUser.id,
            invitedByUsername: currentUser.username,
            error: err.message,
            timestamp: new Date().toISOString()
        });
        
        res.status(500).send({ message: 'Error inviting user', err });
    }
});

router.get('/sessions', (req: Request, res: Response) => {
    if (req.user && (req.user as AccountUser).role == UserRole.ADMIN) {
        const connection = mysql.createConnection(configAuth.mysqlSessionAuth);
        const query = 'SELECT session_id, expires, data FROM sessions';

        connection.query(query, (error, results: mysql.RowDataPacket[]) => {
          if (error) {
            appLogger.error('Error retrieving sessions:', { error: (error as Error)?.message ?? String(error), timestamp: new Date().toISOString() });
            return res.status(500).send({ message: 'Error retrieving sessions', error });
          }
      
          const safeSessions = results.map(session => {
            const sessionData = JSON.parse(session.data);
            const expiresAt = new Date(sessionData.cookie.expires); 
            const isExpired = Date.now() > expiresAt.getTime(); 
            let sessionUsername = 'unknown';
            if (sessionData.passport && sessionData.passport.user){
              sessionUsername = sessionData.passport.user;
            }

            return {
              id: session.session_id,
              username: sessionUsername,
              loginTime: new Date(sessionData.cookie.expires).toLocaleString(),
              expiresAt: expiresAt.toLocaleString(), 
              status: isExpired ? 'expired' : 'active',
            };
          });
      
          res.json(safeSessions);
        });   
    } else {
        res.status(403).send({ message: 'Error 2' });
    }
});

// Delete individual session (admin only)
router.delete('/sessions/:sessionId', (req: Request, res: Response): void => {
    if (req.user && (req.user as AccountUser).role == UserRole.ADMIN) {
        const sessionId = req.params.sessionId;
        
        if (!sessionId || typeof sessionId !== 'string') {
            res.status(400).json({ 
                success: false, 
                message: 'Invalid session ID provided' 
            });
            return;
        }

        const connection = mysql.createConnection(configAuth.mysqlSessionAuth);
        const query = 'DELETE FROM sessions WHERE session_id = ?';

        connection.query(query, [sessionId], (error, results: mysql.OkPacket) => {
            if (error) {
                appLogger.error('Error deleting session:', { error: (error as Error)?.message ?? String(error), timestamp: new Date().toISOString() });
                res.status(500).json({ 
                    success: false, 
                    message: 'Error deleting session', 
                    error: error.message 
                });
                return;
            }

            if (results.affectedRows === 0) {
                res.status(404).json({ 
                    success: false, 
                    message: 'Session not found' 
                });
                return;
            }

            res.json({ 
                success: true, 
                message: 'Session deleted successfully',
                sessionId: sessionId,
                affectedRows: results.affectedRows
            });
        });
    } else {
        res.status(403).json({ 
            success: false, 
            message: 'Admin access required' 
        });
    }
});

// Revoke all sessions (admin only)
router.delete('/sessions', (req: Request, res: Response): void => {
    if (req.user && (req.user as AccountUser).role == UserRole.ADMIN) {
        const connection = mysql.createConnection(configAuth.mysqlSessionAuth);
        
        // First get count of sessions to be deleted
        const countQuery = 'SELECT COUNT(*) as count FROM sessions';
        
        connection.query(countQuery, (countError, countResults: mysql.RowDataPacket[]) => {
            if (countError) {
                appLogger.error('Error counting sessions:', { error: (countError as Error)?.message ?? String(countError), timestamp: new Date().toISOString() });
                res.status(500).json({ 
                    success: false, 
                    message: 'Error counting sessions', 
                    error: countError.message 
                });
                return;
            }

            const sessionCount = countResults[0].count;
            
            if (sessionCount === 0) {
                res.json({ 
                    success: true, 
                    message: 'No sessions to revoke',
                    deletedCount: 0
                });
                return;
            }

            // Delete all sessions
            const deleteQuery = 'DELETE FROM sessions';
            
            connection.query(deleteQuery, (deleteError, deleteResults: mysql.OkPacket) => {
                if (deleteError) {
                    appLogger.error('Error revoking all sessions:', { error: (deleteError as Error)?.message ?? String(deleteError), timestamp: new Date().toISOString() });
                    res.status(500).json({ 
                        success: false, 
                        message: 'Error revoking all sessions', 
                        error: deleteError.message 
                    });
                    return;
                }

                res.json({ 
                    success: true, 
                    message: `Successfully revoked ${deleteResults.affectedRows} session(s)`,
                    deletedCount: deleteResults.affectedRows
                });
            });
        });
    } else {
        res.status(403).json({ 
            success: false, 
            message: 'Admin access required' 
        });
    }
});

// Removed the routes for register and register post
// These routes are disabled during the Testing Phase of the app development

// router.get('/register', (req: Request, res: Response) => {
//     res.render('user_account_register');
// });

// router.post('/register', (req: Request, res: Response) => {
//     db.User.register({
//         username: helperFunctions.sanitizeUsername(req.body.username),
//         role: "user",
//         email: req.body.email,
//         oauthProvider: "vipercloud",
//         // createdAt: Date.now()
//     }, req.body.password).then((user: User) => {
//         emailRelay.sendWelcomeEmail(req.body.email, helperFunctions.sanitizeUsername(req.body.username));
//         req.flash('alert-success', 'Thanks for setting up a ViPER account - you may need to contact an admin to get full access to the services on offer.');
//         req.login(user, (err: Error) => {
//             if (err) {
//                 console.log(err);
//                 res.status(500).json({ message: 'Error logging in user.' });
//             } else {
//                 res.redirect('/account');
//             }
//         });

//     }).catch((err: Error) => {
//         console.log(err);
//         res.status(500).json({ message: 'Error creating user.' });
//     });
// });


router.get('/login', (req: Request, res: Response) => {
    //Force log out? redirect if already logged in?
    const errorMsg = req.flash('error');
    res.render('user_account_login', { error_message: errorMsg });
});


router.post('/login', passport.authenticate('local', { failureRedirect: '/account/login', failureFlash: true }),
    (req, res) => {
        if (req.user) {
            const user = req.user as AccountUser;
            
            // Log successful login
            appLogger.info('User logged in successfully', {
                eventType: 'User Login',
                userId: user.id,
                username: user.username,
                userRole: user.role,
                ipAddress: req.ip,
                userAgent: req.headers['user-agent'],
                timestamp: new Date().toISOString()
            });
            
            res.redirect('/account');
        } else {
            appLogger.info("Login failed... redirecting....", { timestamp: new Date().toISOString() });
            
            // Log failed login attempt
            appLogger.warn('Login attempt failed', {
                eventType: 'Login Failure',
                ipAddress: req.ip,
                userAgent: req.headers['user-agent'],
                timestamp: new Date().toISOString()
            });
            
            res.redirect('/account/login');
        }
    });

router.get('/logout', async (req: Request, res: Response) => {
    const user = req.user as AccountUser;

    // Withdraw the desktop credentials before the session ends, so a launch URL
    // copied out of this session stops working. Containers keep running: a long
    // job survives the logout and the user reconnects with a fresh token after
    // signing back in.
    //
    // Awaited rather than fired and forgotten, so logout does not report access
    // as ended while a token is still live. A failure must never trap the user
    // in a signed-in state, so it is logged and swallowed.
    if (user?.id) {
        try {
            await viperInstanceService.revokeUserSessions(user.id);
        } catch (error) {
            appLogger.error('Could not revoke desktop sessions on logout', {
                eventType: 'Logout Revoke Error',
                userId: user.id,
                error: (error as Error).message,
                timestamp: new Date().toISOString()
            });
        }
    }

    // Express 4 does not forward a rejected async handler to the error
    // middleware, so anything thrown past this point would leave the request
    // hanging until the client gives up rather than returning a status.
    try {
        req.logout((err) => {
            if (err) {
                appLogger.error('Logout error', {
                    eventType: 'Logout Error',
                    userId: user?.id,
                    username: user?.username,
                    error: err.message,
                    timestamp: new Date().toISOString()
                });
                // Answering once. This used to fall through to the redirect
                // below as well, throwing "Cannot set headers after they are
                // sent".
                res.status(500).json({ error: 'Logout failed' });
                return;
            }

            appLogger.info('User logged out', {
                eventType: 'User Logout',
                userId: user?.id,
                username: user?.username,
                userRole: user?.role,
                ipAddress: req.ip,
                timestamp: new Date().toISOString()
            });
            res.redirect('/account/login');
        });
    } catch (error) {
        appLogger.error('Logout failed unexpectedly', {
            eventType: 'Logout Error',
            userId: user?.id,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
        });

        if (!res.headersSent) {
            res.status(500).json({ error: 'Logout failed' });
        }
    }
});

//Google oAuth routes
router.get('/login/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/google/return', passport.authenticate('google', { failureRedirect: '/account/login', failureFlash: true }), (req, res) => {
    const user = req.user as AccountUser;
    
    // Log successful Google OAuth login
    appLogger.info('User logged in via Google OAuth', {
        eventType: 'Google OAuth Login',
        userId: user.id,
        username: user.username,
        userRole: user.role,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        timestamp: new Date().toISOString()
    });
    
    req.flash('alert-success', 'Thanks for setting up a ViPER account - you may need to contact an admin to get full access to the services on offer.');
    res.redirect('/account');
});

router.get('/reset-password',
    function (req: Request, res: Response) {
        res.render('user_account_get_reset_password');
    })

router.post('/reset-password', async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body;
    const plainToken = crypto.randomBytes(32).toString('hex'); // Generate random token
    const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex'); // Hash for storage
    const expiryTime = new Date(Date.now() + 3600000); // 1 hour from now
    

    // Log password reset request
    appLogger.info('Password reset requested', {
        eventType: 'Password Reset Request',
        email,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        timestamp: new Date().toISOString()
    });

    try {
        const user = await db.User.findOne({ where: { email } });
        if (!user) {
            appLogger.info(`No user found with email: ${email}`, { timestamp: new Date().toISOString() });
            
            // Log failed reset attempt (user not found)
            appLogger.warn('Password reset request for non-existent user', {
                eventType: 'Password Reset - User Not Found',
                email,
                ipAddress: req.ip,
                timestamp: new Date().toISOString()
            });
            
            // For security reasons, don't return information that leaks info about the service and users...
            res.render('user_account_post_reset_password');
            return;
        }

        appLogger.info(`User found: ${user.username} (ID: ${user.id})`, { timestamp: new Date().toISOString() });

        try {
            await user.update({
                resetPasswordToken: hashedToken, // Store hashed token
                resetPasswordExpires: expiryTime,
            });
            
            appLogger.info(`Reset token generated and stored for ${user.username}`, { timestamp: new Date().toISOString() });
            
            // Log successful token generation
            appLogger.info('Password reset token generated', {
                eventType: 'Password Reset Token Generated',
                userId: user.id,
                username: user.username,
                email,
                tokenExpiry: expiryTime.toISOString(),
                timestamp: new Date().toISOString()
            });
            
            try {
                await emailRelay.sendResetEmail(email, user.username, plainToken); // Send plain token via email
                appLogger.info(`Reset email sent to: ${email}`, { timestamp: new Date().toISOString() });
                
                // Log successful email sending
                appLogger.info('Password reset email sent', {
                    eventType: 'Password Reset Email Sent',
                    userId: user.id,
                    username: user.username,
                    email,
                    timestamp: new Date().toISOString()
                });
            } catch (emailError) {
                appLogger.error('Error sending reset email:', { error: (emailError as Error)?.message ?? String(emailError), timestamp: new Date().toISOString() });
                
                // Log email failure
                appLogger.error('Password reset email failed', {
                    eventType: 'Password Reset Email Error',
                    userId: user.id,
                    username: user.username,
                    email,
                    error: (emailError as Error).message,
                    timestamp: new Date().toISOString()
                });
                // Continue execution - token was stored successfully even if email failed
            }
            
            res.render('user_account_post_reset_password');
        } catch (err) {
            appLogger.error("Error updating user: ", { error: (err as Error)?.message ?? String(err), timestamp: new Date().toISOString() });
            
            // Log database error
            appLogger.error('Password reset token storage failed', {
                eventType: 'Password Reset Error',
                userId: user.id,
                username: user.username,
                email,
                error: (err as Error).message,
                timestamp: new Date().toISOString()
            });
            
            res.render('user_account_post_reset_password');
        }
    } catch (err) {
        appLogger.error("Error finding user: ", { error: (err as Error)?.message ?? String(err), timestamp: new Date().toISOString() });
        
        // Log database error
        appLogger.error('Password reset user lookup failed', {
            eventType: 'Password Reset Database Error',
            email,
            error: (err as Error).message,
            timestamp: new Date().toISOString()
        });
        
        res.render('user_account_post_reset_password');
    }
});

router.get('/reset-token/:token', (req: Request, res: Response) => {
    const plainToken = req.params.token;
    const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex'); // Hash the token for database lookup
    
    appLogger.info(`Token validation attempt: ${plainToken.substring(0, 8)}...`, { timestamp: new Date().toISOString() });
    
    interface ResetTokenResponse {
        message?: string;
    }

    db.User.findOne({ 
        where: { 
            resetPasswordToken: hashedToken, 
            resetPasswordExpires: { [Op.gt]: Date.now() } 
        } 
    }).then((user: any | null) => {
        if (!user) {
            appLogger.warn(`Invalid or expired token: ${plainToken.substring(0, 8)}...`, { timestamp: new Date().toISOString() });
            
            const response: ResetTokenResponse = { message: 'Password reset token is invalid or has expired.' };
            res.status(400).json(response);
            return;
        }
        
        appLogger.info(`Valid token for user: ${user.username}`, { timestamp: new Date().toISOString() });
        
        res.render('user_account_get_reset_token', {
            token: plainToken, // Pass plain token to form for submission
        });
    }).catch((err: Error) => {
        appLogger.error("Error validating token: ", { error: (err as Error)?.message ?? String(err), timestamp: new Date().toISOString() });
        const response: ResetTokenResponse = { message: 'Error finding user.' };
        res.status(500).json(response);
    });
});

router.post('/reset-token', async (req: Request, res: Response): Promise<void> => {
    const plainToken = req.body.token;
    const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex'); // Hash submitted token to compare
    
    appLogger.info(`Password reset submission for token: ${plainToken.substring(0, 8)}...`, { timestamp: new Date().toISOString() });
    
    interface ResetTokenResponse {
        message?: string;
    }

    try {
        const user = await db.User.findOne({ 
            where: { 
                resetPasswordToken: hashedToken, 
                resetPasswordExpires: { [Op.gt]: Date.now() } 
            } 
        });
        
        if (!user) {
            appLogger.warn(`Invalid token for password reset: ${plainToken.substring(0, 8)}...`, { timestamp: new Date().toISOString() });
            const response: ResetTokenResponse = { message: 'Password reset token is invalid or has expired.' };
            res.status(400).json(response);
            return;
        }

        appLogger.info(`Valid token, updating password for: ${user.username}`, { timestamp: new Date().toISOString() });

        try {
            await user.setPassword(req.body.password);
            user.resetPasswordToken = undefined; // Clear the reset token
            user.resetPasswordExpires = undefined; // Clear the expiration
            await user.save();

            appLogger.info(`Password updated successfully for: ${user.username}`, { timestamp: new Date().toISOString() });

            // Log the user in
            req.login(user, (err: Error) => {
                if (err) {
                    appLogger.error("Error logging in user after password reset: ", { error: (err as Error)?.message ?? String(err), timestamp: new Date().toISOString() });
                    const response: ResetTokenResponse = { message: 'Error logging in user.' };
                    res.status(500).json(response);
                    return;
                }
                appLogger.info(`User ${user.username} logged in after password reset`, { timestamp: new Date().toISOString() });
                res.redirect('/account');
            });
        } catch (err) {
            appLogger.error("Error setting new password: ", { error: (err as Error)?.message ?? String(err), timestamp: new Date().toISOString() });
            const response: ResetTokenResponse = { message: 'Error setting new password.' };
            res.status(500).json(response);
            return;
        }
    } catch (err) {
        appLogger.error("Error during password reset: ", { error: (err as Error)?.message ?? String(err), timestamp: new Date().toISOString() });
        const response: ResetTokenResponse = { message: 'Error finding user.' };
        res.status(500).json(response);
    }
});

router.get('/debug-tokens', async (req: Request, res: Response) => {
    // Debug endpoint to check tokens in database
    if (req.user && (req.user as AccountUser).role == UserRole.ADMIN) {
        try {
            const users = await db.User.findAll({
                attributes: ['id', 'username', 'email', 'resetPasswordToken', 'resetPasswordExpires']
            });
            
            // Filter for users with tokens
            const usersWithTokens = users.filter(user => user.resetPasswordToken);
            
            const now = new Date();
            const debugInfo = usersWithTokens.map(user => {
                const isExpired = user.resetPasswordExpires ? new Date(user.resetPasswordExpires) < now : true;
                const timeRemaining = user.resetPasswordExpires ? 
                    Math.round((new Date(user.resetPasswordExpires).getTime() - now.getTime()) / 1000 / 60) : 0;
                
                return {
                    username: user.username,
                    email: user.email,
                    tokenLength: user.resetPasswordToken ? user.resetPasswordToken.length : 0,
                    tokenPreview: user.resetPasswordToken ? user.resetPasswordToken.substring(0, 16) + '...' : 'null',
                    tokenType: user.resetPasswordToken && user.resetPasswordToken.length === 64 ? 'HASHED (SHA256)' : 'UNKNOWN',
                    expires: user.resetPasswordExpires,
                    isExpired: isExpired,
                    timeUntilExpiry: timeRemaining > 0 ? `${timeRemaining} minutes` : 'EXPIRED'
                };
            });
            
            
            res.json({
                currentTime: now,
                tokensFound: usersWithTokens.length,
                tokens: debugInfo,
                note: "SHA256 hashes should be 64 characters long"
            });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    } else {
        res.status(403).json({ message: 'Admin access required' });
    }
});

export default router;