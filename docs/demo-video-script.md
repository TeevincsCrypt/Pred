# PRED demo video script (about 2 min 30 s)

Record at 1920×1080 with Clipchamp or OBS Studio. Upload to YouTube as Unlisted.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:15 | Landing page hero | "Tokenized US stocks trade on Bitget 24/7, but Wall Street is open 6.5 hours. When a stock moves at 3 a.m., nobody explains why. PRED does." |
| 0:15–0:35 | Scroll to "How it works" | "PRED is a set of agents: detect, investigate, hypothesize, verify, predict, learn. When a tokenized stock moves abnormally while the US market is closed, it opens a Ghost Event." |
| 0:35–0:55 | Open PRED Live: connections panel, asset count | "This is live, on real Bitget data. It found 336 tokenized instruments and monitors 219 US stocks every minute. Every data source reports its real status." |
| 0:55–1:35 | A Ghost Event: timeline, hypotheses, evidence | "PRED caught a move before any news. It forms competing explanations (company news, sector, macro, liquidity) and weighs real evidence from SEC filings and news, each with a source and timestamp. The probabilities are model estimates, and it shows why." |
| 1:35–1:55 | Resolution status, then Memory | "At the US open it checks itself: confirmed, invalidated, or honestly unresolved. Every outcome goes into memory to measure accuracy. No invented numbers." |
| 1:55–2:15 | Trade panel: log in, show the plan. Do **not** press Approve & execute. | "Human-approved execution through Bitget’s API is built and tested against a simulated Bitget, and disabled by default. Every order needs explicit human approval, fresh price and balance checks, and cannot be placed twice. Agents cannot trade." |
| 2:15–2:30 | Final pitch-deck slide or landing page | "The market moves first. PRED tells you why. Live on Bitget today." |

Notes

- If you show `/demo`, label it on screen as "Simulated demo".
- Execution stays untested against real Bitget. Describe it only with the sentence above.

## Silent screen recording (optional)

`scripts/record-walkthrough.mjs` records a 1920×1080 silent walkthrough that follows this script. Add your voice in Clipchamp afterwards.

```
npm i -g playwright
npx playwright install chromium
node scripts/record-walkthrough.mjs https://<your-pred>.up.railway.app          # live dashboard
node scripts/record-walkthrough.mjs https://<your-pred>.up.railway.app --demo   # simulated demo (needs PRED_DEMO_ENABLED=true)
```

The video is saved in `recordings/` (as .webm, plus .mp4 if ffmpeg is installed). The recorder only views pages. It never logs in, and never approves or executes a trade.
