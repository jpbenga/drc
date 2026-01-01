const { clamp } = require('./calibration');

function calculateKellyStake(prob, odd, bankroll, fraction = 0.25) {
  const edge = prob * odd - 1;
  const divisor = odd - 1;
  if (divisor <= 0) return 0;
  const stakeRatio = edge / divisor;
  const stake = bankroll * clamp(stakeRatio, 0, 1) * fraction;
  return stake > 0 ? stake : 0;
}

function createRoiTracker({
  initialBankroll = 100,
  strategy = 'flat',
  unitStake = 1,
  kellyFraction = 0.25,
  minOdds = 1.01,
  maxOdds = 200,
} = {}) {
  const state = {
    initialBankroll,
    bankroll: initialBankroll,
    totalStake: 0,
    pnl: 0,
    bets: [],
  };

  function stake(probability, odd) {
    if (!Number.isFinite(probability) || !Number.isFinite(odd)) return 0;
    if (odd < minOdds || odd > maxOdds) return 0;
    if (probability <= 0 || probability >= 1) return 0;
    if (strategy === 'kelly') {
      return calculateKellyStake(probability, odd, state.bankroll, kellyFraction);
    }
    return unitStake;
  }

  function recordBet({ market, selection, probability, odd, outcome, meta = {} }) {
    const wager = stake(probability, odd);
    if (wager <= 0) return null;
    const pnl = outcome ? wager * (odd - 1) : -wager;
    const edge = probability * odd - 1;
    state.totalStake += wager;
    state.pnl += pnl;
    state.bankroll += pnl;
    const bet = {
      market,
      selection,
      probability,
      odd,
      stake: wager,
      pnl,
      edge,
      outcome,
      meta,
    };
    state.bets.push(bet);
    return bet;
  }

  function summary() {
    return {
      bankrollStart: state.initialBankroll,
      bankrollEnd: state.bankroll,
      pnl: state.pnl,
      totalStake: state.totalStake,
      roi: state.totalStake ? state.pnl / state.totalStake : 0,
      totalBets: state.bets.length,
      bets: state.bets,
    };
  }

  return { recordBet, summary, state };
}

module.exports = { createRoiTracker, calculateKellyStake };
