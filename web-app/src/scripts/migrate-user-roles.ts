/**
 * Database migration to ensure role data integrity
 * This script checks and fixes any invalid role values in the database
 */

import { isValidRole, toUserRole } from '../types/UserRole';
import db from '../models';

async function migrateUserRoles() {
    console.log('🔄 Starting User Role Migration\n');
    
    try {
        await db.sequelize.authenticate();
        console.log('💾 Database connected successfully');
        
        // Find all users with potentially invalid roles
        const allUsers = await db.User.findAll({
            attributes: ['id', 'username', 'email', 'role']
        });
        
        console.log(`📊 Found ${allUsers.length} users to check\n`);
        
        let fixedCount = 0;
        let validCount = 0;
        
        for (const user of allUsers) {
            const currentRole = user.role;
            const isValid = isValidRole(currentRole);
            
            if (isValid) {
                validCount++;
                console.log(`✅ ${user.username} (${user.email}): Role "${currentRole}" is valid`);
            } else {
                // Convert invalid role to valid one (defaults to 'user')
                const newRole = toUserRole(currentRole);
                
                console.log(`🔧 ${user.username} (${user.email}): Invalid role "${currentRole}" → "${newRole}"`);
                
                // Update the user's role
                await user.update({ role: newRole });
                fixedCount++;
            }
        }
        
        console.log('\n📈 Migration Summary:');
        console.log(`  ✅ Valid roles: ${validCount}`);
        console.log(`  🔧 Fixed roles: ${fixedCount}`);
        console.log(`  📊 Total users: ${allUsers.length}`);
        
        if (fixedCount > 0) {
            console.log('\n⚠️  Role changes have been applied to the database');
            console.log('   Please verify that the updated roles are correct for each user');
        } else {
            console.log('\n🎉 All user roles are already valid!');
        }
        
        // Show final role distribution
        const roleDistribution = await db.User.findAll({
            attributes: ['role', [db.sequelize.fn('COUNT', db.sequelize.col('role')), 'count']],
            group: ['role'],
            raw: true
        });
        
        console.log('\n📊 Final Role Distribution:');
        roleDistribution.forEach((item: any) => {
            console.log(`  ${item.role}: ${item.count} users`);
        });
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    }
}

// Run migration if this script is executed directly
if (require.main === module) {
    migrateUserRoles().then(() => {
        console.log('\n✨ Migration completed successfully!');
        process.exit(0);
    }).catch((error) => {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    });
}

export default migrateUserRoles;
