const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const minesWinRates = require('../storage/minesWinRate.json')
const rateLimit = require('express-rate-limit')


const { db } = require("../handler")
const { authJwt } = require('../middlewares/authJwt')
const { handleWinReport } = require('../helpers')

const User = db.user
const Game = db.game

const CARDS = [ 
    '♦2', '♥2', '♠2', '♣2', '♦3', '♥3', '♠3', '♣3', '♦4', '♥4',  
    '♠4', '♣4', '♦5', '♥5', '♠5', '♣5', '♦6', '♥6', '♠6', '♣6', 
    '♦7', '♥7', '♠7', '♣7', '♦8', '♥8', '♠8', '♣8', '♦9', '♥9', 
    '♠9', '♣9', '♦10', '♥10', '♠10', '♣10', '♦J', '♥J', '♠J', 
    '♣J', '♦Q', '♥Q', '♠Q', '♣Q', '♦K', '♥K', '♠K', '♣K', '♦A', 
    '♥A', '♠A', '♣A' 
]

const suitMapping = {
    '♦': 'D',
    '♥': 'H',
    '♠': 'S',
    '♣': 'C'
}
  
function convertCards(cards) {
    return cards.map(card => {
        const suitSymbol = card[0] // First character is the suit
        const rank = card.slice(1) // Remaining characters are the rank
        return {
            suit: suitMapping[suitSymbol], // Map suit symbol to "D", "H", "S", "C"
            rank: rank
        }
    })
}

function convertCard(card) {
    const suitSymbol = card[0] // First character is the suit
    const rank = card.slice(1) // Remaining characters are the rank
    return {
        suit: suitMapping[suitSymbol], // Map suit symbol to "D", "H", "S", "C"
        rank: rank
    }
}

function generateServerSeed() {
    const seed = crypto.randomBytes(32).toString('hex');
    const seedHashRaw = crypto.createHash('sha256').update(seed);
    const seedHash = seedHashRaw.digest('hex');
  
    return {
      seed,
      seedHash,
    }
}

function playDealerTurns(dealerCards, shuffledDeck, dealerHiddenCard) {
    const newCards = [...dealerCards]
    if( dealerHiddenCard ) {
        newCards.push(dealerHiddenCard)
    }
    let resultValue = calcCardsValue(newCards)
    let newActions = []

    while (resultValue < 17 && shuffledDeck.length !== 0) {
        const cardRes = generateBjCard(shuffledDeck)
        if( !cardRes ) break
        newCards.push(cardRes)
        resultValue = calcCardsValue(newCards)
        newActions.push("hit")
    }

    if (resultValue > 21) newActions.push("bust")
    else if (resultValue === 21) newActions.push("full")

    return {
        value: resultValue,
        cards: newCards,
        actions: newActions
    }
}


const generateBjCard = (shuffledDeck) => {
    if (shuffledDeck.length === 0) return null
    return shuffledDeck.pop()
}


function calcCardsValue(cards) {
    let value = 0
    for (let card of cards) {
        if (card.rank === 'A') {
            value += 11
        } else if (['K', 'Q', 'J'].includes(card.rank)) {
            value += 10
        } else {
            value += parseInt(card.rank)
        }
    }

    for (let card of cards) {
        if (card.rank === 'A' && value > 21) {
            value -= 10
        }
    }
    return value
}

const getFirstBjActions = (playerCards, dealerCards) => {
    const dealerValue = calcCardsValue(dealerCards)
    const playerValue = calcCardsValue(playerCards)

    if( playerValue === 21 && dealerValue === 21 ) {
        if( dealerCards[0].rank === 'A' ) {
            return {
                active: true,
                status: {
                    dealer: ['deal'],
                    player: ['deal'],
                },
                multiplayer: 0,
                dealerValue: calcCardsValue([dealerCards[0]]),
                playerValue
            }
        }

        return {
            active: false,
            status: {
                dealer: ['deal', 'blackjack'],
                player: ['deal', 'blackjack'],
            },
            multiplayer: 1,
            dealerValue,
            playerValue
        }
    } else if ( playerValue !== 21 && dealerValue === 21  ) {
        if( dealerCards[0].rank === 'A' ) {
            return {
                active: true,
                status: {
                    dealer: ['deal'],
                    player: ['deal'],
                },
                multiplayer: 0,
                dealerValue: calcCardsValue([dealerCards[0]]),
                playerValue
            }
        }
        
        return {
            active: false,
            status: {
                dealer: ['deal', 'blackjack'],
                player: ['deal'],
            },
            multiplayer: 0,
            dealerValue,
            playerValue
        }
    } else if ( playerValue === 21 && dealerValue !== 21  ) {
        if( dealerCards[0].rank === 'A' ) {
            return {
                active: true,
                status: {
                    dealer: ['deal'],
                    player: ['deal'],
                },
                multiplayer: 0,
                dealerValue: calcCardsValue([dealerCards[0]]),
                playerValue
            }
        }
        return {
            active: false,
            status: {
                dealer: ['deal'],
                player: ['deal', 'blackjack'],
            },
            multiplayer: 2.5,
            dealerValue,
            playerValue
        }
    } else {
        return {
            active: true,
            status: {
                dealer: ['deal'],
                player: ['deal'],
            },
            multiplayer: 0,
            dealerValue,
            playerValue
        }
    }
}

const splitMultiplayers = {
    '2Win': 4,
    '1Win1Lose': 2,
    '1Win1Draw': 2.5,
    '1Draw1Lose': 1,
    '2Draw': 2
}

function getBjSplitRes(firstHandValue, secondHandValue, dealerValue) {
    const WIN = 1
    const LOSE = -1
    const DRAW = 0

    function evaluateHand(handValue, dealerValue) {
        if (handValue > 21) {
            return LOSE
        } else if (dealerValue > 21) {
            return WIN
        } else if (handValue > dealerValue) {
            return WIN
        } else if (handValue < dealerValue) {
            return LOSE
        } else {
            return DRAW
        }
    }

    const result1 = evaluateHand(firstHandValue, dealerValue)
    const result2 = evaluateHand(secondHandValue, dealerValue)

    if (result1 === WIN && result2 === WIN) {
        
        return {
            multiplayer: splitMultiplayers['2Win']
        }
    } else if (result1 === WIN && result2 === LOSE || result1 === LOSE && result2 === WIN) {
        
        return {
            multiplayer: splitMultiplayers['1Win1Lose']
        }
    } else if (result1 === DRAW && result2 === LOSE || result1 === LOSE && result2 === DRAW) {
        
        return {
            multiplayer: splitMultiplayers['1Draw1Lose']
        }
    } else if (result1 === WIN && result2 === DRAW || result1 === DRAW && result2 === WIN) {
        
        return {
            multiplayer: splitMultiplayers['1Win1Draw']
        }
    } else if ( result1 === DRAW && result2 === DRAW ) {
        return {
            multiplayer: splitMultiplayers['2Draw']
        }
    } else {
        return {
            multiplayer: 0
        }
    }
}

const handleGameEnd = async ( res, userId, betAmount ) => {
    await db["user"].findOneAndUpdate(
        { userId: String(userId) },
        {
            $inc: {
                balance: Number(betAmount) * res.multiplayer,
                totalWagered: Number(betAmount),
                totalWon: res.multiplayer > 1 ? 1 : 0,
                totalLost: res.multiplayer < 1 ? 1 : 0,
                totalTie: res.multiplayer === 1 ? 1 : 0,
                totalPlayed: 1,
                totalWinAmt: res.multiplayer > 1 ? (res.multiplayer * Number(betAmount)) : 0,
            }
        }
    )

    let botAmount
    if( res.multiplayer === 0 ) botAmount = Number(betAmount)
    else if ( res.multiplayer < 1 ) botAmount = Number(betAmount) - (Number(betAmount) * res.multiplayer)
    else if ( res.multiplayer === 1 ) botAmount = 0
    else botAmount = -(Math.abs(Number(betAmount) - (Number(betAmount) * res.multiplayer)))

    //console.log(`betAmount: ${betAmount}, multiplier: ${res.multiplayer}, remove from housebal: ${botAmount}`)

    await db["user"].findOneAndUpdate(
        { casinoBot: true },
        { $inc: { balance: botAmount } }
    )
}

const spamLimiter = rateLimit({
    store: new rateLimit.MemoryStore(),
    max: 1,
    windowMs: 500,
    standardHeaders: true, 
    legacyHeaders: false,
    handler: (req, res, next) => {
        const timeLeft = (req.rateLimit.resetTime - Date.now()) / 1000
        res.status(429).json({
            error: 'This action cannot be performed due to slowmode rate limit.',
            timeLeft: timeLeft > 0 ? timeLeft : 0,
        })
    },
    keyGenerator: function(req) {
        return String(req.userData.id)
    }
})

const moveLimiter = rateLimit({
    store: new rateLimit.MemoryStore(),
    max: 1,
    windowMs: 300,
    standardHeaders: true, 
    legacyHeaders: false,
    handler: (req, res, next) => {
        const timeLeft = (req.rateLimit.resetTime - Date.now()) / 1000
        res.status(429).json({
            error: 'This action cannot be performed due to slowmode rate limit.',
            timeLeft: timeLeft > 0 ? timeLeft : 0,
        })
    },
    keyGenerator: function(req) {
        return String(req.userData.id)
    }
})

const spamCache = {
    bet: {},
    hit: {},
    split: {},
    stand: {},
    insurance: {},
    noInsurance: {},
    double: {}
}


router.post('/active-bet', authJwt, spamLimiter, async (req, res) => {
    try {
        const userData = req.userData

        const foundGame = await Game.findOne({game: 'blackjack', ownerId: String(userData.id), active: true}).select('id amount multiplayer gameData').lean()
        if(!foundGame) return res.status(200).json({
            activeCasinoBet: null
        })

        res.status(200).json({
            activeCasinoBet: {
                active: true,
                _id: foundGame._id,
                id: foundGame.id,
                amount: Number(foundGame.amount),
                multiplayer: foundGame.multiplayer,
                game: 'blackjack',
                ownerId: String(userData.id),
                gameData: {
                    dealer: foundGame.gameData.dealer,
                    player: foundGame.gameData.player
                }
            }
        })
    } catch ( err ) {
        console.error( err )
        res.status(500).json({ error: 'Internal server error' })
    }
})

function* byteGenerator({ serverSeed, clientSeed, nonce, cursor }) {
    // Initialize cursor variables
    let currentRound = Math.floor(cursor / 32);
    let currentRoundCursor = cursor % 32;
  
    while (true) {
      // Create HMAC for the current round
      const hmac = crypto.createHmac('sha256', serverSeed);
      hmac.update(`${clientSeed}:${nonce}:${currentRound}`);
      const buffer = hmac.digest();
  
      // Yield bytes from the buffer
      while (currentRoundCursor < 32) {
        yield buffer[currentRoundCursor];
        currentRoundCursor++;
      }
  
      // Move to the next round
      currentRoundCursor = 0;
      currentRound++;
    }
}
const _ = require('lodash')

function generateFloats({ serverSeed, clientSeed, nonce, cursor, count }) {
    const rng = byteGenerator({ serverSeed, clientSeed, nonce, cursor });
    const bytes = [];
  
    // Collect enough bytes
    while (bytes.length < count * 4) {
      bytes.push(rng.next().value);
    }
  
    // Chunk bytes into groups of 4 and convert to floats
    return _.chunk(bytes, 4).map(bytesChunk =>
      bytesChunk.reduce((result, value, i) => {
        const divider = 256 ** (i + 1); // Scale down byte values
        const partialResult = value / divider;
        return result + partialResult;
      }, 0)
    );
}

router.post('/create-bet', authJwt, spamLimiter, async (req, res) => {
    try {
        const userData = req.userData

        if( spamCache.bet[userData.id] === true ) return res.status(400).json({ error: 'stop spam' })
        spamCache.bet[userData.id] = true

        const foundGame = await Game.exists({game: 'blackjack', ownerId: String(userData.id), active: true})
        if(foundGame) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'already playing' })
        }

        const { betAmount } = req.body

        if (!betAmount || isNaN(betAmount) || Number(betAmount) < 0.25) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Minimum wager is 0.25$' })
        }
        if ( Number(betAmount) > 25) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Maximum wager is 25$' })
        }

        const user = await User.findOne({userId: String(userData.id)}).select('balance').lean()
        if (!user) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Unauthorized access' })
        }
        if (Number(betAmount) > user.balance) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Insufficient balance' })
        }
    
        const botUser = await User.findOne({casinoBot: true}).select('balance').lean()
        if(!botUser) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Bot user not found' })
        }
        if( Number(betAmount) > botUser.balance ) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Insufficient house balance' })
        }

        await db["user"].findOneAndUpdate(
            { userId: String(userData.id) },
            { $inc: { balance: -Number(betAmount) } }
        )

        let foundSeedDoc = await db['activeSeed'].findOne({ userId: String(userData.id) }).lean()
        if (!foundSeedDoc) {
            const newClientSeed = crypto.randomBytes(16).toString('hex')
            const newServerSeed = generateServerSeed()
            const newNextServerSeed = generateServerSeed()
    
            foundSeedDoc = await db['activeSeed'].create({
                game: 'blackjack',
                userId: String(userData.id),
                clientSeed: newClientSeed,
                serverSeed: newServerSeed.seed,
                serverSeedHashed: newServerSeed.seedHash,
                nextServerSeed: newNextServerSeed.seed,
                nextServerSeedHashed: newNextServerSeed.seedHash,
                nonce: 0
            })
        }
        foundSeedDoc.nonce += 1

        await db['activeSeed'].updateOne({ _id: foundSeedDoc._id }, { nonce: foundSeedDoc.nonce })

        const floats = generateFloats({
            serverSeed: foundSeedDoc.serverSeed,
            clientSeed: foundSeedDoc.clientSeed,
            nonce: foundSeedDoc.nonce,
            cursor: 0,
            count: 52, // Generate 5 floats
        })

        const shuffledDeck = []
        floats.forEach( float => {
            const card = CARDS[Math.floor(float * 52)]
            const convertedCard = convertCard(card)
            shuffledDeck.push(convertedCard)
        } )

        /*const shuffledDeck = [
            {rank: 4, suit: 'C'},
            {rank: 4, suit: 'C'},
            {rank: 4, suit: 'C'},
            {rank: 4, suit: 'C'},
            {rank: 8, suit: 'C'},
            {rank: 8, suit: 'C'},
            {rank: 10, suit: 'C'},
            {rank: 'A', suit: 'C'},
            {rank: 'J', suit: 'C'},
            {rank: 9, suit: 'C'}
        ]*/

        //console.log(shuffledDeck.map( c => c.rank ).join(', '))

        const newPlayerCards = []
        const newDealerCards = []


        while( newDealerCards.length < 2 ) {
            const cardRes = generateBjCard(shuffledDeck)
            newDealerCards.push(cardRes)
        }

        while( newPlayerCards.length < 2 ) {
            const cardRes = generateBjCard(shuffledDeck)
            newPlayerCards.push(cardRes)
        }

        const firstBjActions = getFirstBjActions(newPlayerCards, newDealerCards)

        let dealerHiddenCard = null
        if( firstBjActions.active ) {
            dealerHiddenCard = newDealerCards.pop()
        }
        
        const gameRes = await Game.create({
            active: firstBjActions.active,
            amount: betAmount,
            game: 'blackjack',
            ownerId: String(userData.id),
            multiplayer: firstBjActions.multiplayer,
            gameData: {
                dealer: [
                    {
                        actions: [...firstBjActions.status.dealer],
                        cards: [...newDealerCards],
                        value: firstBjActions.dealerValue
                    }
                ],
                player: [
                    {
                        actions: [...firstBjActions.status.player],
                        cards: [...newPlayerCards],
                        value: firstBjActions.playerValue
                    }
                ],
                ...(
                    firstBjActions.active ? {
                        shuffledDeck,
                        dealerHiddenCard
                    } : {}
                ),
                clientSeed: foundSeedDoc.clientSeed,
                serverSeedHashed: foundSeedDoc.serverSeedHashed,
                nonce: foundSeedDoc.nonce
            }
        })

        if( !firstBjActions.active ) {
            await handleGameEnd(firstBjActions, userData.id, betAmount)
        }

        delete spamCache.bet[userData.id]
        
        res.status(200).json({
            _id: gameRes._id,
            active: firstBjActions.active,
            amount: betAmount,
            game: 'blackjack',
            ownerId: String(userData.id),
            multiplayer: firstBjActions.multiplayer,
            gameData: {
                dealer: [
                    {
                        actions: [...firstBjActions.status.dealer],
                        cards: [...newDealerCards],
                        value: firstBjActions.dealerValue
                    }
                ],
                player: [
                    {
                        actions: [...firstBjActions.status.player],
                        cards: [...newPlayerCards],
                        value: firstBjActions.playerValue
                    }
                ]
            }
        })
    } catch ( err ) {
        delete spamCache.bet[userData.id]
        console.error( err )
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/action-hit', authJwt, moveLimiter, async (req, res) => {
    try {
        const userData = req.userData

        if( spamCache.hit[userData.id] === true ) return res.status(400).json({ error: 'stop spam' })
        spamCache.hit[userData.id] = true

        const foundGame = await Game.findOne({game: 'blackjack', ownerId: String(userData.id), active: true}).select('amount gameData').lean()
        if(!foundGame) {
            delete spamCache.hit[userData.id]
            return res.status(400).json({ error: 'Game not found' })
        }

        const shuffledDeck = foundGame.gameData.shuffledDeck

        const hitCard = generateBjCard(shuffledDeck)

        const firstPlayerHand = foundGame.gameData.player[0]
        const firstDealerHand = foundGame.gameData.dealer[0]

        let handIndex = 0
        if( foundGame.gameData.player.length === 2 ) {
            const handHasPlayed = firstPlayerHand.actions.some( action => ["bust", "full", "stand", "double"].includes(action) )
            if( handHasPlayed ) handIndex = 1
        }

        const selectedPlayerHand = foundGame.gameData.player[handIndex]
        

        const newPlayerCards = [
            ...selectedPlayerHand.cards,
            hitCard
        ]
        const playerValue = calcCardsValue(newPlayerCards)
        let resultMultiplier
        let updateData = {}

        if( playerValue > 21 ) {
            // player lost here

            const newPlayerActions = [
                ...selectedPlayerHand.actions,
                "hit",
                "bust"
            ]
            
            if( foundGame.gameData.player.length === 2 ) {

                const contrHand = foundGame.gameData.player[handIndex === 0 ? 1 : 0]
                const contrHandBust = contrHand.actions.includes("bust")
                const contrHandEnded = contrHand.actions.some( action => ["full", "stand", "double"].includes(action) )


                if( contrHandBust ) {
                    // both lost here
                    resultMultiplier = 0

                    updateData = {
                        active: false,
                        multiplayer: resultMultiplier,
                        [`gameData.player.${handIndex}.value`]: playerValue,
                        [`gameData.player.${handIndex}.cards`]: newPlayerCards,
                        [`gameData.player.${handIndex}.actions`]: newPlayerActions
                    }
                } else if ( contrHandEnded ) {
                    // other hand is 21 or lower
                    const newDealerResults = playDealerTurns(firstDealerHand.cards, shuffledDeck, foundGame.gameData.dealerHiddenCard)

                    const splitRes = getBjSplitRes(contrHand.value, playerValue, newDealerResults.value)

                    let addDealerActions = [
                        ...firstDealerHand.actions,
                        ...newDealerResults.actions
                    ]
                

                    updateData = {
                        active: false,
                        multiplayer: splitRes.multiplayer,
                        [`gameData.player.${handIndex}.value`]: playerValue,
                        [`gameData.player.${handIndex}.cards`]: newPlayerCards,
                        [`gameData.player.${handIndex}.actions`]: newPlayerActions,
                        [`gameData.dealer.0.cards`]: newDealerResults.cards,
                        [`gameData.dealer.0.value`]: newDealerResults.value,
                        [`gameData.dealer.0.actions`]: addDealerActions
                    }
                } else {
                    updateData = {
                        active: true,
                        multiplayer: 0,
                        [`gameData.player.${handIndex}.value`]: playerValue,
                        [`gameData.player.${handIndex}.cards`]: newPlayerCards,
                        [`gameData.player.${handIndex}.actions`]: newPlayerActions
                    }
                }

            } else {
                resultMultiplier = 0
                updateData = {
                    active: false,
                    multiplayer: resultMultiplier,
                    [`gameData.player.${handIndex}.value`]: playerValue,
                    [`gameData.player.${handIndex}.cards`]: newPlayerCards,
                    [`gameData.player.${handIndex}.actions`]: newPlayerActions
                
                }
            }

            
        } else if ( playerValue === 21 ) {
            
            let addPlayerActions = [
                ...selectedPlayerHand.actions,
                "hit",
                "full"
            ]


            if( foundGame.gameData.player.length === 2 ) {
                const contrHand = foundGame.gameData.player[handIndex === 0 ? 1 : 0]
                const contrHandEnded = contrHand.actions.some( action => ["bust", "full", "stand", "double"].includes(action) )

                if ( contrHandEnded ) {
                    const newDealerResults = playDealerTurns(firstDealerHand.cards, shuffledDeck, foundGame.gameData.dealerHiddenCard)

                    const splitRes = getBjSplitRes(contrHand.value, playerValue, newDealerResults.value)

                    let addDealerActions = [
                        ...firstDealerHand.actions,
                        ...newDealerResults.actions
                    ]
                    
                    updateData = {
                        active: false,
                        multiplayer: splitRes.multiplayer,
                        [`gameData.player.${handIndex}.value`]: playerValue,
                        [`gameData.player.${handIndex}.cards`]: newPlayerCards,
                        [`gameData.player.${handIndex}.actions`]: addPlayerActions,
                        [`gameData.dealer.0.cards`]: newDealerResults.cards,
                        [`gameData.dealer.0.value`]: newDealerResults.value,
                        [`gameData.dealer.0.actions`]: addDealerActions
                    }
                } else {
                    updateData = {
                        active: true,
                        multiplayer: 0,
                        [`gameData.player.${handIndex}.value`]: playerValue,
                        [`gameData.player.${handIndex}.cards`]: newPlayerCards,
                        [`gameData.player.${handIndex}.actions`]: addPlayerActions
                    }
                }

            } else {
                const newDealerResults = playDealerTurns(firstDealerHand.cards, shuffledDeck, foundGame.gameData.dealerHiddenCard)

                let addDealerActions = [
                    ...firstDealerHand.actions,
                    ...newDealerResults.actions
                ]

                if( newDealerResults.value === 21 ) {
                    resultMultiplier = 1
                } else {
                    resultMultiplier = 2
                }

                updateData = {
                    active: false,
                    multiplayer: resultMultiplier,
                    [`gameData.player.${handIndex}.value`]: playerValue,
                    [`gameData.player.${handIndex}.cards`]: newPlayerCards,
                    [`gameData.player.${handIndex}.actions`]: addPlayerActions,
                    [`gameData.dealer.0.cards`]: newDealerResults.cards,
                    [`gameData.dealer.0.value`]: newDealerResults.value,
                    [`gameData.dealer.0.actions`]: addDealerActions
                }
            }

        } else {

            let addPlayerActions = [
                ...selectedPlayerHand.actions,
                "hit"
            ]

            updateData = {
                active: true,
                multiplayer: 0,
                [`gameData.player.${handIndex}.value`]: playerValue,
                [`gameData.player.${handIndex}.cards`]: newPlayerCards,
                [`gameData.player.${handIndex}.actions`]: addPlayerActions,
            }
        }

        if( !updateData.active ) {
            await handleGameEnd({multiplayer: updateData.multiplayer}, userData.id, foundGame.amount)

            if( updateData.multiplayer > 1 ) {
                handleWinReport(userData, 'blackjack', foundGame.amount, updateData.multiplayer)
            }

            updateData = {
                ...updateData,
                $unset: {
                    'gameData.shuffledDeck': 1,
                    'gameData.dealerHiddenCard': 1
                }
            }
        } else {
            updateData['gameData.shuffledDeck'] = shuffledDeck
        }

        const populatedGame = await Game.findByIdAndUpdate(foundGame._id, {...updateData}, {new: true})
            .select('active ownerId amount multiplayer game gameData.dealer gameData.player')
            .lean()

        delete spamCache.hit[userData.id]

        res.status(200).json(populatedGame)
    } catch ( err ) {
        delete spamCache.hit[userData.id]
        console.error( err )
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/action-stand', authJwt, moveLimiter, async (req, res) => {
    try {
        const userData = req.userData

        if( spamCache.stand[userData.id] === true ) return res.status(400).json({ error: 'stop spam' })
        spamCache.stand[userData.id] = true

        const foundGame = await Game.findOne({game: 'blackjack', ownerId: String(userData.id), active: true}).select('amount gameData').lean()
        if(!foundGame) {
            delete spamCache.stand[userData.id]
            return res.status(400).json({ error: 'Game not found' })
        }

        const shuffledDeck = foundGame.gameData.shuffledDeck

        const firstPlayerHand = foundGame.gameData.player[0]
        const firstDealerHand = foundGame.gameData.dealer[0]

        let handIndex = 0
        if( foundGame.gameData.player.length === 2 ) {
            const handHasPlayed = firstPlayerHand.actions.some( action => ["bust", "full", "stand", "double"].includes(action) )
            if( handHasPlayed ) handIndex = 1
        }

        const selectedPlayerHand = foundGame.gameData.player[handIndex]

        let addPlayerActions = [
            ...selectedPlayerHand.actions,
            "stand"
        ]
        let resultMultiplier
        let updateData = {}

        if( foundGame.gameData.player.length === 2 ) {
            const contrHand = foundGame.gameData.player[handIndex === 0 ? 1 : 0]
            const contrHandEnded = contrHand.actions.some( action => ["bust", "full", "stand", "double"].includes(action) )

            if( contrHandEnded ) {
                const newDealerResults = playDealerTurns(firstDealerHand.cards, shuffledDeck, foundGame.gameData.dealerHiddenCard)

                const splitRes = getBjSplitRes(contrHand.value, selectedPlayerHand.value, newDealerResults.value)

                let addDealerActions = [
                    ...firstDealerHand.actions,
                    ...newDealerResults.actions
                ]
                

                updateData = {
                    active: false,
                    multiplayer: splitRes.multiplayer,
                    [`gameData.player.${handIndex}.actions`]: addPlayerActions,
                    [`gameData.dealer.0.cards`]: newDealerResults.cards,
                    [`gameData.dealer.0.value`]: newDealerResults.value,
                    [`gameData.dealer.0.actions`]: addDealerActions
                }
            } else {
                updateData = {
                    active: true,
                    multiplayer: 0,
                    [`gameData.player.${handIndex}.actions`]: addPlayerActions
                }
            }
            
        } else {
            const newDealerResults = playDealerTurns(firstDealerHand.cards, shuffledDeck, foundGame.gameData.dealerHiddenCard)

            let addDealerActions = [
                ...firstDealerHand.actions,
                ...newDealerResults.actions
            ]

            if( newDealerResults.value === firstPlayerHand.value ) {
                resultMultiplier = 1
            } else {

                if( newDealerResults.value > firstPlayerHand.value && newDealerResults.value <= 21 ) {
                    resultMultiplier = 0
                } else {
                    resultMultiplier = 2
                }
            }

            updateData = {
                active: false,
                multiplayer: resultMultiplier,
                [`gameData.player.0.actions`]: addPlayerActions,
                [`gameData.dealer.0.cards`]: newDealerResults.cards,
                [`gameData.dealer.0.value`]: newDealerResults.value,
                [`gameData.dealer.0.actions`]: addDealerActions
            }
        }

        if( !updateData.active ) {
            await handleGameEnd({multiplayer: updateData.multiplayer}, userData.id, foundGame.amount)

            if( updateData.multiplayer > 1 ) {
                handleWinReport(userData, 'blackjack', foundGame.amount, updateData.multiplayer)
            }

            updateData = {
                ...updateData,
                $unset: {
                    'gameData.shuffledDeck': 1,
                    'gameData.dealerHiddenCard': 1
                }
            }
        } else {
            updateData['gameData.shuffledDeck'] = shuffledDeck
        }

        const populatedGame = await Game.findByIdAndUpdate(foundGame._id, {...updateData}, {new: true})
            .select('active ownerId amount multiplayer game gameData.dealer gameData.player')
            .lean()

        delete spamCache.stand[userData.id]

        res.status(200).json(populatedGame)
    } catch ( err ) {
        delete spamCache.stand[userData.id]
        console.error( err )
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/action-split', authJwt, moveLimiter, async (req, res) => {
    try {
        const userData = req.userData

        if( spamCache.split[userData.id] === true ) return res.status(400).json({ error: 'stop spam' })
        spamCache.split[userData.id] = true

        const foundGame = await Game.findOne({game: 'blackjack', ownerId: String(userData.id), active: true}).select('amount gameData').lean()
        if(!foundGame) {
            delete spamCache.split[userData.id]
            return res.status(400).json({ error: 'Game not found' })
        }

        const shuffledDeck = foundGame.gameData.shuffledDeck

        const firstPlayerHand = foundGame.gameData.player[0]
        const firstDealerHand = foundGame.gameData.dealer[0]

        if (
            firstPlayerHand.actions.includes("split") ||
            foundGame.gameData.player.length !== 1 ||
            firstPlayerHand.cards.length !== 2 ||
            firstPlayerHand.cards[0].rank !== firstPlayerHand.cards[1].rank
        ) {
            delete spamCache.split[userData.id]
            return res.status(400).json({ error: 'Invalid request data' })
        }

        const user = await User.findOne({userId: String(userData.id)}).select('balance').lean()
        if (!user) {
            delete spamCache.split[userData.id]
            return res.status(400).json({ error: 'Unauthorized access' })
        }
        if (Number(foundGame.amount) > user.balance) {
            delete spamCache.split[userData.id]
            return res.status(400).json({ error: 'Insufficient balance' })
        }
    
        const botUser = await User.findOne({casinoBot: true}).select('balance').lean()
        if(!botUser) {
            delete spamCache.split[userData.id]
            return res.status(400).json({ error: 'Bot user not found' })
        }
        if( Number(foundGame.amount) > botUser.balance ) {
            delete spamCache.split[userData.id]
            return res.status(400).json({ error: 'Insufficient house balance' })
        }

        await db["user"].findOneAndUpdate(
            { userId: String(userData.id) },
            { $inc: { balance: -Number(foundGame.amount) } }
        )


        const firstHandCard = generateBjCard(shuffledDeck)
        const secondHandCard = generateBjCard(shuffledDeck)

        const firstPlayerCard = firstPlayerHand.cards[0]

        const newFirstHandCards = [
            firstPlayerCard,
            firstHandCard
        ]
        const newSecondHandCards = [
            firstPlayerCard,
            secondHandCard
        ]

        const firstHandValue = calcCardsValue(newFirstHandCards)
        const secondHandValue = calcCardsValue(newSecondHandCards)

        let addFirstHandActions = [
            ...firstPlayerHand.actions,
            "split"
        ]
        let addSecondHandActions = [
            ...firstPlayerHand.actions,
            "split"
        ]

        if( firstHandValue === 21 ) {
            addFirstHandActions.push("full")
        }
        if( secondHandValue === 21 ) {
            addSecondHandActions.push("full")
        }

        let updateData = {}
        let resultMultiplier

        if( firstPlayerHand.cards[0].rank === 'A' && firstPlayerHand.cards[1].rank === 'A' ) {
            const newDealerResults = playDealerTurns(firstDealerHand.cards, shuffledDeck, foundGame.gameData.dealerHiddenCard)

            const splitRes = getBjSplitRes(secondHandValue, firstHandValue, newDealerResults.value)

            let addDealerActions = [
                ...firstDealerHand.actions,
                ...newDealerResults.actions
            ]

            updateData = {
                active: false,
                multiplayer: splitRes.multiplayer,
                [`gameData.dealer.0.value`]: newDealerResults.value,
                [`gameData.dealer.0.cards`]: newDealerResults.cards,
                [`gameData.dealer.0.actions`]: addDealerActions,
                [`gameData.player.0.value`]: firstHandValue,
                [`gameData.player.0.cards`]: newFirstHandCards,
                [`gameData.player.0.actions`]: addFirstHandActions,
                [`gameData.player.1.value`]: secondHandValue,
                [`gameData.player.1.cards`]: newSecondHandCards,
                [`gameData.player.1.actions`]: addSecondHandActions
            }
        } else if( firstHandValue === 21 || secondHandValue === 21 ) {

            if( firstHandValue === 21 && secondHandValue !== 21 ) {
                updateData = {
                    active: true,
                    multiplayer: 0,
                    [`gameData.player.0.value`]: firstHandValue,
                    [`gameData.player.0.cards`]: newFirstHandCards,
                    [`gameData.player.0.actions`]: addFirstHandActions,
                    [`gameData.player.1.value`]: secondHandValue,
                    [`gameData.player.1.cards`]: newSecondHandCards,
                    [`gameData.player.1.actions`]: addSecondHandActions
                }
            } else if ( firstHandValue !== 21 && secondHandValue === 21 ) {
                updateData = {
                    active: true,
                    multiplayer: 0,
                    [`gameData.player.0.value`]: firstHandValue,
                    [`gameData.player.0.cards`]: newFirstHandCards,
                    [`gameData.player.0.actions`]: addFirstHandActions,
                    [`gameData.player.1.value`]: secondHandValue,
                    [`gameData.player.1.cards`]: newSecondHandCards,
                    [`gameData.player.1.actions`]: addSecondHandActions
                }
            } else {
                const newDealerResults = playDealerTurns(firstDealerHand.cards, shuffledDeck, foundGame.gameData.dealerHiddenCard)

                let addDealerActions = [
                    ...firstDealerHand.actions,
                    ...newDealerResults.actions
                ]

                if( newDealerResults.value === 21 ) {
                    resultMultiplier = splitMultiplayers['1Win1Lose']
                } else {
                    resultMultiplier = splitMultiplayers['2Win']
                }

                updateData = {
                    active: false,
                    multiplayer: resultMultiplier,
                    [`gameData.dealer.0.value`]: newDealerResults.value,
                    [`gameData.dealer.0.cards`]: newDealerResults.cards,
                    [`gameData.dealer.0.actions`]: addDealerActions,
                    [`gameData.player.0.value`]: firstHandValue,
                    [`gameData.player.0.cards`]: newFirstHandCards,
                    [`gameData.player.0.actions`]: addFirstHandActions,
                    [`gameData.player.1.value`]: secondHandValue,
                    [`gameData.player.1.cards`]: newSecondHandCards,
                    [`gameData.player.1.actions`]: addSecondHandActions
                }
            }
        } else {
            updateData = {
                active: true,
                multiplayer: 0,
                [`gameData.player.0.value`]: firstHandValue,
                [`gameData.player.0.cards`]: newFirstHandCards,
                [`gameData.player.0.actions`]: addFirstHandActions,
                [`gameData.player.1.value`]: secondHandValue,
                [`gameData.player.1.cards`]: newSecondHandCards,
                [`gameData.player.1.actions`]: addSecondHandActions
            }
        }

        if( !updateData.active ) {
            await handleGameEnd({multiplayer: updateData.multiplayer}, userData.id, foundGame.amount)

            if( updateData.multiplayer > 1 ) {
                handleWinReport(userData, 'blackjack', foundGame.amount, updateData.multiplayer)
            }

            updateData = {
                ...updateData,
                $unset: {
                    'gameData.shuffledDeck': 1,
                    'gameData.dealerHiddenCard': 1
                }
            }
        } else {
            updateData['gameData.shuffledDeck'] = shuffledDeck
        }

        const populatedGame = await Game.findByIdAndUpdate(foundGame._id, {...updateData}, {new: true})
            .select('active ownerId amount multiplayer game gameData.dealer gameData.player')
            .lean()

        delete spamCache.split[userData.id]            

        res.status(200).json(populatedGame)
    } catch ( err ) {
        delete spamCache.split[userData.id]
        console.error( err )
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/action-insurance', authJwt, moveLimiter, async (req, res) => {
    try {
        const userData = req.userData

        if( spamCache.insurance[userData.id] === true ) return res.status(400).json({ error: 'stop spam' })
        spamCache.insurance[userData.id] = true

        const foundGame = await Game.findOne({game: 'blackjack', ownerId: String(userData.id), active: true}).select('amount gameData').lean()
        if(!foundGame) {
            delete spamCache.insurance[userData.id]
            return res.status(400).json({ error: 'Game not found' })
        }

        const shuffledDeck = foundGame.gameData.shuffledDeck

        const firstPlayerHand = foundGame.gameData.player[0]
        const firstDealerHand = foundGame.gameData.dealer[0]

        if(
            firstDealerHand.cards[0].rank !== "A" ||
            ["insurance", "noInsurance", "hit", "split"].includes(firstPlayerHand.actions[firstPlayerHand.actions.length-1])
        ) {
            delete spamCache.insurance[userData.id]
            return res.status(400).json({ error: 'Invalid request data' })
        }

        const insuranceAmount = Number(foundGame.amount) / 2

        const user = await User.findOne({userId: String(userData.id)}).select('balance').lean()
        if (!user) {
            delete spamCache.insurance[userData.id]
            return res.status(400).json({ error: 'Unauthorized access' })
        }
        if (Number(insuranceAmount) > user.balance) return res.status(400).json({ error: 'Insufficient balance' })
    
        const botUser = await User.findOne({casinoBot: true}).select('balance').lean()
        if(!botUser) {
            delete spamCache.insurance[userData.id]
            return res.status(400).json({ error: 'Bot user not found' })
        }
        if( Number(insuranceAmount) > botUser.balance ) {
            delete spamCache.insurance[userData.id]
            return res.status(400).json({ error: 'Insufficient house balance' })
        }

        await db["user"].findOneAndUpdate(
            { userId: String(userData.id) },
            { $inc: { balance: -Number(insuranceAmount) } }
        )


        const newDealerCard = foundGame.gameData.dealerHiddenCard

        const newDealerHandCards = [
            ...firstDealerHand.cards,
            newDealerCard
        ]

        const newDealerValue = calcCardsValue(newDealerHandCards)

        const addPlayerActions = [
            ...firstPlayerHand.actions,
            "insurance"
        ]

        let updateData = {}
        let resultMultiplier

        if( newDealerValue === 21 ) {
            const addDealerActions = [
                ...firstDealerHand.actions,
                "blackjack"
            ]

            if( firstPlayerHand.value === 21 ) {
                addPlayerActions.push('blackjack')
                resultMultiplier = 1.5

                updateData = {
                    active: false,
                    multiplayer: resultMultiplier,
                    [`gameData.player.0.actions`]: addPlayerActions,
                    [`gameData.dealer.0.value`]: newDealerValue,
                    [`gameData.dealer.0.cards`]: newDealerHandCards,
                    [`gameData.dealer.0.actions`]: addDealerActions
                }
            } else {
                resultMultiplier = 1.5

                updateData = {
                    active: false,
                    multiplayer: resultMultiplier,
                    [`gameData.player.0.actions`]: addPlayerActions,
                    [`gameData.dealer.0.value`]: newDealerValue,
                    [`gameData.dealer.0.cards`]: newDealerHandCards,
                    [`gameData.dealer.0.actions`]: addDealerActions
                }
            }
        } else {
            if( firstPlayerHand.value === 21 ) {
                addPlayerActions.push('blackjack')
                resultMultiplier = 2.5

                updateData = {
                    active: false,
                    multiplayer: resultMultiplier,
                    [`gameData.player.0.actions`]: addPlayerActions,
                    [`gameData.dealer.0.value`]: newDealerValue,
                    [`gameData.dealer.0.cards`]: newDealerHandCards
                }
            } else {
                updateData = {
                    active: true,
                    multiplayer: 0,
                    [`gameData.player.0.actions`]: addPlayerActions
                }
            }
        }

        if( !updateData.active ) {
            await handleGameEnd({multiplayer: updateData.multiplayer}, userData.id, foundGame.amount)

            if( updateData.multiplayer > 1 ) {
                handleWinReport(userData, 'blackjack', foundGame.amount, updateData.multiplayer)
            }

            updateData = {
                ...updateData,
                $unset: {
                    'gameData.shuffledDeck': 1,
                    'gameData.dealerHiddenCard': 1
                }
            }
        } else {
            updateData['gameData.shuffledDeck'] = [...shuffledDeck, newDealerCard]
        }

        const populatedGame = await Game.findByIdAndUpdate(foundGame._id, {...updateData}, {new: true})
            .select('active ownerId amount multiplayer game gameData.dealer gameData.player')
            .lean()

        delete spamCache.insurance[userData.id]

        res.status(200).json(populatedGame)
    } catch ( err ) {
        delete spamCache.insurance[userData.id]
        console.error( err )
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/action-no-insurance', authJwt, moveLimiter, async (req, res) => {
    try {
        const userData = req.userData

        if( spamCache.noInsurance[userData.id] === true ) return res.status(400).json({ error: 'stop spam' })
        spamCache.noInsurance[userData.id] = true

        const foundGame = await Game.findOne({game: 'blackjack', ownerId: String(userData.id), active: true}).select('amount gameData').lean()
        if(!foundGame) {
            delete spamCache.noInsurance[userData.id]
            return res.status(400).json({ error: 'Game not found' })
        }

        const shuffledDeck = foundGame.gameData.shuffledDeck

        const firstPlayerHand = foundGame.gameData.player[0]
        const firstDealerHand = foundGame.gameData.dealer[0]

        if(
            firstDealerHand.cards[0].rank !== "A" ||
            ["insurance", "noInsurance", "hit", "split"].includes(firstPlayerHand.actions[firstPlayerHand.actions.length-1])
        ) {
            delete spamCache.noInsurance[userData.id]
            return res.status(400).json({ error: 'Invalid request data' })
        }

        const newDealerCard = foundGame.gameData.dealerHiddenCard

        const newDealerHandCards = [
            ...firstDealerHand.cards,
            newDealerCard
        ]

        const newDealerValue = calcCardsValue(newDealerHandCards)

        const addPlayerActions = [
            ...firstPlayerHand.actions,
            "noInsurance"
        ]

        let updateData = {}
        let resultMultiplier

        if( newDealerValue === 21 ) {

            if( firstPlayerHand.value === 21 ) {
                const addDealerActions = [
                    ...firstDealerHand.actions,
                    "blackjack"
                ]
                addPlayerActions.push('blackjack')
                resultMultiplier = 1

                updateData = {
                    active: false,
                    multiplayer: resultMultiplier,
                    [`gameData.player.0.actions`]: addPlayerActions,
                    [`gameData.dealer.0.value`]: newDealerValue,
                    [`gameData.dealer.0.cards`]: newDealerHandCards,
                    [`gameData.dealer.0.actions`]: addDealerActions
                }
            } else {
                const addDealerActions = [
                    ...firstDealerHand.actions,
                    "blackjack"
                ]
                resultMultiplier = 0

                updateData = {
                    active: false,
                    multiplayer: resultMultiplier,
                    [`gameData.player.0.actions`]: addPlayerActions,
                    [`gameData.dealer.0.value`]: newDealerValue,
                    [`gameData.dealer.0.cards`]: newDealerHandCards,
                    [`gameData.dealer.0.actions`]: addDealerActions
                }
            }
        } else {
            if( firstPlayerHand.value === 21 ) {
                addPlayerActions.push('blackjack')
                resultMultiplier = 2

                updateData = {
                    active: false,
                    multiplayer: resultMultiplier,
                    [`gameData.player.0.actions`]: addPlayerActions,
                    [`gameData.dealer.0.value`]: newDealerValue,
                    [`gameData.dealer.0.cards`]: newDealerHandCards
                }
            } else {
                updateData = {
                    active: true,
                    multiplayer: 0,
                    [`gameData.player.0.actions`]: addPlayerActions
                }
            }
        }

        if( !updateData.active ) {
            await handleGameEnd({multiplayer: updateData.multiplayer}, userData.id, foundGame.amount)

            if( updateData.multiplayer > 1 ) {
                handleWinReport(userData, 'blackjack', foundGame.amount, updateData.multiplayer)
            }

            updateData = {
                ...updateData,
                $unset: {
                    'gameData.shuffledDeck': 1,
                    'gameData.dealerHiddenCard': 1
                }
            }
        } else {
            updateData['gameData.shuffledDeck'] = [...shuffledDeck, newDealerCard]
        }

        const populatedGame = await Game.findByIdAndUpdate(foundGame._id, {...updateData}, {new: true})
            .select('active ownerId amount multiplayer game gameData.dealer gameData.player')
            .lean()

        delete spamCache.noInsurance[userData.id]

        res.status(200).json(populatedGame)
    } catch ( err ) {
        delete spamCache.noInsurance[userData.id]
        console.error( err )
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/action-double', authJwt, moveLimiter, async (req, res) => {
    try {
        const userData = req.userData

        if( spamCache.double[userData.id] === true ) return res.status(400).json({ error: 'stop spam' })
        spamCache.double[userData.id] = true

        const foundGame = await Game.findOne({game: 'blackjack', ownerId: String(userData.id), active: true}).select('amount gameData').lean()
        if(!foundGame) {
            delete spamCache.double[userData.id]
            return res.status(400).json({ error: 'Game not found' })
        }

        const shuffledDeck = foundGame.gameData.shuffledDeck

        const firstPlayerHand = foundGame.gameData.player[0]
        const firstDealerHand = foundGame.gameData.dealer[0]


        let handIndex = 0
        if( foundGame.gameData.player.length === 2 ) {
            const handHasPlayed = firstPlayerHand.actions.some( action => ["bust", "full", "stand", "double"].includes(action) )
            if( handHasPlayed ) handIndex = 1
        }

        const selectedPlayerHand = foundGame.gameData.player[handIndex]

        let canDouble = false

        if( foundGame.gameData.player.length === 2 ) {
            if( selectedPlayerHand.actions[selectedPlayerHand.actions.length-1] === "split" ) {
                //canDouble = true
                canDouble = false
            }
        } else {
            if( ["deal", "insurance", "noInsurance"].includes(selectedPlayerHand.actions[selectedPlayerHand.actions.length-1]) ) {
                canDouble = true
            }
        }

        if ( !canDouble ) {
            delete spamCache.double[userData.id]
            return res.status(400).json({ error: 'Invalid request data' })
        }

        const user = await User.findOne({userId: String(userData.id)}).select('balance').lean()
        if (!user) {
            delete spamCache.double[userData.id]
            return res.status(400).json({ error: 'Unauthorized access' })
        }
        if (Number(foundGame.amount) > user.balance) {
            delete spamCache.double[userData.id]
            return res.status(400).json({ error: 'Insufficient balance' })
        }
    
        const botUser = await User.findOne({casinoBot: true}).select('balance').lean()
        if(!botUser) {
            delete spamCache.double[userData.id]
            return res.status(400).json({ error: 'Bot user not found' })
        }
        if( Number(foundGame.amount) > botUser.balance ) {
            delete spamCache.double[userData.id]
            return res.status(400).json({ error: 'Insufficient house balance' })
        }

        await db["user"].findOneAndUpdate(
            { userId: String(userData.id) },
            { $inc: { balance: -Number(foundGame.amount) } }
        )

        const hitCard = generateBjCard(shuffledDeck)


        let addPlayerActions = [
            ...selectedPlayerHand.actions,
            "double"
        ]
        const newPlayerCards = [
            ...selectedPlayerHand.cards,
            hitCard
        ]

        let updateData = {}
        let resultMultiplier = 0

        const playerValue = calcCardsValue(newPlayerCards)

        if( playerValue > 21 ) {
            resultMultiplier = 0
            addPlayerActions.push("bust")

            updateData = {
                active: false,
                multiplayer: resultMultiplier,
                [`gameData.player.0.value`]: playerValue,
                [`gameData.player.0.cards`]: newPlayerCards,
                [`gameData.player.0.actions`]: addPlayerActions
            }
        } else {
            if( playerValue === 21 ) addPlayerActions.push("full")

            const newDealerResults = playDealerTurns(firstDealerHand.cards, shuffledDeck, foundGame.gameData.dealerHiddenCard)

            let addDealerActions = [
                ...firstDealerHand.actions,
                ...newDealerResults.actions
            ]

            if( newDealerResults.value === playerValue ) {
                resultMultiplier = 2
            } else {
                if( newDealerResults.value > playerValue && newDealerResults.value <= 21 ) {
                    resultMultiplier = 0
                } else {
                    resultMultiplier = 4
                }
            }

            updateData = {
                active: false,
                multiplayer: resultMultiplier,
                [`gameData.player.0.cards`]: newPlayerCards,
                [`gameData.player.0.value`]: playerValue,
                [`gameData.player.0.actions`]: addPlayerActions,
                [`gameData.dealer.0.cards`]: newDealerResults.cards,
                [`gameData.dealer.0.value`]: newDealerResults.value,
                [`gameData.dealer.0.actions`]: addDealerActions
            }
        }


        if( !updateData.active ) {
            await handleGameEnd({multiplayer: updateData.multiplayer}, userData.id, foundGame.amount)

            if( updateData.multiplayer > 1 ) {
                handleWinReport(userData, 'blackjack', foundGame.amount, updateData.multiplayer)
            }

            updateData = {
                ...updateData,
                $unset: {
                    'gameData.shuffledDeck': 1,
                    'gameData.dealerHiddenCard': 1
                }
            }
        } else {
            updateData['gameData.shuffledDeck'] = shuffledDeck
        }

        const populatedGame = await Game.findByIdAndUpdate(foundGame._id, {...updateData}, {new: true})
            .select('active ownerId amount multiplayer game gameData.dealer gameData.player')
            .lean()

        delete spamCache.double[userData.id]

        res.status(200).json(populatedGame)
    } catch ( err ) {
        delete spamCache.double[userData.id]
        console.error( err )
        res.status(500).json({ error: 'Internal server error' })
    }
})


module.exports = router