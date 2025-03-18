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
    
    // Insert a dummy document to ensure collections exist (we'll delete it right after)
    try {
      await leaderboardCollection.insertOne({ temp: true });
      await leaderboardCollection.deleteOne({ temp: true });
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
    
    // Remove roles from these users
    let removedCount = 0;
    for (const userId of userIds) {
      try {
        const member = await guild.members.fetch(userId);
        if (member && member.roles.cache.has(WHALE_ROLE_ID)) {
          await member.roles.remove(WHALE_ROLE_ID);
          removedCount++;
          console.log(`Removed whale role from ${member.user.tag}`);
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
              } else {
                console.log(`${verifiedWallet.username} already has whale role, skipping`);
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

// Discord bot event handlers
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  
  // Connect to MongoDB
  await connectToDatabase();
  
  // Initialize community coins module
  // await communityCoins.initializeCommunityCoins(mongoClient, client);
  
  // Set up the 5-minute role check interval
  const roleCheckInterval = 5 * 60 * 1000; // 5 minutes
  console.log(`Setting up role check interval every ${roleCheckInterval/1000/60} minutes`);
  
  setInterval(async () => {
    console.log('Running scheduled role check...');
    await assignRolesToEligibleUsers();
  }, roleCheckInterval);
  
  console.log('Bot is ready! Anyone can use !updateleaderboard to update the leaderboard');
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
  
  // // Handle community role commands
  // const handled = await communityCoins.handleCommunityRoleCommands(message, message.content);
  // if (handled) return;
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
const PORT = 4000;

// Basic route
app.get('/', (req, res) => {
  res.send('Discord Bot is running!');
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});