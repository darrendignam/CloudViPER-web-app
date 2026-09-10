# User Role Enumeration Implementation

## Overview

This document describes the implementation of a comprehensive role enumeration system for the CloudViPER application, replacing the previous string-based role system with a TypeScript enum for better type safety and maintainability.

## Role Definitions

The following roles are now defined as an enumeration in `/web-app/src/types/UserRole.ts`:

### UserRole Enum Values

| Role | Database Value | Description | Permissions |
|------|----------------|-------------|-------------|
| `USER` | `'user'` | Basic user - no ViPER instance access | No access to ViPER instances |
| `TESTING` | `'testing'` | Can run one ViPER instance for testing | Single ViPER instance for testing |
| `MEMBER` | `'member'` | Can run one ViPER instance as a community member | Single ViPER instance as member |
| `SUBSCRIBER` | `'subscriber'` | Pays for use - extended access to ViPER instances | Extended ViPER instance access |
| `ADMIN` | `'admin'` | Full ViPER and user management access | Full system administration |
| `TEAM_LEADER` | `'team_leader'` | Team leader - can invite people to their team and manage team resources | Can invite users to their team, limited team management |
| `TEAM_ADMIN` | `'team_admin'` | Team administrator - full management of their team | Full management of their team, can invite users, assign roles |

## Implementation Details

### Database Compatibility

- **Storage**: Roles continue to be stored as strings in the database for backward compatibility
- **Validation**: Database model now includes enum validation to ensure only valid roles are accepted
- **Default Value**: New users default to `UserRole.USER` (`'user'`)
- **Migration**: Existing data remains compatible; invalid roles are automatically converted to `USER`

### TypeScript Integration

```typescript
// Import the enum and utilities
import { UserRole, isValidRole, toUserRole } from '../types/UserRole';

// Use in interfaces
interface User {
    role: UserRole;
}

// Validate roles
if (isValidRole(someString)) {
    // String is a valid role
}

// Convert with fallback
const safeRole = toUserRole(untrustedString); // Falls back to USER if invalid
```

### Key Features

1. **Type Safety**: TypeScript compilation prevents invalid role usage
2. **Runtime Validation**: Database validates role values at creation/update time
3. **Backward Compatibility**: Existing database data continues to work
4. **Fallback Handling**: Invalid roles automatically convert to `USER`
5. **Role Hierarchy**: Numerical hierarchy system for permission checking

## Files

### Core Type Definition
- `/web-app/src/types/UserRole.ts` - Main enum and utility functions

### Database Layer
- `/web-app/src/models/user.ts` - Updated to use enum types and validation

### Route Handlers
- `/web-app/src/routes/account.ts` - Updated all role checks to use enum
- `/web-app/src/routes/service.ts` - Updated all role checks to use enum

### Utilities
- `/web-app/src/utility/helperFunctions.ts` - Updated `updateRoleIfAdmin` to return enum

### Verification Scripts
- `/web-app/src/scripts/verify-roles.ts` - Verification and testing script
- `/web-app/src/scripts/migrate-user-roles.ts` - Migration script for data cleanup

## Role Hierarchy and Permissions

The system includes a numerical hierarchy for permission checking:

```typescript
const RoleHierarchy: Record<UserRole, number> = {
    [UserRole.USER]: 0,        // Lowest permissions
    [UserRole.TESTING]: 1,     // Can test ViPER
    [UserRole.MEMBER]: 1,      // Can use ViPER as member
    [UserRole.TEAM_LEADER]: 2, // Can invite/manage team members
    [UserRole.TEAM_ADMIN]: 3,  // Full team management
    [UserRole.SUBSCRIBER]: 2,  // Enhanced access
    [UserRole.ADMIN]: 4        // Full access
};
```

Use `hasRoleLevel(userRole, minimumRole)` to check if a user has sufficient permissions.

## Validation and Safety

### Database Validation
```sql
-- The database now validates that role values are valid enum strings
-- Invalid roles throw: "Invalid role: invalid_value. Must be one of: user, testing, member, subscriber, admin"
```

### TypeScript Validation
```typescript
// Compile-time checking prevents this:
user.role = 'invalid'; // ❌ TypeScript error

// Runtime checking handles this safely:
user.role = toUserRole('invalid'); // ✅ Falls back to 'user'
```

## Verification Results

The verification script confirms:
- ✅ All 8 role values are properly defined
- ✅ Validation functions work correctly
- ✅ Database connection and validation functional
- ✅ Current database contains only valid roles (12 'user' roles found)
- ✅ Invalid role attempts are properly rejected
- ✅ Application builds successfully

## Usage Examples

```typescript
// Creating users with roles
const newUser = await db.User.create({
    username: 'testuser',
    email: 'test@example.com',
    role: UserRole.TESTING,  // Type-safe
    oauthProvider: 'vipercloud'
});

// Checking permissions
if (user.role === UserRole.ADMIN) {
    // Allow admin actions
}

// Role-based redirects
switch (user.role) {
    case UserRole.ADMIN:
        res.redirect('/service/admin');
        break;
    case UserRole.TESTING:
        res.redirect('/service/testing');
        break;
    // ... etc
}

// Validating roles from user input
const requestedRole = req.body.role;
if (isValidRole(requestedRole)) {
    user.role = requestedRole as UserRole;
} else {
    throw new Error('Invalid role specified');
}

// New team roles usage
if (user.role === UserRole.TEAM_ADMIN) {
    // Allow team admin actions
}
if (user.role === UserRole.TEAM_LEADER) {
    // Allow team leader actions
}
```

