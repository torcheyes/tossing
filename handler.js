const TelegramBot = require('node-telegram-bot-api')
const mongoose = require("mongoose")
const { Schema, model } = require("mongoose")

const bot = new TelegramBot(process.env?.TELE_TOKEN||process.env?.DEV_TELE_TOKEN, { polling: false })

function loadDatabases() {
    const bot = model(`bot`, new Schema({
        id: Number,
        totalWagered: { type: Number, default: 0 },
        totalDeposited: { type: Number, default: 0 },
        profit: { type: Number, default: 0 },
    }))
    const activeSeed = model(`activeSeed`, new Schema({
        userId: String,
        game: String,
        clientSeed: String,
        serverSeed: String,
        serverSeedHashed: String,
        nextServerSeed: String,
        nextServerSeedHashed: String,
        nonce: Number
    }))
    const game = model(`game`, new Schema({
        active: {
            type: Boolean,
            default: true
        },
        id: String,
        ownerId: String,
        playerId: String,
        amount: {
            type: Number,
            default: 0
        },
        multiplayer: {
            type: Number,
            default: 0
        },
        playerMultiplayer: {
            type: Number,
            default: 0
        },
        game: String,
        gameData: Object,
        bot: Boolean,
        createdAt: {
            type: Date,
            default: Date.now
        }
    }))
    const withdraw = model(`withdraw`, new Schema({
        userId: String,
        username: String,
        address: String,
        amount: Number,
        createdAt: {
            type: Date,
            default: Date.now
        }
    }))
    const provablyFair = model(`provablyFair`, new Schema({
        proveId: String,
        serverSeed: String,
        serverHash: String,
        clientSeed: String,
        gameHash: String,
        game: String,
    }))
    const user = model(`user`, new Schema({
        userId: String,
        username: String,
        bonus: { type: Number, default: 0 },
        lastRankup: { type: Number, default: -1 },
        balance: { type: Number, default: 0 },
        totalWagered: { type: Number, default: 0 },
        totalDeposited: { type: Number, default: 0 },
        totalPlayed: { type: Number, default: 0 },
        totalWon: { type: Number, default: 0 },
        totalWinAmt: { type: Number, default: 0 },
        totalLost: { type: Number, default: 0 },
        totalTie: { type: Number, default: 0 },
        clientSeed: String,
        referral_id: String,
        join_referral_id: String,
        referral_earnings: { type: Number, default: 0 },
        referral_invited: { type: Number, default: 0 },
        referral_played: { type: Number, default: 0 },
        casinoBot: Boolean,
        appban: { type: Boolean, default: false }
    }))
    return {
        bot,
        user,
        withdraw,
        provablyFair,
        game,
        activeSeed
    }
}

const connectMongoose = async () => {
    return new Promise( resolve => {
        mongoose.connect(process.env?.MONGO_URI||process.env?.DEV_MONGO_URI)
            .then(async () => {
                console.log(`Connected to mongodb`)
                resolve(true)
            })
            .catch((error) => {
                console.log(`Error connecting to MongoDB: ${error.message}`)
                resolve(false)
            })
    } )
}

const db = loadDatabases()

module.exports = {
    db,
    connectMongoose,
    bot
}
