/**
 * User Role Enumeration
 * 
 * Defines the available user roles in the CloudViPER system
 */

export enum UserRole {
    USER = 'user',           // Basic user - no ViPER instance access
    TESTING = 'testing',     // Can run one ViPER instance for testing
    MEMBER = 'member',       // Can run one ViPER instance as a member
    TEAM_LEADER = 'team_leader', // Can invite people to their team, limited team management
    TEAM_ADMIN = 'team_admin',   // Can manage all aspects of their team
    SUBSCRIBER = 'subscriber', // Pays for use - extended access
    ADMIN = 'admin'          // Full ViPER and user management access
}

/**
 * Role descriptions for documentation and UI display
 */
export const RoleDescriptions: Record<UserRole, string> = {
    [UserRole.USER]: 'Basic user - no ViPER instance access',
    [UserRole.TESTING]: 'Can run one ViPER instance for testing purposes',
    [UserRole.MEMBER]: 'Can run one ViPER instance as a community member',
    [UserRole.TEAM_LEADER]: 'Team leader - can invite people to their team and manage team resources',
    [UserRole.TEAM_ADMIN]: 'Team administrator - full management of their team',
    [UserRole.SUBSCRIBER]: 'Pays for use - extended access to ViPER instances',
    [UserRole.ADMIN]: 'Full ViPER and user management access across the entire system'
};

/**
 * Role hierarchy for permission checking
 * Higher numbers indicate more permissions
 */
export const RoleHierarchy: Record<UserRole, number> = {
    [UserRole.USER]: 0,
    [UserRole.TESTING]: 1,
    [UserRole.MEMBER]: 1,
    [UserRole.TEAM_LEADER]: 2,
    [UserRole.TEAM_ADMIN]: 3,
    [UserRole.SUBSCRIBER]: 2,
    [UserRole.ADMIN]: 4
};

/**
 * Check if a user role has at least the specified minimum role level
 */
export function hasRoleLevel(userRole: UserRole, minimumRole: UserRole): boolean {
    return RoleHierarchy[userRole] >= RoleHierarchy[minimumRole];
}

/**
 * Get all available roles as an array
 */
export function getAllRoles(): UserRole[] {
    return Object.values(UserRole);
}

/**
 * Check if a string is a valid user role
 */
export function isValidRole(role: string): role is UserRole {
    return Object.values(UserRole).includes(role as UserRole);
}

/**
 * Convert a string to UserRole enum, with fallback to USER if invalid
 */
export function toUserRole(role: string | undefined | null): UserRole {
    if (!role || !isValidRole(role)) {
        return UserRole.USER;
    }
    return role as UserRole;
}
