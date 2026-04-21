# BarBuddy Capacity Planning

Living doc for capacity decisions as user load grows through Bar 2026 review season (roughly May–September 2026).

The goal: avoid discovering we're rate-limited the week students are scrambling to finish their Mock Bar practice before the September 6 exam.

---

## Current stack snapshot (as of this doc being filed)

- **Anthropic API** — Claude Haiku 4.5 for all evals (`claude-haiku-4-5-20251001`)
- **Railway** — hosts Node.js + Express server
- **Supabase** — PostgreSQL + Storage
- **Resend** — transactional email (currently single-recipient via `onboarding@resend.dev`)
- **Internal concurrency caps**:
  - Eval queue: `maxConcurrent: 20` global, `perUserMax: 5`
  - AI semaphore: 20 concurrent calls
  - Rate limiter: 30 evals/minute per IP

---

## Data to gather before making tier/plan decisions

Fill in these values. Then re-run the analysis with real numbers instead of estimates.

### 1. Anthropic API usage

Console: https://console.anthropic.com

- [ ] **Current tier** (1 / 2 / 3 / 4 — or free/build):
- [ ] **Monthly spend cap** ($100 / $500 / $1000 / $5000):
- [ ] **Cumulative spend to date** (tells us how far we are from next tier threshold):

**Last 7 days — Haiku usage (fill in daily if possible, or 7-day totals):**

| Day | Input tokens | Output tokens | Requests | Notes |
|---|---|---|---|---|
| Day 1 | | | | |
| Day 2 | | | | |
| Day 3 | | | | |
| Day 4 | | | | |
| Day 5 | | | | |
| Day 6 | | | | |
| Day 7 | | | | |
| **7-day total** | | | | |

- [ ] **Peak-minute usage**, if the Console shows per-minute charts — screenshot or note the peak moment in the last week:
- [ ] **Any 429 responses (rate-limited) in the last 30 days?** If yes, how many and roughly when:
- [ ] **Any Sonnet usage?** (I think we're Haiku-only but worth confirming):

### 2. Railway hosting

Dashboard: https://railway.app

- [ ] **Current plan**: Hobby ($5/mo) / Pro ($20/mo) / other:
- [ ] **Monthly bill so far this billing cycle**:
- [ ] **Peak CPU %** (last 7 days):
- [ ] **Peak memory usage** (last 7 days):
- [ ] **Peak concurrent HTTP connections**, if visible:
- [ ] **Any 5xx error spikes** in the observability/logs view:

### 3. Supabase

Dashboard: https://supabase.com

- [ ] **Current plan**: Free / Pro:
- [ ] **Database size** (MB/GB):
- [ ] **Bandwidth used this month**:
- [ ] **Peak concurrent connections**:
- [ ] **Any slow queries flagged in the advisor?**:

### 4. Application-layer usage

Can be pulled from Supabase SQL editor or the admin panel:

- [ ] **Total registered users**:
- [ ] **Weekly active users (last 7 days)**:
- [ ] **Mock Bar sessions completed in last 7 days**:
- [ ] **Speed Drill sessions completed in last 7 days**:
- [ ] **Questions currently cached (model_answer_alac populated)** vs total questions:

Handy SQL snippets for Supabase SQL Editor:

```sql
-- Total users
SELECT count(*) FROM users;

-- Active in last 7 days (adjust column name if different)
SELECT count(*) FROM users WHERE last_login_at > now() - interval '7 days';

-- Mock Bar sessions last 7 days
SELECT count(*) FROM results
WHERE created_at > now() - interval '7 days'
  AND session_type IN ('mock_bar', 'speed_drill');

-- Cache hit rate on questions
SELECT
  count(*) FILTER (WHERE model_answer_alac IS NOT NULL) as cached,
  count(*) as total,
  round(100.0 * count(*) FILTER (WHERE model_answer_alac IS NOT NULL) / count(*), 1) as pct
FROM questions;
```

### 5. Target capacity (most important number)

- [ ] **Total takers in UPHSD Bar 2026 batch**:
- [ ] **How many will have BarBuddy access by September?**:
- [ ] **Plan to open to non-UPHSD takers?** (public launch, friends at other schools, etc.):
- [ ] **Expected peak usage moment** — e.g. "the last week before the exam, ~100 students all doing full Mock Bars daily":

---

## Rule-of-thumb reference (Haiku 4.5, April 2026)

From earlier analysis — revisit these when real data is available:

| Anthropic Tier | Cumulative spend | RPM | Haiku ITPM | Concurrent Mock Bar users |
|---|---|---|---|---|
| Free | — | 5 | 25K | ~1 |
| Tier 1 | $5 | 50 | 50K | ~10 |
| Tier 2 | $40 | 1,000 | 100K | ~50 |
| Tier 3 | $200 | 2,000 | 1M | ~200 |
| Tier 4 | $400 | 4,000 | 4M | ~800 |

**Per-session cost estimate** (one 20-question Mock Bar, warm cache):
- ~20–40 Haiku calls
- ~30K–50K input tokens + 15K–30K output tokens
- **~$0.10 – $0.20 per session** at standard Haiku rates

**Monthly cost projections** (one Mock Bar per DAU per day):
- 30 DAU → ~$135/mo
- 100 DAU → ~$450/mo
- 300 DAU → ~$1,350/mo
- 500 DAU → ~$2,250/mo

**Infrastructure layers that can bottleneck first, in typical order:**
1. Anthropic tier (RPM/TPM) — often the binding constraint
2. Our own queue cap (`maxConcurrent: 20`) — often the binding constraint ahead of Anthropic
3. Railway CPU/memory — usually only under sustained heavy load
4. Supabase connections — usually only at very high DAU

---

## Optimization levers we haven't pulled yet

If capacity becomes tight, these give significant breathing room WITHOUT a tier upgrade:

1. **Prompt caching** — Anthropic's prompt cache feature reduces input token costs by 90% and doesn't count cached tokens against ITPM. Our ALAC and conceptual prompt templates are ~2K tokens of fixed instructions + small per-request variable content. Caching the fixed part would effectively 5–10x our ITPM headroom. Implementation: add `cache_control: { type: "ephemeral" }` to the system portion of the prompt. ~1-hour commit.

2. **Batch API** — For non-realtime evaluation (e.g. if we added "queue this Mock Bar for overnight grading"), Anthropic Batch API is 50% cheaper. Not useful for synchronous eval flow but relevant if we add async grading.

3. **Tune internal queue cap** — If Anthropic tier allows more than 20 concurrent calls, we can raise `maxConcurrent` to match. Currently conservative to prevent runaway costs.

4. **Cache warming** — Pre-generate model answers for all questions at quieter times (overnight job). Every cached question = one less Haiku call at peak. Our existing `startAlacBackfill` admin action does this; could run it weekly.

---

## Decision tree

Once data is filled in, use this to pick an action:

| Symptom | Likely binding constraint | Action |
|---|---|---|
| Any recent 429 errors from Anthropic | Hit RPM/TPM on current tier | Bump tier, or implement prompt caching |
| Queue depth > 20 regularly, but no 429 | Our queue cap or model-generation speed | Raise `maxConcurrent`, or speed up Haiku calls |
| Railway CPU sustained > 70% | Node.js saturating shared CPU | Bump Railway plan OR investigate slow routes |
| Supabase connection errors | Connection pool exhausted | Upgrade Supabase, add pgBouncer |
| Monthly spend tracking toward > cap | Usage outgrew tier | Bump tier, or implement prompt caching, or both |
| Everything fine, growth expected | Pre-emptive tier bump before bar review peak | Go Tier 2 or 3 depending on target DAU |

---

## Historical snapshots

Add a dated snapshot here each time we revisit capacity. Useful for tracking growth rates.

### Snapshot YYYY-MM-DD

- [ ] Users: N
- [ ] Weekly active: N
- [ ] 7-day Haiku tokens: N input / N output
- [ ] Anthropic spend last 7 days: $N
- [ ] Anthropic tier: N
- [ ] Railway plan: X
- [ ] Supabase plan: X
- [ ] Decision made: (bump tier / no change / other)

---

## References

- Anthropic rate limits: https://docs.claude.com/en/api/rate-limits
- Anthropic pricing: https://claude.com/pricing
- Anthropic prompt caching: https://docs.claude.com/en/docs/prompt-caching
- Railway pricing: https://railway.app/pricing
- Supabase pricing: https://supabase.com/pricing
