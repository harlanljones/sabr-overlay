// Fetches StatsAPI / Baseball Savant on behalf of the content script so page CSP never gets in the way.
const API = "https://statsapi.mlb.com/api/";

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type === "api" && typeof msg.path === "string") {
    const res = await fetch(API + msg.path.replace(/^\/+/, ""));
    if (!res.ok) throw new Error(`StatsAPI ${res.status} for ${msg.path}`);
    return res.json();
  }
  if (msg?.type === "savant" && ["batter", "pitcher"].includes(msg.kind)) {
    const url = `https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=${msg.kind}&year=${Number(msg.season)}&csv=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Savant ${res.status}`);
    return res.text();
  }
});
