const { bot } = require("./handler")

const handleMessageSend = async (chatId, text, options) => {
    try {
        return await bot.sendMessage(chatId, text, options)
    } catch (err) {
        console.log('Failed to send message:', err.message)
        return null
    }
}


const handleWinReport = async (user, game, amount, multiplier) => {

    const winReportsChannel = -1002223927474

    const gameEnuem = {
        "plinko": {
            emoji: '⚪',
            label: 'Plinko'
        },
        "mines": {
            emoji: '💣',
            label: 'Mines'
        },
        "blackjack": {
            emoji: '🃏',
            label: 'Blackjack'
        }
    }

    const wonAmount = Number(amount) * Number(multiplier)
    const foundGame = gameEnuem[game]
    await handleMessageSend(winReportsChannel, `<b>🎉 ${user?.username ?? user.id} just won ${formatUSD(wonAmount)} (${parseFloat(multiplier).toFixed(2)}×) in ${foundGame.emoji} ${foundGame.label}!</b>`, {
        parse_mode: 'HTML'
    })

}

function formatUSD(amount) {
    let parts = amount.toString().split(".");
    if (parts.length === 1) {
        parts.push("00")
    } else if (parts[1].length === 1) {
        parts[1] += "0"
    } else if (parts[1].length > 2) {
        parts[1] = parts[1].substring(0, 2)
    }

    let formattedNumber = parseFloat(parts.join('.')).toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })

    return formattedNumber;
}


module.exports = {
    handleWinReport,
    formatUSD
}