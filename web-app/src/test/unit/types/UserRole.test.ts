import { 
    UserRole, 
    RoleDescriptions, 
    RoleHierarchy, 
    hasRoleLevel, 
    getAllRoles, 
    isValidRole, 
    toUserRole 
} from '../../../types/UserRole';

/**
 * Unit tests for UserRole Types and Utilities
 * 
 * This test suite covers all UserRole functionality including:
 * - Enum values and definitions
 * - Role descriptions and hierarchy
 * - Permission checking utilities
 * - Role validation and conversion functions
 * - Edge cases and error handling
 */

describe('UserRole Types and Utilities', () => {
    
    describe('UserRole Enum', () => {
        it('should have correct enum values', () => {
            expect(UserRole.USER).toBe('user');
            expect(UserRole.TESTING).toBe('testing');
            expect(UserRole.MEMBER).toBe('member');
            expect(UserRole.SUBSCRIBER).toBe('subscriber');
            expect(UserRole.ADMIN).toBe('admin');
        });

        it('should have exactly 7 roles defined', () => {
            const roleCount = Object.keys(UserRole).length;
            expect(roleCount).toBe(7);
        });

        it('should have all roles as string values', () => {
            Object.values(UserRole).forEach(role => {
                expect(typeof role).toBe('string');
            });
        });
    });

    describe('RoleDescriptions', () => {
        it('should have descriptions for all roles', () => {
            Object.values(UserRole).forEach(role => {
                expect(RoleDescriptions[role]).toBeDefined();
                expect(typeof RoleDescriptions[role]).toBe('string');
                expect(RoleDescriptions[role].length).toBeGreaterThan(0);
            });
        });

        it('should have meaningful descriptions', () => {
            expect(RoleDescriptions[UserRole.USER]).toContain('Basic user');
            expect(RoleDescriptions[UserRole.TESTING]).toContain('testing');
            expect(RoleDescriptions[UserRole.MEMBER]).toContain('member');
            expect(RoleDescriptions[UserRole.SUBSCRIBER]).toContain('Pays for use');
            expect(RoleDescriptions[UserRole.ADMIN]).toContain('Full');
        });

        it('should not have duplicate descriptions', () => {
            const descriptions = Object.values(RoleDescriptions);
            const uniqueDescriptions = [...new Set(descriptions)];
            expect(descriptions.length).toBe(uniqueDescriptions.length);
        });
    });

    describe('RoleHierarchy', () => {
        it('should have hierarchy values for all roles', () => {
            Object.values(UserRole).forEach(role => {
                expect(RoleHierarchy[role]).toBeDefined();
                expect(typeof RoleHierarchy[role]).toBe('number');
                expect(RoleHierarchy[role]).toBeGreaterThanOrEqual(0);
            });
        });

        it('should have correct hierarchy ordering', () => {
            expect(RoleHierarchy[UserRole.USER]).toBe(0);
            expect(RoleHierarchy[UserRole.TESTING]).toBe(1);
            expect(RoleHierarchy[UserRole.MEMBER]).toBe(1);
            expect(RoleHierarchy[UserRole.SUBSCRIBER]).toBe(2);
            expect(RoleHierarchy[UserRole.ADMIN]).toBe(4);
        });

        it('should have ADMIN as highest hierarchy level', () => {
            const maxLevel = Math.max(...Object.values(RoleHierarchy));
            expect(RoleHierarchy[UserRole.ADMIN]).toBe(maxLevel);
        });

        it('should have USER as lowest hierarchy level', () => {
            const minLevel = Math.min(...Object.values(RoleHierarchy));
            expect(RoleHierarchy[UserRole.USER]).toBe(minLevel);
        });

        it('should have TESTING and MEMBER at same level', () => {
            expect(RoleHierarchy[UserRole.TESTING]).toBe(RoleHierarchy[UserRole.MEMBER]);
        });
    });

    describe('hasRoleLevel function', () => {
        describe('Admin role permissions', () => {
            it('should allow admin to access all role levels', () => {
                expect(hasRoleLevel(UserRole.ADMIN, UserRole.USER)).toBe(true);
                expect(hasRoleLevel(UserRole.ADMIN, UserRole.TESTING)).toBe(true);
                expect(hasRoleLevel(UserRole.ADMIN, UserRole.MEMBER)).toBe(true);
                expect(hasRoleLevel(UserRole.ADMIN, UserRole.SUBSCRIBER)).toBe(true);
                expect(hasRoleLevel(UserRole.ADMIN, UserRole.ADMIN)).toBe(true);
            });
        });

        describe('Subscriber role permissions', () => {
            it('should allow subscriber to access lower role levels', () => {
                expect(hasRoleLevel(UserRole.SUBSCRIBER, UserRole.USER)).toBe(true);
                expect(hasRoleLevel(UserRole.SUBSCRIBER, UserRole.TESTING)).toBe(true);
                expect(hasRoleLevel(UserRole.SUBSCRIBER, UserRole.MEMBER)).toBe(true);
                expect(hasRoleLevel(UserRole.SUBSCRIBER, UserRole.SUBSCRIBER)).toBe(true);
            });

            it('should not allow subscriber to access admin level', () => {
                expect(hasRoleLevel(UserRole.SUBSCRIBER, UserRole.ADMIN)).toBe(false);
            });
        });

        describe('Member role permissions', () => {
            it('should allow member to access equal and lower role levels', () => {
                expect(hasRoleLevel(UserRole.MEMBER, UserRole.USER)).toBe(true);
                expect(hasRoleLevel(UserRole.MEMBER, UserRole.TESTING)).toBe(true);
                expect(hasRoleLevel(UserRole.MEMBER, UserRole.MEMBER)).toBe(true);
            });

            it('should not allow member to access higher role levels', () => {
                expect(hasRoleLevel(UserRole.MEMBER, UserRole.SUBSCRIBER)).toBe(false);
                expect(hasRoleLevel(UserRole.MEMBER, UserRole.ADMIN)).toBe(false);
            });
        });

        describe('Testing role permissions', () => {
            it('should allow testing to access equal and lower role levels', () => {
                expect(hasRoleLevel(UserRole.TESTING, UserRole.USER)).toBe(true);
                expect(hasRoleLevel(UserRole.TESTING, UserRole.TESTING)).toBe(true);
                expect(hasRoleLevel(UserRole.TESTING, UserRole.MEMBER)).toBe(true);
            });

            it('should not allow testing to access higher role levels', () => {
                expect(hasRoleLevel(UserRole.TESTING, UserRole.SUBSCRIBER)).toBe(false);
                expect(hasRoleLevel(UserRole.TESTING, UserRole.ADMIN)).toBe(false);
            });
        });

        describe('User role permissions', () => {
            it('should only allow user to access user level', () => {
                expect(hasRoleLevel(UserRole.USER, UserRole.USER)).toBe(true);
            });

            it('should not allow user to access any higher role levels', () => {
                expect(hasRoleLevel(UserRole.USER, UserRole.TESTING)).toBe(false);
                expect(hasRoleLevel(UserRole.USER, UserRole.MEMBER)).toBe(false);
                expect(hasRoleLevel(UserRole.USER, UserRole.SUBSCRIBER)).toBe(false);
                expect(hasRoleLevel(UserRole.USER, UserRole.ADMIN)).toBe(false);
            });
        });

        describe('Edge cases', () => {
            it('should handle same role comparisons correctly', () => {
                Object.values(UserRole).forEach(role => {
                    expect(hasRoleLevel(role, role)).toBe(true);
                });
            });
        });
    });

    describe('getAllRoles function', () => {
        it('should return an array of all UserRole values', () => {
            const allRoles = getAllRoles();
            expect(Array.isArray(allRoles)).toBe(true);
            expect(allRoles).toHaveLength(7);
        });

        it('should contain all UserRole enum values', () => {
            const allRoles = getAllRoles();
            expect(allRoles).toContain(UserRole.USER);
            expect(allRoles).toContain(UserRole.TESTING);
            expect(allRoles).toContain(UserRole.MEMBER);
            expect(allRoles).toContain(UserRole.SUBSCRIBER);
            expect(allRoles).toContain(UserRole.ADMIN);
        });

        it('should not contain duplicate values', () => {
            const allRoles = getAllRoles();
            const uniqueRoles = [...new Set(allRoles)];
            expect(allRoles.length).toBe(uniqueRoles.length);
        });

        it('should return roles in the same order as enum definition', () => {
            const allRoles = getAllRoles();
            const expectedOrder = Object.values(UserRole);
            expect(allRoles).toEqual(expectedOrder);
        });
    });

    describe('isValidRole function', () => {
        describe('Valid roles', () => {
            it('should return true for all valid UserRole values', () => {
                expect(isValidRole('user')).toBe(true);
                expect(isValidRole('testing')).toBe(true);
                expect(isValidRole('member')).toBe(true);
                expect(isValidRole('subscriber')).toBe(true);
                expect(isValidRole('admin')).toBe(true);
            });

            it('should return true for UserRole enum values', () => {
                Object.values(UserRole).forEach(role => {
                    expect(isValidRole(role)).toBe(true);
                });
            });
        });

        describe('Invalid roles', () => {
            it('should return false for invalid string values', () => {
                expect(isValidRole('invalid')).toBe(false);
                expect(isValidRole('superuser')).toBe(false);
                expect(isValidRole('guest')).toBe(false);
                expect(isValidRole('moderator')).toBe(false);
                expect(isValidRole('')).toBe(false);
            });

            it('should return false for case-sensitive variations', () => {
                expect(isValidRole('USER')).toBe(false);
                expect(isValidRole('Admin')).toBe(false);
                expect(isValidRole('TESTING')).toBe(false);
                expect(isValidRole('Member')).toBe(false);
            });

            it('should return false for non-string values', () => {
                expect(isValidRole(null as any)).toBe(false);
                expect(isValidRole(undefined as any)).toBe(false);
                expect(isValidRole(123 as any)).toBe(false);
                expect(isValidRole({} as any)).toBe(false);
                expect(isValidRole([] as any)).toBe(false);
                expect(isValidRole(true as any)).toBe(false);
            });

            it('should return false for strings with whitespace', () => {
                expect(isValidRole(' user')).toBe(false);
                expect(isValidRole('user ')).toBe(false);
                expect(isValidRole(' user ')).toBe(false);
                expect(isValidRole('\tuser')).toBe(false);
                expect(isValidRole('user\n')).toBe(false);
            });
        });
    });

    describe('toUserRole function', () => {
        describe('Valid conversions', () => {
            it('should convert valid string roles to UserRole enum', () => {
                expect(toUserRole('user')).toBe(UserRole.USER);
                expect(toUserRole('testing')).toBe(UserRole.TESTING);
                expect(toUserRole('member')).toBe(UserRole.MEMBER);
                expect(toUserRole('subscriber')).toBe(UserRole.SUBSCRIBER);
                expect(toUserRole('admin')).toBe(UserRole.ADMIN);
            });

            it('should return same value for UserRole enum input', () => {
                Object.values(UserRole).forEach(role => {
                    expect(toUserRole(role)).toBe(role);
                });
            });
        });

        describe('Invalid conversions with fallback', () => {
            it('should fallback to USER role for invalid string values', () => {
                expect(toUserRole('invalid')).toBe(UserRole.USER);
                expect(toUserRole('superuser')).toBe(UserRole.USER);
                expect(toUserRole('guest')).toBe(UserRole.USER);
                expect(toUserRole('')).toBe(UserRole.USER);
            });

            it('should fallback to USER role for case-sensitive variations', () => {
                expect(toUserRole('USER')).toBe(UserRole.USER);
                expect(toUserRole('Admin')).toBe(UserRole.USER);
                expect(toUserRole('TESTING')).toBe(UserRole.USER);
                expect(toUserRole('Member')).toBe(UserRole.USER);
            });

            it('should fallback to USER role for null and undefined', () => {
                expect(toUserRole(null)).toBe(UserRole.USER);
                expect(toUserRole(undefined)).toBe(UserRole.USER);
            });

            it('should fallback to USER role for non-string values', () => {
                expect(toUserRole(123 as any)).toBe(UserRole.USER);
                expect(toUserRole({} as any)).toBe(UserRole.USER);
                expect(toUserRole([] as any)).toBe(UserRole.USER);
                expect(toUserRole(true as any)).toBe(UserRole.USER);
            });

            it('should fallback to USER role for strings with whitespace', () => {
                expect(toUserRole(' user')).toBe(UserRole.USER);
                expect(toUserRole('user ')).toBe(UserRole.USER);
                expect(toUserRole(' user ')).toBe(UserRole.USER);
                expect(toUserRole('\tuser')).toBe(UserRole.USER);
                expect(toUserRole('user\n')).toBe(UserRole.USER);
            });
        });
    });

    describe('Integration tests', () => {
        it('should work together for role validation and conversion', () => {
            const testRoles = ['user', 'admin', 'invalid', null, undefined];
            
            testRoles.forEach(role => {
                const convertedRole = toUserRole(role as string);
                expect(isValidRole(convertedRole)).toBe(true);
                expect(Object.values(UserRole)).toContain(convertedRole);
            });
        });

        it('should maintain consistency between functions', () => {
            // All roles from getAllRoles should be valid
            getAllRoles().forEach(role => {
                expect(isValidRole(role)).toBe(true);
                expect(toUserRole(role)).toBe(role);
            });
        });

        it('should handle permission chains correctly', () => {
            // Admin should have access to everything
            getAllRoles().forEach(requiredRole => {
                expect(hasRoleLevel(UserRole.ADMIN, requiredRole)).toBe(true);
            });

            // User should only have access to user level
            getAllRoles().forEach(requiredRole => {
                if (requiredRole === UserRole.USER) {
                    expect(hasRoleLevel(UserRole.USER, requiredRole)).toBe(true);
                } else {
                    expect(hasRoleLevel(UserRole.USER, requiredRole)).toBe(false);
                }
            });
        });
    });

    describe('Performance and edge cases', () => {
        it('should handle large number of role checks efficiently', () => {
            const startTime = performance.now();
            
            // Perform 1000 role checks
            for (let i = 0; i < 1000; i++) {
                hasRoleLevel(UserRole.ADMIN, UserRole.USER);
                hasRoleLevel(UserRole.USER, UserRole.ADMIN);
                isValidRole('user');
                isValidRole('invalid');
                toUserRole('admin');
                toUserRole('invalid');
            }
            
            const endTime = performance.now();
            const duration = endTime - startTime;
            
            // Should complete within 100ms (very generous threshold)
            expect(duration).toBeLessThan(100);
        });

        it('should be memory efficient with repeated calls', () => {
            // Test that functions don't leak memory with repeated calls
            const initialMemory = process.memoryUsage().heapUsed;
            
            for (let i = 0; i < 10000; i++) {
                getAllRoles();
                isValidRole(`test${i}`);
                toUserRole(`test${i}`);
            }
            
            const finalMemory = process.memoryUsage().heapUsed;
            const memoryIncrease = finalMemory - initialMemory;
            
            // Memory increase should be minimal (less than 10MB)
            expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);
        });
    });

    describe('Type safety', () => {
        it('should provide proper TypeScript type narrowing', () => {
            const unknownRole: string = 'user';
            
            if (isValidRole(unknownRole)) {
                // TypeScript should narrow the type to UserRole
                expect(typeof unknownRole).toBe('string');
                expect(Object.values(UserRole)).toContain(unknownRole);
            }
        });

        it('should maintain type consistency in return values', () => {
            const allRoles = getAllRoles();
            allRoles.forEach(role => {
                expect(typeof role).toBe('string');
                expect(isValidRole(role)).toBe(true);
            });
        });
    });
});
