const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const { MongoClient } = require('mongodb');
const express = require('express');
const axios = require('axios');
require('dotenv').config();
// const communityCoins = require('./communitycoins.js');

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// MongoDB setup
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db;
let leaderboardCollection;
let verifiedWalletsCollection;
let whaleAddressesCollection;

// Discord configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const WHALE_ROLE_ID = process.env.WHALE_ROLE_ID;

// API endpoint
const API_ENDPOINT = 'https://testnet-api-server.nad.fun/reward/top';

// Cooldown tracking
const userCooldowns = new Map();
const COOLDOWN_TIME = 5 * 60 * 1000; // 5 minutes in milliseconds

// Initialize MongoDB connection
async function connectToDatabase() {
  try {
    await mongoClient.connect();
    console.log('Connected to MongoDB');
    
    db = mongoClient.db('wallet_verification');
    
    // Initialize collections - this will create them if they don't exist
    leaderboardCollection = db.collection('leaderboard');
    verifiedWalletsCollection = db.collection('verified_wallets');
    whaleAddressesCollection = db.collection('whale_addresses');
    
    // Insert a dummy document to ensure collections exist (we'll delete it right after)
    try {
      await leaderboardCollection.insertOne({ temp: true });
      await leaderboardCollection.deleteOne({ temp: true });
      await whaleAddressesCollection.insertOne({ temp: true });
      await whaleAddressesCollection.deleteOne({ temp: true });
    } catch (err) {
      // Ignore errors here
    }
    
    // Now try to create indexes
    try {
      await verifiedWalletsCollection.createIndex({ walletAddress: 1 });
      console.log('Created index on verified_wallets collection');
    } catch (err) {
      if (err.code === 86) {
        console.log('Index already exists on verified_wallets collection');
      } else {
        console.error('Error creating index on verified_wallets:', err);
      }
    }
    
    try {
      await leaderboardCollection.createIndex({ address: 1 });
      console.log('Created index on leaderboard collection');
    } catch (err) {
      if (err.code === 86) {
        console.log('Index already exists on leaderboard collection');
      } else {
        console.error('Error creating index on leaderboard:', err);
      }
    }

    try {
      await whaleAddressesCollection.createIndex({ walletAddress: 1 });
      await whaleAddressesCollection.createIndex({ userId: 1 });
      console.log('Created indexes on whale_addresses collection');
    } catch (err) {
      if (err.code === 86) {
        console.log('Indexes already exist on whale_addresses collection');
      } else {
        console.error('Error creating indexes on whale_addresses:', err);
      }
    }
    
    console.log('Database collections initialized');
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    // Continue running even if there's an error
  }
}

// Function to fetch top wallets from API
async function fetchTopWallets() {
  try {
    const response = await axios.get(`${API_ENDPOINT}?page=1&limit=30`);
    if (response.data && response.data.points) {
      return response.data.points.map(item => ({
        address: item.account_info.account_id.toLowerCase(),
        nickname: item.account_info.nickname,
        point: item.point
      }));
    }
    return [];
  } catch (error) {
    console.error('Error fetching top wallets:', error);
    return [];
  }
}

// Function to get all verified wallets that match the leaderboard
async function getVerifiedLeaderboardWallets() {
  try {
    // Get all addresses from the leaderboard
    const leaderboardAddresses = await leaderboardCollection.find({}).toArray();
    const addressList = leaderboardAddresses.map(item => item.address.toLowerCase());
    
    // If there are no addresses in the leaderboard, return empty array
    if (addressList.length === 0) {
      return [];
    }
    
    // Get all verified wallets that match the leaderboard addresses
    const verifiedWallets = await verifiedWalletsCollection.find({
      walletAddress: { 
        $in: addressList.map(addr => new RegExp(`^${addr}$`, 'i')) 
      }
    }).toArray();
    
    return verifiedWallets;
  } catch (error) {
    console.error('Error getting verified leaderboard wallets:', error);
    return [];
  }
}

// Function to add whale address to whale_addresses collection
async function addWhaleAddress(walletAddress, username, userId, leaderboardInfo) {
  try {
    const whaleData = {
      walletAddress: walletAddress.toLowerCase(),
      username: username,
      userId: userId,
      nickname: leaderboardInfo.nickname || '',
      points: leaderboardInfo.point || 0,
      addedAt: new Date(),
      lastUpdated: new Date()
    };

    // Use upsert to either insert new record or update existing one
    await whaleAddressesCollection.updateOne(
      { userId: userId },
      { $set: whaleData },
      { upsert: true }
    );

    console.log(`Added/Updated whale address for ${username}: ${walletAddress}`);
  } catch (error) {
    console.error('Error adding whale address:', error);
  }
}

// Function to remove whale address from whale_addresses collection
async function removeWhaleAddress(userId) {
  try {
    const result = await whaleAddressesCollection.deleteOne({ userId: userId });
    if (result.deletedCount > 0) {
      console.log(`Removed whale address for user ID: ${userId}`);
    }
  } catch (error) {
    console.error('Error removing whale address:', error);
  }
}

// Function to get leaderboard info for a wallet address
async function getLeaderboardInfo(walletAddress) {
  try {
    const leaderboardEntry = await leaderboardCollection.findOne({
      address: { $regex: new RegExp(`^${walletAddress}$`, 'i') }
    });
    return leaderboardEntry;
  } catch (error) {
    console.error('Error getting leaderboard info:', error);
    return null;
  }
}

// Function to remove whale roles from users who were in the leaderboard
async function removeLeaderboardRoles() {
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
      console.error('Guild not found, check your GUILD_ID');
      return 0;
    }
    
    console.log('Getting verified wallets from leaderboard...');
    const verifiedLeaderboardWallets = await getVerifiedLeaderboardWallets();
    
    if (verifiedLeaderboardWallets.length === 0) {
      console.log('No verified wallets found in the leaderboard');
      return 0;
    }
    
    console.log(`Found ${verifiedLeaderboardWallets.length} verified wallets in the leaderboard`);
    
    // Get the Discord user IDs for these wallets
    const userIds = verifiedLeaderboardWallets.map(wallet => wallet.userId);
    
    // Remove roles from these users and remove from whale_addresses collection
    let removedCount = 0;
    for (const userId of userIds) {
      try {
        const member = await guild.members.fetch(userId);
        if (member && member.roles.cache.has(WHALE_ROLE_ID)) {
          await member.roles.remove(WHALE_ROLE_ID);
          // Remove from whale_addresses collection
          await removeWhaleAddress(userId);
          removedCount++;
          console.log(`Removed whale role from ${member.user.tag} and removed from whale_addresses`);
        }
      } catch (error) {
        console.error(`Failed to remove role from user ${userId}:`, error.message);
      }
    }
    
    console.log(`Successfully removed whale role from ${removedCount} leaderboard members`);
    return removedCount;
  } catch (error) {
    console.error('Error removing leaderboard roles:', error);
    return 0;
  }
}

// Function to fully reset and update the leaderboard
async function updateLeaderboard() {
  try {
    console.log('Starting leaderboard update...');
    
    // Step 1: Remove whale roles from users who were in the leaderboard
    const removedRoles = await removeLeaderboardRoles();
    console.log(`Removed whale role from ${removedRoles} leaderboard users`);
    
    // Step 2: Delete the entire leaderboard collection
    try {
      await leaderboardCollection.drop();
      console.log('Dropped leaderboard collection');
    } catch (error) {
      if (error.codeName === 'NamespaceNotFound') {
        console.log('Leaderboard collection does not exist yet');
      } else {
        console.error('Error dropping leaderboard collection:', error);
      }
    }
    
    // Step 3: Recreate the leaderboard collection
    leaderboardCollection = db.collection('leaderboard');
    await leaderboardCollection.createIndex({ address: 1 });
    console.log('Recreated leaderboard collection');
    
    // Step 4: Fetch top wallets from API
    const topWallets = await fetchTopWallets();
    if (topWallets.length === 0) {
      console.warn('No wallets fetched from API');
      return false;
    }
    console.log(`Fetched ${topWallets.length} wallets from API`);
    
    // Step 5: Store in database
    await leaderboardCollection.insertMany(topWallets);
    console.log(`Updated leaderboard with ${topWallets.length} wallets`);
    
    // Step 6: Assign roles to eligible users
    await assignRolesToEligibleUsers();
    
    console.log('Leaderboard update completed successfully');
    return true;
  } catch (error) {
    console.error('Error during leaderboard update:', error);
    return false;
  }
}

// Function to assign roles to eligible users
async function assignRolesToEligibleUsers() {
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
      console.error('Guild not found, check your GUILD_ID');
      return 0;
    }
    
    // Get all addresses from the leaderboard
    const topWallets = await leaderboardCollection.find({}).toArray();
    console.log(`Processing ${topWallets.length} wallets from leaderboard`);
    
    let rolesAssigned = 0;
    
    // Find matching verified wallets
    for (const wallet of topWallets) {
      // Case insensitive search for wallet address
      try {
        const verifiedWallet = await verifiedWalletsCollection.findOne({
          walletAddress: { $regex: new RegExp(`^${wallet.address}$`, 'i') }
        });
        
        if (verifiedWallet) {
          console.log(`Found verified wallet for ${wallet.address} - User: ${verifiedWallet.username}`);
          
          // Fetch the member and assign role
          try {
            const member = await guild.members.fetch(verifiedWallet.userId);
            
            if (member) {
              // Only assign role if they don't already have it
              if (!member.roles.cache.has(WHALE_ROLE_ID)) {
                await member.roles.add(WHALE_ROLE_ID);
                console.log(`Assigned whale role to ${verifiedWallet.username}`);
                rolesAssigned++;
                
                // Add to whale_addresses collection
                await addWhaleAddress(
                  wallet.address,
                  verifiedWallet.username,
                  verifiedWallet.userId,
                  wallet
                );
              } else {
                console.log(`${verifiedWallet.username} already has whale role, skipping role assignment`);
                
                // Still update/add to whale_addresses collection to ensure data is current
                await addWhaleAddress(
                  wallet.address,
                  verifiedWallet.username,
                  verifiedWallet.userId,
                  wallet
                );
              }
            }
          } catch (memberError) {
            console.error(`Error fetching member ${verifiedWallet.username}:`, memberError.message);
          }
        }
      } catch (walletError) {
        console.error(`Error processing wallet ${wallet.address}:`, walletError.message);
      }
    }
    
    console.log(`Finished assigning whale roles. New roles assigned: ${rolesAssigned}`);
    return rolesAssigned;
  } catch (error) {
    console.error('Error assigning whale roles:', error);
    return 0;
  }
}

// Function to check if user is on cooldown
function isUserOnCooldown(userId, commandType) {
  const key = `${userId}-${commandType}`;
  const cooldownExpiration = userCooldowns.get(key);
  
  if (cooldownExpiration && cooldownExpiration > Date.now()) {
    return true;
  }
  
  return false;
}

// Function to set cooldown for user
function setUserCooldown(userId, commandType) {
  const key = `${userId}-${commandType}`;
  const expiration = Date.now() + COOLDOWN_TIME;
  userCooldowns.set(key, expiration);
  
  // Cleanup: remove cooldown after it expires
  setTimeout(() => {
    userCooldowns.delete(key);
  }, COOLDOWN_TIME);
}

// Function to get remaining cooldown time in minutes and seconds
function getRemainingCooldown(userId, commandType) {
  const key = `${userId}-${commandType}`;
  const cooldownExpiration = userCooldowns.get(key);
  
  if (!cooldownExpiration) return null;
  
  const remainingMs = cooldownExpiration - Date.now();
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  
  return { minutes, seconds };
}

// Function to handle role changes and sync with whale_addresses collection
async function handleRoleChange(member, oldRoles, newRoles) {
  try {
    const hadWhaleRole = oldRoles.has(WHALE_ROLE_ID);
    const hasWhaleRole = newRoles.has(WHALE_ROLE_ID);
    
    // If role status changed
    if (hadWhaleRole !== hasWhaleRole) {
      if (hasWhaleRole) {
        // User gained whale role - add to whale_addresses if they have verified wallet
        console.log(`User ${member.user.tag} gained whale role`);
        await syncUserToWhaleCollection(member.id, member.user.username, true);
      } else {
        // User lost whale role - remove from whale_addresses
        console.log(`User ${member.user.tag} lost whale role`);
        await removeWhaleAddress(member.id);
      }
    }
  } catch (error) {
    console.error('Error handling role change:', error);
  }
}

// Function to sync a user to whale collection when they gain whale role
async function syncUserToWhaleCollection(userId, username, hasWhaleRole) {
  try {
    if (!hasWhaleRole) return;
    
    // Find their verified wallet
    const verifiedWallet = await verifiedWalletsCollection.findOne({ userId: userId });
    if (!verifiedWallet) {
      console.log(`User ${username} has whale role but no verified wallet found`);
      return;
    }
    
    // Get their leaderboard info
    const leaderboardInfo = await getLeaderboardInfo(verifiedWallet.walletAddress);
    if (!leaderboardInfo) {
      console.log(`User ${username} has whale role but wallet not found in current leaderboard`);
      // Still add them to whale_addresses with basic info
      await addWhaleAddress(verifiedWallet.walletAddress, username, userId, { nickname: '', point: 0 });
      return;
    }
    
    // Add to whale_addresses collection
    await addWhaleAddress(verifiedWallet.walletAddress, username, userId, leaderboardInfo);
    
  } catch (error) {
    console.error('Error syncing user to whale collection:', error);
  }
}

// Discord bot event handlers
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  
  // Connect to MongoDB
  await connectToDatabase();
  
  // Initialize community coins module
  // await communityCoins.initializeCommunityCoins(mongoClient, client);
  
  // Set up the 10-minute role check interval
  const roleCheckInterval = 10 * 60 * 1000; // 10 minutes
  console.log(`Setting up role check interval every ${roleCheckInterval/1000/60} minutes`);
  
  setInterval(async () => {
    console.log('Running scheduled role check...');
    await assignRolesToEligibleUsers();
    // Also perform a full sync to ensure whale_addresses collection is accurate
    await syncAllWhaleRoles();
  }, roleCheckInterval);
  
  console.log('Bot is ready! Anyone can use !updateleaderboard to update the leaderboard');
  
  // Perform initial sync of whale roles on startup
  setTimeout(async () => {
    console.log('Performing initial whale role sync...');
    await syncAllWhaleRoles();
  }, 5000); // Wait 5 seconds after startup
});

// Command handler for manual updates
client.on(Events.MessageCreate, async message => {
  // Ignore messages from bots
  if (message.author.bot) return;
  
  // Handle whale role commands
  if (message.content === '!updateleaderboard') {
    // Check if user is on cooldown
    if (isUserOnCooldown(message.author.id, 'leaderboard')) {
      const cooldown = getRemainingCooldown(message.author.id, 'leaderboard');
      return message.reply(`This command is on cooldown. Please try again in ${cooldown.minutes} minutes and ${cooldown.seconds} seconds.`);
    }
    
    await message.reply('Starting leaderboard update. This may take a moment...');
    
    // Set cooldown for this user
    setUserCooldown(message.author.id, 'leaderboard');
    
    const success = await updateLeaderboard();
    
    if (success) {
      await message.reply('Leaderboard update completed successfully! Whale roles have been reassigned.');
    } else {
      await message.reply('There was an issue updating the leaderboard. Please try again later or contact an administrator.');
    }
    return;
  }

  // Debug command to check current whale addresses (optional - remove if not needed)
  if (message.content === '!whaleaddresses' && message.member.permissions.has('ADMINISTRATOR')) {
    try {
      const whaleAddresses = await getCurrentWhaleAddresses();
      if (whaleAddresses.length === 0) {
        await message.reply('No whale addresses currently stored.');
      } else {
        const whaleList = whaleAddresses.map(whale => 
          `${whale.username} (${whale.walletAddress}) - ${whale.points} points`
        ).join('\n');
        await message.reply(`Current whale addresses (${whaleAddresses.length}):\n\`\`\`${whaleList}\`\`\``);
      }
    } catch (error) {
      console.error('Error fetching whale addresses:', error);
      await message.reply('Error fetching whale addresses.');
    }
    return;
  }
  
  // // Handle community role commands
  // const handled = await communityCoins.handleCommunityRoleCommands(message, message.content);
  // if (handled) return;
});

// Handle role updates to sync with whale_addresses collection
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  // Check if whale role changed
  await handleRoleChange(newMember, oldMember.roles.cache, newMember.roles.cache);
});

// Error handling for the Discord client
client.on(Events.Error, error => {
  console.error('Discord client error:', error);
});

// Start the bot
client.login(DISCORD_TOKEN).catch(error => {
  console.error('Failed to login to Discord:', error);
});


const app = express();
const PORT = 5000;

// Basic route
app.get('/', (req, res) => {
  res.send('Discord Bot is running!');
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
