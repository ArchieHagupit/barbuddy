// XP & Level System — pure constants and math. Extracted from server.js.
// Note: awardXP() stays in server.js because it uses supabase.

const XP_VALUES = {
  MOCK_BAR_FULL_BONUS:      1000,  // flat bonus when exactly 20 questions
  MOCK_BAR_PER_QUESTION:      10,  // per question when partial (< 20)
  COMPLETE_SPEED_DRILL:       40,  // flat per speed drill completion
  HIGH_SCORE_BONUS:           50,  // per question scoring 8.0+ in any mode
  DAILY_LOGIN:                10,  // once per day
  STREAK_BONUS:               25,  // per day of active streak
  FIRST_SUBJECT_COMPLETE:    200,  // one-time per subject
  MASTER_SPACED_REP:          30,  // per question mastered
  COMPLETE_REVIEW_SESSION:    60,  // spaced repetition review session
};

const LEVEL_THRESHOLDS = [
  0, 100, 200, 350, 500, 700, 900, 1150, 1400, 1700,
  2000, 2400, 2800, 3300, 3800, 4400, 5000, 5700, 6400, 7200,
  8000, 9000, 10000, 11200, 12400, 13800, 15200, 16800, 18400, 20200,
  22000, 24200, 26400, 28800, 31200, 33800, 36400, 39200, 42000, 45000,
  48000, 51500, 55000, 58800, 62600, 66600, 70600, 74800, 79000, 83500,
  88000, 93000, 98000, 103500, 109000, 115000, 121000, 127500, 134000, 141000,
  148000, 156000, 164000, 172500, 181000, 190000, 199000, 208500, 218000, 228000,
  238000, 249000, 260000, 271500, 283000, 295000, 307000, 319500, 332000, 345000,
  358500, 372500, 386500, 401000, 415500, 430500, 445500, 461000, 476500, 492500,
  509000, 526000, 543000, 560500, 578000, 596000, 614000, 632500, 651000, 100000000,
];

function getLevelFromXP(xp) {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= LEVEL_THRESHOLDS[i]) return i + 1;
  }
  return 1;
}

function getTitleFromLevel(level) {
  if (level >= 100) return 'Attorney-at-Law';
  if (level >= 91)  return 'Senior Partner';
  if (level >= 71)  return 'Partner';
  if (level >= 51)  return 'Senior Counsel';
  if (level >= 31)  return 'Junior Counsel';
  if (level >= 11)  return 'Associate';
  return 'Law Student';
}

function getXPForNextLevel(currentLevel) {
  return LEVEL_THRESHOLDS[currentLevel] || null;
}

module.exports = {
  XP_VALUES,
  LEVEL_THRESHOLDS,
  getLevelFromXP,
  getTitleFromLevel,
  getXPForNextLevel,
};
