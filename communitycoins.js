const { Client } = require('discord.js');
const { MongoClient } = require('mongodb');
require('dotenv').config();

// Hardcoded collection and role mapping
// Format: [collection name, role ID]
const COMMUNITY_MAPPINGS = [
  ['test1', '1351429786941128745'], 
  ['test2', '1351429981917544458']
];

// MongoDB connection and collections
let db;
let verifiedWalletsCollection;
let communityCollections = [];

// Cooldown tracking
const userCooldowns = new Map();
const COOLDOWN_TIME = 5 * 60 * 1000; // 5 minutes in milliseconds

// Initialize MongoDB connection for community coins
async function initializeCommunityCoins(mongoClient, discordClient) {
  try {
    // Ensure MongoDB is connected
    if (!mongoClient.topology || !mongoClient.topology.isConnected()) {
      console.error('MongoDB is not connected. Community coins module not initialized.');
      return false;
    }
    
    console.log('Initializing community coins module...');
    
    // Get the database
    db = mongoClient.db('wallet_verification');
    
    // Get the verified wallets collection
    verifiedWalletsCollection = db.collection('verified_wallets');
    
    // Initialize community collections
    if (COMMUNITY_MAPPINGS.length === 0) {
      console.warn('No community mappings defined. Community coins module will not assign any roles.');
    }
    
    // Set up collections
    for (const [collectionName, roleId] of COMMUNITY_MAPPINGS) {
      try {
        const collection = db.collection(collectionName);
        
        // Create index if it doesn't exist
        try {
          await collection.createIndex({ address: 1 });
          console.log(`Created index on ${collectionName} collection`);
        } catch (err) {
          if (err.code === 86) {
            console.log(`Index already exists on ${collectionName} collection`);
          } else {
            console.error(`Error creating index on ${collectionName}:`, err);
          }
        }
        
        // Store collection with its role ID for later use
        communityCollections.push({ 
          collection: collection, 
          name: collectionName, 
          roleId: roleId 
        });
        
        console.log(`Initialized ${collectionName} collection with role ID ${roleId}`);
      } catch (error) {
        console.error(`Error initializing ${collectionName} collection:`, error);
      }
    }
    
    // Set up interval for community coin role checks
    const roleCheckInterval = 5 * 60 * 1000; // 5 minutes
    console.log(`Setting up community coin role check interval every ${roleCheckInterval/1000/60} minutes`);
    
    setInterval(async () => {
      console.log('Running scheduled community coin role check...');
      await assignCommunityRoles(discordClient);
    }, roleCheckInterval);
    
    console.log('Community coins module initialized successfully');
    return true;
  } catch (error) {
    console.error('Error initializing community coins module:', error);
    return false;
  }
}

// Assign roles to users based on their presence in community collections
async function assignCommunityRoles(discordClient) {
  try {
    const guild = discordClient.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) {
      console.error('Guild not found, check your GUILD_ID');
      return 0;
    }
    
    let totalRolesAssigned = 0;
    
    // For each collection-role mapping
    for (const { collection, name, roleId } of communityCollections) {
      console.log(`Processing ${name} collection with role ID ${roleId}`);
      
      // Get all addresses in this collection
      const communityAddresses = await collection.find({}).toArray();
      console.log(`Found ${communityAddresses.length} addresses in ${name}`);
      
      if (communityAddresses.length === 0) {
        continue;
      }
      
      // Extract just the addresses
      const addressList = communityAddresses.map(item => item.address.toLowerCase());
      
      // Find verified wallets that match these addresses
      let verifiedWallets = [];
      
      // Process in smaller batches to avoid massive queries
      const batchSize = 100;
      for (let j = 0; j < addressList.length; j += batchSize) {
        const batch = addressList.slice(j, j + batchSize);
        
        const batchWallets = await verifiedWalletsCollection.find({
          walletAddress: { 
            $in: batch.map(addr => new RegExp(`^${addr}$`, 'i')) 
          }
        }).toArray();
        
        verifiedWallets = verifiedWallets.concat(batchWallets);
      }
      
      console.log(`Found ${verifiedWallets.length} verified wallets for ${name}`);
      
      // Assign roles to these users
      let rolesAssigned = 0;
      for (const wallet of verifiedWallets) {
        try {
          const member = await guild.members.fetch(wallet.userId);
          if (member && !member.roles.cache.has(roleId)) {
            await member.roles.add(roleId);
            rolesAssigned++;
            console.log(`Assigned ${name} role to ${wallet.username || wallet.userId}`);
          }
        } catch (error) {
          if (error.code === 10007) {
            console.warn(`User ${wallet.userId} is no longer in the server`);
          } else {
            console.error(`Failed to assign role to user ${wallet.userId}:`, error.message);
          }
        }
      }
      
      console.log(`Assigned ${rolesAssigned} ${name} roles`);
      totalRolesAssigned += rolesAssigned;
    }
    
    console.log(`Community coin role assignment completed. Total roles assigned: ${totalRolesAssigned}`);
    return totalRolesAssigned;
  } catch (error) {
    console.error('Error assigning community roles:', error);
    return 0;
  }
}

// Function to check if user is on cooldown
function isUserOnCooldown(userId) {
  const key = `${userId}-communityroles`;
  const cooldownExpiration = userCooldowns.get(key);
  
  if (cooldownExpiration && cooldownExpiration > Date.now()) {
    return true;
  }
  
  return false;
}

// Function to set cooldown for user
function setUserCooldown(userId) {
  const key = `${userId}-communityroles`;
  const expiration = Date.now() + COOLDOWN_TIME;
  userCooldowns.set(key, expiration);
  
  // Cleanup: remove cooldown after it expires
  setTimeout(() => {
    userCooldowns.delete(key);
  }, COOLDOWN_TIME);
}

// Function to get remaining cooldown time in minutes and seconds
function getRemainingCooldown(userId) {
  const key = `${userId}-communityroles`;
  const cooldownExpiration = userCooldowns.get(key);
  
  if (!cooldownExpiration) return null;
  
  const remainingMs = cooldownExpiration - Date.now();
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  
  return { minutes, seconds };
}

// Command handler for manually updating community roles
async function handleCommunityRoleCommands(message, command) {
  if (command === '!updatecommunityroles') {
    // Check if user is on cooldown
    if (isUserOnCooldown(message.author.id)) {
      const cooldown = getRemainingCooldown(message.author.id);
      return message.reply(`This command is on cooldown. Please try again in ${cooldown.minutes} minutes and ${cooldown.seconds} seconds.`);
    }
    
    await message.reply('Starting community role updates. This may take a moment...');
    
    // Set cooldown for this user
    setUserCooldown(message.author.id);
    
    const rolesAssigned = await assignCommunityRoles(message.client);
    
    await message.reply(`Community role update completed! Assigned ${rolesAssigned} roles.`);
    return true;
  }
  
  return false;
}

module.exports = {
  initializeCommunityCoins,
  assignCommunityRoles,
  handleCommunityRoleCommands
};