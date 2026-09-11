import { MailerSend, EmailParams, Recipient, Sender } from "mailersend";
import { appLogger } from '../config/logger';

// Where the app lives. Every link in every message points here, so it has to be
// the host the recipient can actually reach.
const DOMAIN_NAME = process.env.DOMAIN_NAME || 'cloudviper.org';

// Who the message comes from, which is a different question. A provider will
// only send as a domain that has been verified with it, and that verification
// is DNS work on the sending domain. An appliance on a new host can therefore
// need to send as an established domain while linking to its own, so the two
// are configured separately rather than both derived from DOMAIN_NAME.
const MAIL_FROM_DOMAIN = (process.env.MAIL_FROM_DOMAIN || DOMAIN_NAME).replace(/^www\./, '');
const MAIL_FROM_ADDRESS = process.env.MAIL_FROM_ADDRESS || `no-reply@${MAIL_FROM_DOMAIN}`;

/**
 * Interface defining the email relay service methods
 */
interface EmailRelay {
  /**
   * Sends a welcome email to a new user
   * @param email - User's email address
   * @param username - User's username
   */
  sendWelcomeEmail: (email: string, username: string) => Promise<void>;
  
  /**
   * Sends an invitation email to a user invited by another user
   * @param email - User's email address
   * @param username - User's username
   * @param invitee - Username of the person who sent the invitation
   */
  sendInvitedEmail: (email: string, username: string, invitee: string) => Promise<void>;
  
  /**
   * Sends a password reset email with a secure token
   * @param email - User's email address
   * @param username - User's username
   * @param token - Secure reset token
   */
  sendResetEmail: (email: string, username: string, token: string) => Promise<void>;
}

/**
 * Whether outgoing email can actually be sent.
 *
 * Worth checking before claiming an invitation was delivered: without a key
 * MailerSend rejects at send time, and an invited user whose mail never arrives
 * has no way in, because the invitation is what carries the password-reset
 * link.
 */
export function isEmailConfigured(): boolean {
    return Boolean(process.env.MAILERSEND_API_KEY);
}

const mailerSend = new MailerSend({
  apiKey: process.env.MAILERSEND_API_KEY || '',
});

const _footer =  '<h3>&nbsp;-&nbsp;CloudViPER team</h3><div style="font-size: 12px; color: grey; text-align: center; padding: 10px;">This is an unmanaged email account, and as a result cannot receive messages; do not reply to this message. If you need help and support, please reach out to <strong>sysadmin@openpreservation.org</strong></div>';

const emailRelay: EmailRelay = {
    sendWelcomeEmail: async (in_email: string, in_username: string): Promise<void> => {
        const sentFrom = new Sender(MAIL_FROM_ADDRESS, "CloudViPER");
        const recipients = [new Recipient(in_email, in_username)];

        const emailParams = new EmailParams()
            .setFrom(sentFrom)
            .setTo(recipients)
            .setSubject('Welcome to CloudViPER ' + in_username)
            .setText(`You are now part of the Viper community. Access CloudViPER via https://${DOMAIN_NAME}/`)
            .setHtml('<h2>You are now part of the Viper community</h2>' +
                `Access CloudViPER via <a href="https://${DOMAIN_NAME}">${DOMAIN_NAME}</a>.<br>\n\n` +
                'You may need to wait for a service admin to authorize your account to access the advanced features of the service.<br>\n\n' +
                'Find out more information about ViPER here <a href="https://viper.openpreservation.org">https://viper.openpreservation.org</a>.<br>\n\n' +
                _footer);

        try {
            await mailerSend.email.send(emailParams);
            appLogger.info('Email sent', { timestamp: new Date().toISOString() });
        } catch (error: any) {
            appLogger.error('Email send failed', { error: (error as Error)?.message ?? String(error), timestamp: new Date().toISOString() });
            throw error;
        }
    },
    sendInvitedEmail: async (in_email: string, in_username: string, in_invitee: string): Promise<void> => {
        const sentFrom = new Sender(MAIL_FROM_ADDRESS, "CloudViPER");
        const recipients = [new Recipient(in_email, in_username)];

        const emailParams = new EmailParams()
            .setFrom(sentFrom)
            .setTo(recipients)
            .setSubject('Welcome to CloudViPER ' + in_username)
            .setText('You have been invited to the CloudViPER community by ' + in_invitee +
                '. Your username is "' + in_username + '" and the email used to sign you up was "' +
                in_email + `". To begin using the service you will need to reset your password by visiting the following link, and following the instructions: https://${DOMAIN_NAME}/account/reset-password`)
            .setHtml('<h2>You have been invited to use CloudViPER!</h2>' +
                'You have been invited by ' + in_invitee +
                '. Your username is "' + in_username + '" and the email used to sign you up was "' +
                in_email + '". To begin using the service you will need to reset your password by visiting the following link, and following the instructions:' +
                `<h3>Reset CloudViPER password: <a href="https://${DOMAIN_NAME}/account/reset-password">https://${DOMAIN_NAME}/account/reset-password</a>.</h3><br>\n\n` +
                `Access CloudViPER via <a href="https://${DOMAIN_NAME}">${DOMAIN_NAME}</a>.<br>\n\n` +
                'You may need to wait for a service admin to authorize your account to access the advanced features of the service.<br>\n\n' +
                'Find out more information about ViPER here <a href="https://viper.openpreservation.org">https://viper.openpreservation.org</a>.<br>\n\n' +
                _footer);

        try {
            await mailerSend.email.send(emailParams);
            appLogger.info('Email sent', { timestamp: new Date().toISOString() });
        } catch (error: any) {
            appLogger.error('Email send failed', { error: (error as Error)?.message ?? String(error), timestamp: new Date().toISOString() });
            throw error;
        }
    },
    sendResetEmail: async (in_email: string, in_username: string, in_token: string): Promise<void> => {
        const sentFrom = new Sender(MAIL_FROM_ADDRESS, "CloudViPER");
        const recipients = [new Recipient(in_email, in_username)];

        const emailParams = new EmailParams()
            .setFrom(sentFrom)
            .setTo(recipients)
            .setSubject('CloudViPER - Password reset')
            .setText(`You are receiving this message because you have requested the reset of the password for your account.\n\n
          USERNAME: ${in_username}\n\n
          EMAIL: ${in_email}\n\n
          Please click on the following link, or paste this into your browser to complete the process:\n\n
          https://${DOMAIN_NAME}/account/reset-token/${in_token}\n\n
          If you did not request this, please ignore this email and your password will remain unchanged.\n`)
            .setHtml('<h2>A CloudViPER password reset was requested</h2>' +
                'You are receiving this message because you have requested the reset of the password for your account.<br>\n\n' +
                '<p>USERNAME: ' + in_username + '<br>\n\n' +
                'EMAIL: ' + in_email + '</p><br>\n\n' +
                'Please click on the following link, or paste this into your browser to complete the process:<br>\n\n' +
                `<p><a href="https://${DOMAIN_NAME}/account/reset-token/${in_token}">https://${DOMAIN_NAME}/account/reset-token/${in_token}</a></p><br>\n\n` +
                'Your email was requested to initiate this password reset, but please use the USERNAME to log into the service<br>\n\n' +
                'If you did not request this, please ignore this email and your password will remain unchanged.<br>\n\n' +
                _footer);

        try {
            await mailerSend.email.send(emailParams);
            appLogger.info('Email sent', { timestamp: new Date().toISOString() });
        } catch (error: any) {
            appLogger.error('Email send failed', { error: (error as Error)?.message ?? String(error), timestamp: new Date().toISOString() });
            throw error;
        }
    },
};

export type { EmailRelay };
export default emailRelay;