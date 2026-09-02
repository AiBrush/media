const path = process.argv[2] ?? "results/cache-chromium-1788113203817.json";
const j = await Bun.file(path).json();
type E = { key: string; invalidated: boolean; createdAtIso: string; result: any };
const entries: E[] = j.entries;
console.log("entries", entries.length, "invalidated", entries.filter(e=>e.invalidated).length);
// dedupe: key -> latest
const byKey = new Map<string, E>();
for (const e of entries) { if (e.invalidated) continue; const k = e.key; const prev = byKey.get(k); if (!prev || prev.createdAtIso < e.createdAtIso) byKey.set(k, e); }
// base scenario id = scenarioId before '#'
const rows = [...byKey.values()].map(e => { const r = e.result; return { engine: r.engineId, family: r.family ?? r.scenarioId.split('/')[0], scenario: r.scenarioId.split('#')[0], status: r.status, n: r.bench?.wall?.n, warmup: r.bench?.wall?.warmup, median: r.bench?.wall?.median, p95: r.bench?.wall?.p95, mad: r.bench?.wall?.mad, hasBench: !!r.bench, reason: r.reason }; });
// Per engine, latest per (engine, scenario)
const latest = new Map<string, typeof rows[0]>();
for (const r of rows) { latest.set(r.engine+"\0"+r.scenario, r); }
const per = new Map<string, Record<string, number>>();
for (const r of latest.values()) { const m = per.get(r.engine) ?? {}; m[r.status] = (m[r.status]??0)+1; m.total=(m.total??0)+1; per.set(r.engine, m); }
console.log("\n=== status per engine (latest per scenario) ===");
for (const [e, m] of [...per.entries()].sort()) console.log(e.padEnd(28), JSON.stringify(m));
// sample count distribution for aibrush
const ab = [...latest.values()].filter(r => r.engine.startsWith("aibrush") && r.hasBench);
const nDist: Record<string, number> = {};
for (const r of ab) nDist[String(r.n)] = (nDist[String(r.n)]??0)+1;
console.log("\n=== aibrush bench sample-count (n) distribution ===", JSON.stringify(nDist));
const wDist: Record<string, number> = {};
for (const r of ab) wDist[String(r.warmup)] = (wDist[String(r.warmup)]??0)+1;
console.log("=== aibrush warmup distribution ===", JSON.stringify(wDist));
// FAIL / NA_ENGINE list for aibrush
console.log("\n=== aibrush non-PASS ===");
for (const r of [...latest.values()].filter(r => r.engine.startsWith("aibrush") && r.status !== "PASS").sort((a,b)=>a.scenario.localeCompare(b.scenario))) console.log(r.status.padEnd(10), r.scenario.padEnd(60), String(r.reason??'').slice(0,110));
// Win/lose: per scenario, among PASS with bench median, fastest; aibrush wins if within 5% of fastest
const byScen = new Map<string, typeof rows>();
for (const r of latest.values()) { if (r.status!=="PASS" || r.median===undefined) continue; const a = byScen.get(r.scenario) ?? []; a.push(r); byScen.set(r.scenario, a); }
let win=0, lose=0, solo=0; const loseBy: Record<string, number> = {}; const famStat: Record<string, {win:number,lose:number,solo:number}> = {};
const loseRows: {scenario:string, ab:number, best:number, winner:string, ratio:number}[] = [];
for (const [s, rs] of byScen) { const ab = rs.find(r=>r.engine.startsWith("aibrush")); if (!ab) continue; const others = rs.filter(r=>!r.engine.startsWith("aibrush")); const fam = ab.family; famStat[fam] ??= {win:0,lose:0,solo:0}; if (others.length===0) { solo++; famStat[fam].solo++; continue; } const best = others.reduce((m,r)=> r.median! < m.median! ? r : m); if (ab.median! <= best.median! * 1.05) { win++; famStat[fam].win++; } else { lose++; famStat[fam].lose++; loseBy[best.engine]=(loseBy[best.engine]??0)+1; loseRows.push({scenario:s, ab:ab.median!, best:best.median!, winner:best.engine, ratio: ab.median!/best.median!}); } }
console.log("\n=== aibrush win/lose (PASS-only, median wall, 5% band, vs fastest other PASS engine) ===");
console.log({win, lose, solo});
console.log("lose by winner:", JSON.stringify(loseBy));
console.log("\n=== per family ===");
for (const [f, s] of Object.entries(famStat).sort()) console.log(f.padEnd(18), JSON.stringify(s));
console.log("\n=== worst 40 loses by ratio ===");
for (const r of loseRows.sort((a,b)=>b.ratio-a.ratio).slice(0,40)) console.log(r.ratio.toFixed(2).padStart(7)+"x", r.scenario.padEnd(58), `ab=${r.ab.toFixed(1)}ms best=${r.best.toFixed(1)}ms (${r.winner})`);
// geomean of ratio over all compared rows
const ratios = [...byScen.values()].map(rs => { const ab = rs.find(r=>r.engine.startsWith("aibrush")); const others = rs.filter(r=>!r.engine.startsWith("aibrush")); if (!ab || !others.length) return undefined; const best = Math.min(...others.map(r=>r.median!)); return ab.median!/best; }).filter((x): x is number => x!==undefined && x>0);
const gm = Math.exp(ratios.reduce((a,b)=>a+Math.log(b),0)/ratios.length);
console.log("\n=== geomean(aibrush median / best-other median) over", ratios.length, "rows:", gm.toFixed(3), " (<1 = faster)");
const within5 = ratios.filter(r=>r<=1.05).length; console.log("within 5% of fastest:", within5, "/", ratios.length, "=", (100*within5/ratios.length).toFixed(1)+"%");
console.log("\n=== ALL loses grouped by family ===");
const byFam: Record<string, typeof loseRows> = {};
for (const r of loseRows) { const fam = r.scenario.split('/')[0]; (byFam[fam] ??= []).push(r); }
for (const [fam, rs] of Object.entries(byFam).sort()) { console.log(`\n--- ${fam} (${rs.length}) ---`); for (const r of rs.sort((a,b)=>b.ratio-a.ratio)) console.log(r.ratio.toFixed(2).padStart(7)+"x", r.scenario.padEnd(58), `ab=${r.ab.toFixed(1)}ms best=${r.best.toFixed(1)}ms (${r.winner.split('@')[0]})`); }
// rows where the winner's median < 1ms (timer-floor rows)
const tiny = loseRows.filter(r => r.best < 1).length; console.log("\nloses where winner median < 1ms:", tiny, "of", loseRows.length);
const tiny2 = loseRows.filter(r => r.best < 2).length; console.log("loses where winner median < 2ms:", tiny2);
